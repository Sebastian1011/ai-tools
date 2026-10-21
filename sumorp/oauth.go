package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
)

var errReauthorize = errors.New("reauthorization required; run authorize")
var resourceMetadataPattern = regexp.MustCompile(`(?i)resource_metadata="([^"]+)"`)

type tokenManager struct {
	mu            sync.Mutex
	c             config
	http          *http.Client
	s             credentials
	tokenEndpoint string
	challenged    bool
	reauthorize   bool
}

type resourceMetadata struct {
	Resource             string   `json:"resource"`
	AuthorizationServers []string `json:"authorization_servers"`
}
type authMetadata struct {
	Issuer                            string   `json:"issuer"`
	AuthorizationEndpoint             string   `json:"authorization_endpoint"`
	TokenEndpoint                     string   `json:"token_endpoint"`
	RegistrationEndpoint              string   `json:"registration_endpoint"`
	CodeChallengeMethodsSupported     []string `json:"code_challenge_methods_supported"`
	TokenEndpointAuthMethodsSupported []string `json:"token_endpoint_auth_methods_supported"`
}
type tokenResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int64  `json:"expires_in"`
	TokenType    string `json:"token_type"`
	Error        string `json:"error"`
}

func newTokenManager(c config, client *http.Client) (*tokenManager, error) {
	s, err := readStore(c.Store, c.UpstreamURL)
	if err != nil {
		return nil, err
	}
	if client == nil {
		client = &http.Client{Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	}
	return &tokenManager{c: c, http: client, s: s}, nil
}

func randomString() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func metadataURL(u *url.URL, prefix string) string {
	v := *u
	v.Path = prefix + strings.TrimSuffix(u.Path, "/")
	v.RawPath = ""
	v.RawQuery = ""
	return v.String()
}

func (m *tokenManager) getJSON(ctx context.Context, endpoint string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return err
	}
	resp, err := m.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("metadata HTTP %d", resp.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(out)
}

func (m *tokenManager) discover(ctx context.Context) (resourceMetadata, authMetadata, error) {
	var r resourceMetadata
	var a authMetadata
	var last error
	endpoints := []string{}
	probe, err := http.NewRequestWithContext(ctx, http.MethodGet, m.c.UpstreamURL, nil)
	if err != nil {
		return r, a, err
	}
	probe.Header.Set("Accept", "application/json, text/event-stream")
	if response, err := m.http.Do(probe); err == nil {
		if response.StatusCode == http.StatusUnauthorized {
			for _, challenge := range response.Header.Values("WWW-Authenticate") {
				if match := resourceMetadataPattern.FindStringSubmatch(challenge); len(match) == 2 {
					if metadata, err := url.Parse(match[1]); err == nil && metadata.Scheme == m.c.upstream.Scheme && metadata.Host != "" {
						endpoints = append(endpoints, metadata.String())
					}
				}
			}
		}
		response.Body.Close()
	}
	endpoints = append(endpoints, metadataURL(m.c.upstream, "/.well-known/oauth-protected-resource"), m.c.upstream.Scheme+"://"+m.c.upstream.Host+"/.well-known/oauth-protected-resource")
	for _, endpoint := range endpoints {
		r = resourceMetadata{}
		if last = m.getJSON(ctx, endpoint, &r); last == nil {
			break
		}
	}
	if last != nil {
		return r, a, fmt.Errorf("protected resource discovery: %w", last)
	}
	if len(r.AuthorizationServers) == 0 {
		return r, a, errors.New("resource metadata has no authorization server")
	}
	issuer, err := url.Parse(r.AuthorizationServers[0])
	if err != nil || issuer.Scheme != m.c.upstream.Scheme || issuer.Host == "" {
		return r, a, errors.New("invalid authorization server URL")
	}
	issuerPath := strings.TrimSuffix(issuer.EscapedPath(), "/")
	base := issuer.Scheme + "://" + issuer.Host
	endpoints = []string{base + "/.well-known/oauth-authorization-server" + issuerPath, base + "/.well-known/openid-configuration" + issuerPath}
	if issuerPath != "" {
		endpoints = append(endpoints, base+issuerPath+"/.well-known/openid-configuration")
	}
	for _, endpoint := range endpoints {
		a = authMetadata{}
		if last = m.getJSON(ctx, endpoint, &a); last == nil {
			break
		}
	}
	if last != nil {
		return r, a, fmt.Errorf("authorization server discovery: %w", last)
	}
	if a.Issuer != strings.TrimSuffix(r.AuthorizationServers[0], "/") || a.AuthorizationEndpoint == "" || a.TokenEndpoint == "" {
		return r, a, errors.New("authorization server metadata is incomplete or issuer differs")
	}
	for _, endpoint := range []string{a.AuthorizationEndpoint, a.TokenEndpoint, a.RegistrationEndpoint} {
		if endpoint == "" {
			continue
		}
		u, err := url.Parse(endpoint)
		if err != nil || u.Scheme != issuer.Scheme || u.Host == "" {
			return r, a, errors.New("invalid authorization endpoint")
		}
	}
	return r, a, nil
}

func (m *tokenManager) register(ctx context.Context, endpoint, resource string) (credentials, error) {
	var s credentials
	if endpoint == "" {
		return s, errors.New("authorization server does not support dynamic registration; set oauth.client_id")
	}
	registration := map[string]any{"client_name": "sumorp", "redirect_uris": []string{m.c.redirectURI()}, "grant_types": []string{"authorization_code", "refresh_token"}, "response_types": []string{"code"}, "token_endpoint_auth_method": "none", "scope": strings.Join(m.c.OAuth.Scopes, " ")}
	if resource != "" {
		registration["resource"] = resource
	}
	b, _ := json.Marshal(registration)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(string(b)))
	if err != nil {
		return s, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	resp, err := m.http.Do(req)
	if err != nil {
		return s, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 && resp.StatusCode != 201 {
		return s, fmt.Errorf("registration HTTP %d", resp.StatusCode)
	}
	var reg struct {
		ClientID     string `json:"client_id"`
		ClientSecret string `json:"client_secret"`
		AuthMethod   string `json:"token_endpoint_auth_method"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&reg); err != nil {
		return s, err
	}
	if reg.ClientID == "" {
		return s, errors.New("registration response lacks client_id")
	}
	if reg.AuthMethod == "" {
		if reg.ClientSecret != "" {
			reg.AuthMethod = "client_secret_basic"
		} else {
			reg.AuthMethod = "none"
		}
	}
	if reg.AuthMethod != "none" && reg.AuthMethod != "client_secret_basic" && reg.AuthMethod != "client_secret_post" {
		return s, errors.New("unsupported token endpoint authentication method")
	}
	s.ClientID, s.ClientSecret, s.AuthMethod = reg.ClientID, reg.ClientSecret, reg.AuthMethod
	return s, nil
}

func (m *tokenManager) tokenRequest(ctx context.Context, endpoint string, s credentials, values url.Values) (tokenResponse, error) {
	var t tokenResponse
	secret := s.ClientSecret
	if m.c.OAuth.ClientID != "" && s.ClientID == m.c.OAuth.ClientID {
		secret = m.c.clientSecret()
	}
	values.Set("client_id", s.ClientID)
	if secret != "" && s.AuthMethod == "client_secret_post" {
		values.Set("client_secret", secret)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(values.Encode()))
	if err != nil {
		return t, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	if secret != "" && s.AuthMethod != "client_secret_post" {
		req.SetBasicAuth(s.ClientID, secret)
	}
	resp, err := m.http.Do(req)
	if err != nil {
		return t, err
	}
	defer resp.Body.Close()
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&t); err != nil {
		return t, err
	}
	if resp.StatusCode != 200 {
		if t.Error == "invalid_grant" {
			return t, errReauthorize
		}
		return t, fmt.Errorf("token HTTP %d: %s", resp.StatusCode, t.Error)
	}
	if t.AccessToken == "" || !strings.EqualFold(t.TokenType, "Bearer") || t.ExpiresIn <= 0 {
		return t, errors.New("invalid token response")
	}
	return t, nil
}

func (m *tokenManager) applyTokenLocked(t tokenResponse, s credentials) error {
	s.AccessToken = t.AccessToken
	if t.RefreshToken != "" {
		s.RefreshToken = t.RefreshToken
	}
	s.ExpiresAt = time.Now().Add(time.Duration(t.ExpiresIn) * time.Second)
	if err := writeStore(m.c.Store, s); err != nil {
		m.reauthorize = true
		return fmt.Errorf("credential persistence failed; %w: %v", errReauthorize, err)
	}
	m.s = s
	return nil
}

func (m *tokenManager) markReauthorizeLocked() {
	m.reauthorize = true
	m.s.AccessToken = ""
	m.s.RefreshToken = ""
	_ = writeStore(m.c.Store, m.s)
}

func (m *tokenManager) refreshLocked(ctx context.Context) error {
	if m.s.RefreshToken == "" {
		m.markReauthorizeLocked()
		return errReauthorize
	}
	endpoint := m.tokenEndpoint
	if endpoint == "" {
		_, a, err := m.discover(ctx)
		if err != nil {
			return err
		}
		if a.Issuer != m.s.Issuer {
			m.markReauthorizeLocked()
			return errReauthorize
		}
		endpoint = a.TokenEndpoint
		m.tokenEndpoint = endpoint
	}
	v := url.Values{"grant_type": {"refresh_token"}, "refresh_token": {m.s.RefreshToken}}
	if m.s.Resource != "" {
		v.Set("resource", m.s.Resource)
	}
	t, err := m.tokenRequest(ctx, endpoint, m.s, v)
	if errors.Is(err, errReauthorize) {
		m.markReauthorizeLocked()
	}
	if err != nil {
		return err
	}
	return m.applyTokenLocked(t, m.s)
}

func (m *tokenManager) accessToken(ctx context.Context) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.reauthorize || m.s.AccessToken == "" {
		return "", errReauthorize
	}
	if time.Until(m.s.ExpiresAt) <= m.c.refreshBefore {
		if err := m.refreshLocked(ctx); err != nil {
			return "", err
		}
	}
	return m.s.AccessToken, nil
}

func (m *tokenManager) onUnauthorized(ctx context.Context, token string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.reauthorize {
		return errReauthorize
	}
	if token != m.s.AccessToken {
		return nil
	}
	if m.challenged {
		m.markReauthorizeLocked()
		return errReauthorize
	}
	m.challenged = true
	return m.refreshLocked(ctx)
}

func (m *tokenManager) onSuccess(token string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if token == m.s.AccessToken {
		m.challenged = false
	}
}

func (m *tokenManager) authorize(ctx context.Context, output io.Writer) error {
	r, a, err := m.discover(ctx)
	if err != nil {
		return err
	}
	methodOK := false
	for _, method := range a.CodeChallengeMethodsSupported {
		if method == "S256" {
			methodOK = true
		}
	}
	if !methodOK {
		return errors.New("authorization server does not advertise PKCE S256")
	}
	m.mu.Lock()
	s := m.s
	m.mu.Unlock()
	if s.Issuer != a.Issuer || s.ClientID == "" || (m.c.OAuth.ClientID != "" && s.ClientID != m.c.OAuth.ClientID) {
		if m.c.OAuth.ClientID != "" {
			s = credentials{ClientID: m.c.OAuth.ClientID, AuthMethod: "none"}
			if m.c.clientSecret() != "" {
				s.AuthMethod = "client_secret_basic"
			}
		} else {
			s, err = m.register(ctx, a.RegistrationEndpoint, r.Resource)
			if err != nil {
				return err
			}
		}
	}
	if m.c.OAuth.ClientID != "" {
		s.ClientSecret = ""
		s.AuthMethod = "none"
		if m.c.clientSecret() != "" {
			s.AuthMethod = "client_secret_basic"
			if len(a.TokenEndpointAuthMethodsSupported) > 0 {
				s.AuthMethod = ""
				for _, method := range a.TokenEndpointAuthMethodsSupported {
					if method == "client_secret_basic" {
						s.AuthMethod = method
						break
					}
				}
				if s.AuthMethod == "" {
					for _, method := range a.TokenEndpointAuthMethodsSupported {
						if method == "client_secret_post" {
							s.AuthMethod = method
							break
						}
					}
				}
				if s.AuthMethod == "" {
					return errors.New("authorization server supports no configured client-secret authentication method")
				}
			}
		}
	}
	s.Upstream, s.Issuer, s.Resource = m.c.UpstreamURL, a.Issuer, r.Resource
	if err := writeStore(m.c.Store, s); err != nil {
		return err
	}
	state, err := randomString()
	if err != nil {
		return err
	}
	verifier, err := randomString()
	if err != nil {
		return err
	}
	challenge := sha256.Sum256([]byte(verifier))
	u, _ := url.Parse(a.AuthorizationEndpoint)
	q := u.Query()
	q.Set("response_type", "code")
	q.Set("client_id", s.ClientID)
	q.Set("redirect_uri", m.c.redirectURI())
	q.Set("scope", strings.Join(m.c.OAuth.Scopes, " "))
	q.Set("state", state)
	q.Set("code_challenge", base64.RawURLEncoding.EncodeToString(challenge[:]))
	q.Set("code_challenge_method", "S256")
	if r.Resource != "" {
		q.Set("resource", r.Resource)
	}
	u.RawQuery = q.Encode()
	result := make(chan error, 1)
	server := &http.Server{Addr: m.c.Listen, ReadHeaderTimeout: 5 * time.Second}
	mux := http.NewServeMux()
	mux.HandleFunc("/oauth/callback", func(w http.ResponseWriter, req *http.Request) {
		if req.Method != http.MethodGet || !localRequest(req) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		if req.URL.Query().Get("state") != state {
			http.Error(w, "invalid state", http.StatusBadRequest)
			return
		}
		if req.URL.Query().Get("error") != "" {
			http.Error(w, "authorization failed", http.StatusBadRequest)
			select {
			case result <- errors.New("authorization denied"):
			default:
			}
			return
		}
		code := req.URL.Query().Get("code")
		if code == "" {
			http.Error(w, "missing code", http.StatusBadRequest)
			return
		}
		v := url.Values{"grant_type": {"authorization_code"}, "code": {code}, "redirect_uri": {m.c.redirectURI()}, "code_verifier": {verifier}}
		if r.Resource != "" {
			v.Set("resource", r.Resource)
		}
		t, err := m.tokenRequest(req.Context(), a.TokenEndpoint, s, v)
		if err == nil {
			m.mu.Lock()
			err = m.applyTokenLocked(t, s)
			m.reauthorize = err != nil
			m.challenged = false
			m.mu.Unlock()
		}
		if err != nil {
			http.Error(w, "authorization failed; check terminal", http.StatusBadGateway)
		} else {
			w.Write([]byte("Authorization complete. You may close this tab.\n"))
		}
		select {
		case result <- err:
		default:
		}
	})
	server.Handler = mux
	listener, err := netListen(server.Addr)
	if err != nil {
		return err
	}
	defer listener.Close()
	go server.Serve(listener)
	defer server.Shutdown(context.Background())
	fmt.Fprintf(output, "Open this URL in your host browser:\n%s\n", u.String())
	select {
	case err := <-result:
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Keep the listener setup in one place so tests can inject an ephemeral port.
var netListen = func(addr string) (net.Listener, error) { return net.Listen("tcp", addr) }
