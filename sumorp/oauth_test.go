package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func testOAuth(t *testing.T) (config, *httptest.Server, *atomic.Int32) {
	t.Helper()
	refreshes := &atomic.Int32{}
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/.well-known/oauth-protected-resource/mcp":
			json.NewEncoder(w).Encode(resourceMetadata{Resource: server.URL + "/mcp", AuthorizationServers: []string{server.URL}})
		case "/.well-known/oauth-authorization-server":
			json.NewEncoder(w).Encode(authMetadata{Issuer: server.URL, AuthorizationEndpoint: server.URL + "/authorize", TokenEndpoint: server.URL + "/token", RegistrationEndpoint: server.URL + "/register", CodeChallengeMethodsSupported: []string{"S256"}})
		case "/register":
			var registration map[string]any
			if err := json.NewDecoder(r.Body).Decode(&registration); err != nil {
				t.Errorf("registration JSON: %v", err)
			}
			if registration["scope"] != "read:me offline_access" || registration["resource"] != server.URL+"/mcp" || registration["application_type"] != "native" {
				t.Errorf("registration metadata: %v", registration)
			}
			json.NewEncoder(w).Encode(map[string]string{"client_id": "dcr-client", "client_secret": "unused-public-client-secret", "token_endpoint_auth_method": "none"})
		case "/token":
			r.ParseForm()
			if r.Form.Get("client_id") == "dcr-client" && (r.Header.Get("Authorization") != "" || r.Form.Get("client_secret") != "") {
				w.WriteHeader(401)
				json.NewEncoder(w).Encode(map[string]string{"error": "invalid_client"})
				return
			}
			if r.Form.Get("client_id") == "pre-registered" && os.Getenv("TEST_PRE_SECRET") != "" {
				user, password, ok := r.BasicAuth()
				if !ok || user != "pre-registered" || password != os.Getenv("TEST_PRE_SECRET") {
					w.WriteHeader(401)
					json.NewEncoder(w).Encode(map[string]string{"error": "invalid_client"})
					return
				}
			}
			if r.Form.Get("grant_type") == "refresh_token" {
				n := refreshes.Add(1)
				if r.Form.Get("refresh_token") != fmt.Sprintf("R%d", n) {
					w.WriteHeader(400)
					json.NewEncoder(w).Encode(map[string]string{"error": "invalid_grant"})
					return
				}
				json.NewEncoder(w).Encode(tokenResponse{AccessToken: fmt.Sprintf("A%d", n+1), RefreshToken: fmt.Sprintf("R%d", n+1), ExpiresIn: 3600, TokenType: "Bearer"})
				return
			}
			if r.Form.Get("grant_type") != "authorization_code" || len(r.Form.Get("code_verifier")) < 43 || r.Form.Get("redirect_uri") != "http://127.0.0.1:8765/oauth/callback" {
				w.WriteHeader(400)
				json.NewEncoder(w).Encode(map[string]string{"error": "invalid_request"})
				return
			}
			json.NewEncoder(w).Encode(tokenResponse{AccessToken: "A1", RefreshToken: "R1", ExpiresIn: 3600, TokenType: "Bearer"})
		default:
			http.NotFound(w, r)
		}
	}))
	u, _ := url.Parse(server.URL + "/mcp")
	c := config{UpstreamURL: u.String(), upstream: u, Listen: "127.0.0.1:8765", Store: filepath.Join(t.TempDir(), "oauth.json"), refreshBefore: 5 * time.Minute}
	c.OAuth.Scopes = []string{"read:me", "offline_access"}
	t.Cleanup(server.Close)
	return c, server, refreshes
}

func TestDiscoveryRegistrationAndPKCE(t *testing.T) {
	c, _, _ := testOAuth(t)
	m, _ := newTokenManager(c, nil)
	r, a, err := m.discover(context.Background())
	if err != nil || r.Resource != c.UpstreamURL || a.TokenEndpoint == "" {
		t.Fatalf("discovery: %+v %+v %v", r, a, err)
	}
	s, err := m.register(context.Background(), a.RegistrationEndpoint, r.Resource)
	if err != nil || s.ClientID != "dcr-client" {
		t.Fatalf("registration: %+v %v", s, err)
	}
	verifier, _ := randomString()
	if len(verifier) < 43 {
		t.Fatalf("short PKCE verifier")
	}
	// A preregistered client bypasses registration in authorize; the callback flow is exercised below.
}

func TestDiscoveryUsesResourceChallenge(t *testing.T) {
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/mcp":
			w.Header().Set("WWW-Authenticate", `Bearer resource_metadata="`+server.URL+`/custom-metadata"`)
			w.WriteHeader(401)
		case "/custom-metadata":
			json.NewEncoder(w).Encode(resourceMetadata{Resource: server.URL + "/mcp", AuthorizationServers: []string{server.URL}})
		case "/.well-known/oauth-authorization-server":
			json.NewEncoder(w).Encode(authMetadata{Issuer: server.URL, AuthorizationEndpoint: server.URL + "/authorize", TokenEndpoint: server.URL + "/token"})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	u, _ := url.Parse(server.URL + "/mcp")
	c := config{UpstreamURL: u.String(), upstream: u, Store: t.TempDir() + "/oauth.json"}
	m, _ := newTokenManager(c, nil)
	r, _, err := m.discover(context.Background())
	if err != nil || r.Resource != c.UpstreamURL {
		t.Fatalf("challenge discovery: %+v %v", r, err)
	}
}

type channelWriter chan string

func (w channelWriter) Write(p []byte) (int, error) { w <- string(p); return len(p), nil }

func TestAuthorizePreregisteredCallbackPKCE(t *testing.T) {
	c, _, _ := testOAuth(t)
	t.Setenv("TEST_PRE_SECRET", "test-only-secret")
	c.OAuth.ClientID = "pre-registered"
	c.OAuth.ClientSecretEnv = "TEST_PRE_SECRET"
	m, _ := newTokenManager(c, nil)
	listenerAddr := make(chan string, 1)
	oldListen := netListen
	netListen = func(string) (net.Listener, error) {
		l, err := net.Listen("tcp", "127.0.0.1:0")
		if err == nil {
			listenerAddr <- l.Addr().String()
		}
		return l, err
	}
	defer func() { netListen = oldListen }()
	printed := make(channelWriter, 1)
	done := make(chan error, 1)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	go func() { done <- m.authorize(ctx, printed) }()
	var addr string
	select {
	case addr = <-listenerAddr:
	case err := <-done:
		t.Fatalf("authorize before listen: %v", err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	var output string
	select {
	case output = <-printed:
	case err := <-done:
		t.Fatalf("authorize before URL: %v", err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	lines := strings.Split(output, "\n")
	authURL, err := url.Parse(lines[1])
	if err != nil {
		t.Fatal(err)
	}
	q := authURL.Query()
	if q.Get("client_id") != "pre-registered" || q.Get("code_challenge_method") != "S256" || q.Get("code_challenge") == "" || q.Get("resource") != c.UpstreamURL || q.Get("scope") != "read:me offline_access" || q.Get("prompt") != "consent" {
		t.Fatalf("authorization query: %v", q)
	}
	req, _ := http.NewRequest("GET", "http://"+addr+"/oauth/callback?state="+url.QueryEscape(q.Get("state"))+"&code=mock", nil)
	req.Host = "127.0.0.1:8765"
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("callback status: %d", resp.StatusCode)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	s, err := readStore(c.Store, c.UpstreamURL)
	if err != nil || s.ClientID != "pre-registered" || s.RefreshToken != "R1" || s.ClientSecret != "" {
		t.Fatalf("stored grant: %+v %v", s, err)
	}
}

func TestDCRGrantSurvivesRestartAndRefreshRotation(t *testing.T) {
	c, _, refreshes := testOAuth(t)
	m, err := newTokenManager(c, nil)
	if err != nil {
		t.Fatal(err)
	}
	listenerAddr := make(chan string, 1)
	oldListen := netListen
	netListen = func(string) (net.Listener, error) {
		l, err := net.Listen("tcp", "127.0.0.1:0")
		if err == nil {
			listenerAddr <- l.Addr().String()
		}
		return l, err
	}
	defer func() { netListen = oldListen }()
	printed := make(channelWriter, 1)
	done := make(chan error, 1)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	go func() { done <- m.authorize(ctx, printed) }()
	var addr, output string
	select {
	case addr = <-listenerAddr:
	case err := <-done:
		t.Fatalf("authorize before listen: %v", err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	select {
	case output = <-printed:
	case err := <-done:
		t.Fatalf("authorize before URL: %v", err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	authURL, err := url.Parse(strings.Split(output, "\n")[1])
	if err != nil {
		t.Fatal(err)
	}
	callback := "http://" + addr + "/oauth/callback?state=" + url.QueryEscape(authURL.Query().Get("state")) + "&code=mock"
	req, _ := http.NewRequest(http.MethodGet, callback, nil)
	req.Host = "127.0.0.1:8765"
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("callback status: %d", resp.StatusCode)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	s, err := readStore(c.Store, c.UpstreamURL)
	if err != nil || s.ClientID != "dcr-client" || s.AccessToken != "A1" || s.RefreshToken != "R1" {
		t.Fatalf("stored DCR grant: %+v %v", s, err)
	}
	for _, want := range []string{"A2", "A3"} {
		s.ExpiresAt = time.Now()
		if err := writeStore(c.Store, s); err != nil {
			t.Fatal(err)
		}
		restarted, err := newTokenManager(c, nil)
		if err != nil {
			t.Fatal(err)
		}
		token, err := restarted.accessToken(context.Background())
		if err != nil || token != want {
			t.Fatalf("token after restart=%q want=%q err=%v", token, want, err)
		}
		s, err = readStore(c.Store, c.UpstreamURL)
		if err != nil || s.AccessToken != want {
			t.Fatalf("stored rotated token: %+v %v", s, err)
		}
	}
	if refreshes.Load() != 2 || s.RefreshToken != "R3" {
		t.Fatalf("refreshes=%d stored refresh token=%q", refreshes.Load(), s.RefreshToken)
	}
}

func TestAuthorizeReplacesUnprovenLegacyRegistration(t *testing.T) {
	c, server, _ := testOAuth(t)
	old := credentials{Upstream: c.UpstreamURL, Issuer: server.URL, ClientID: "old-client"}
	if err := writeStore(c.Store, old); err != nil {
		t.Fatal(err)
	}
	m, err := newTokenManager(c, nil)
	if err != nil {
		t.Fatal(err)
	}
	oldListen := netListen
	netListen = func(string) (net.Listener, error) { return net.Listen("tcp", "127.0.0.1:0") }
	defer func() { netListen = oldListen }()
	printed := make(channelWriter, 1)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- m.authorize(ctx, printed) }()
	select {
	case <-printed:
	case err := <-done:
		t.Fatalf("authorize before URL: %v", err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	cancel()
	<-done
	s, err := readStore(c.Store, c.UpstreamURL)
	if err != nil || s.ClientID != "dcr-client" || s.ApplicationType != "native" {
		t.Fatalf("new registration: %+v %v", s, err)
	}
}

func TestRefreshConcurrentAndRotation(t *testing.T) {
	c, _, refreshes := testOAuth(t)
	m, _ := newTokenManager(c, nil)
	m.s = credentials{Upstream: c.UpstreamURL, Issuer: strings.TrimSuffix(c.UpstreamURL, "/mcp"), Resource: c.UpstreamURL, ClientID: "client", AccessToken: "A1", RefreshToken: "R1", ExpiresAt: time.Now().Add(time.Minute)}
	if err := writeStore(c.Store, m.s); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for range 10 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			token, err := m.accessToken(context.Background())
			if err != nil || token != "A2" {
				t.Errorf("token=%q err=%v", token, err)
			}
		}()
	}
	wg.Wait()
	if refreshes.Load() != 1 {
		t.Fatalf("refreshes=%d", refreshes.Load())
	}
	s, err := readStore(c.Store, c.UpstreamURL)
	if err != nil || s.RefreshToken != "R2" || s.AccessToken != "A2" {
		t.Fatalf("stored=%+v err=%v", s, err)
	}
	m.mu.Lock()
	m.s.ExpiresAt = time.Now()
	m.mu.Unlock()
	if token, err := m.accessToken(context.Background()); err != nil || token != "A3" {
		t.Fatalf("second refresh: %q %v", token, err)
	}
	if refreshes.Load() != 2 {
		t.Fatalf("refreshes=%d", refreshes.Load())
	}
}

func TestInvalidGrantAndPersistenceFailure(t *testing.T) {
	c, _, _ := testOAuth(t)
	m, _ := newTokenManager(c, nil)
	m.s = credentials{Upstream: c.UpstreamURL, Issuer: strings.TrimSuffix(c.UpstreamURL, "/mcp"), ClientID: "client", AccessToken: "A1", RefreshToken: "wrong", ExpiresAt: time.Now()}
	if _, err := m.accessToken(context.Background()); err != errReauthorize {
		t.Fatalf("invalid grant: %v", err)
	}
	if _, err := m.accessToken(context.Background()); err != errReauthorize {
		t.Fatalf("still usable: %v", err)
	}
	c2, _, _ := testOAuth(t)
	c2.Store = filepath.Join(t.TempDir(), "missing", "oauth.json")
	m2, _ := newTokenManager(c2, nil)
	m2.s = credentials{Upstream: c2.UpstreamURL, Issuer: strings.TrimSuffix(c2.UpstreamURL, "/mcp"), ClientID: "client", AccessToken: "A1", RefreshToken: "R1", ExpiresAt: time.Now()}
	// A directory at the target path makes atomic rename fail, even as root.
	if err := os.MkdirAll(c2.Store, 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := m2.accessToken(context.Background()); err == nil {
		t.Fatal("expected persistence failure")
	}
	if _, err := m2.accessToken(context.Background()); err != errReauthorize {
		t.Fatalf("token was released after write failure: %v", err)
	}
}
