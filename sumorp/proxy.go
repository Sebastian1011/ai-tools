package main

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type proxy struct {
	c      config
	m      *tokenManager
	client *http.Client
}

func newProxy(c config, m *tokenManager) *proxy {
	return &proxy{c: c, m: m, client: &http.Client{Transport: &http.Transport{Proxy: http.ProxyFromEnvironment, MaxIdleConns: 100, IdleConnTimeout: 90 * time.Second, ForceAttemptHTTP2: true, DisableCompression: true}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}

func localRequest(r *http.Request) bool {
	host, port, err := net.SplitHostPort(r.Host)
	if err != nil || port != "8765" {
		return false
	}
	if host != "127.0.0.1" && host != "localhost" && host != "::1" {
		return false
	}
	if origin := r.Header.Get("Origin"); origin != "" {
		u, err := url.Parse(origin)
		if err != nil || u.Scheme != "http" || u.Host != r.Host || u.User != nil || u.Path != "" || u.RawQuery != "" {
			return false
		}
	}
	return true
}

func stripHopByHop(h http.Header) {
	for _, name := range strings.Split(h.Get("Connection"), ",") {
		h.Del(strings.TrimSpace(name))
	}
	for _, name := range []string{"Connection", "Proxy-Connection", "Keep-Alive", "Proxy-Authenticate", "Proxy-Authorization", "Te", "Trailer", "Transfer-Encoding", "Upgrade"} {
		h.Del(name)
	}
}

func (p *proxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	status, category := p.serve(w, r)
	slog.Info("request", "method", r.Method, "status", status, "duration_ms", time.Since(start).Milliseconds(), "error_category", category)
}

func (p *proxy) serve(w http.ResponseWriter, r *http.Request) (int, string) {
	if !localRequest(r) {
		http.Error(w, "invalid local host or origin", http.StatusForbidden)
		return 403, "local_origin"
	}
	if r.URL.Path == "/healthz" && r.Method == http.MethodGet {
		w.WriteHeader(200)
		w.Write([]byte("ok\n"))
		return 200, ""
	}
	if r.URL.Path != "/mcp" {
		http.NotFound(w, r)
		return 404, "route"
	}
	if r.Method != http.MethodPost && r.Method != http.MethodGet && r.Method != http.MethodDelete {
		w.Header().Set("Allow", "GET, POST, DELETE")
		http.Error(w, "method not allowed", 405)
		return 405, "method"
	}
	token, err := p.m.accessToken(r.Context())
	if err != nil {
		return proxyError(w, err)
	}
	u := *p.c.upstream
	u.RawQuery = r.URL.RawQuery
	req, err := http.NewRequestWithContext(r.Context(), r.Method, u.String(), r.Body)
	if err != nil {
		return proxyError(w, err)
	}
	req.Header = r.Header.Clone()
	stripHopByHop(req.Header)
	for _, name := range []string{"Authorization", "Cookie", "X-Api-Key", "X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto", "Forwarded", "Origin", "Host"} {
		req.Header.Del(name)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.ContentLength = r.ContentLength
	resp, err := p.client.Do(req)
	if err != nil {
		return proxyError(w, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusUnauthorized {
		if err := p.m.onUnauthorized(context.Background(), token); err != nil {
			return proxyError(w, err)
		}
		http.Error(w, "upstream rejected authorization; token refreshed, retry request explicitly", http.StatusBadGateway)
		return 502, "upstream_unauthorized"
	}
	if resp.StatusCode != http.StatusUnauthorized {
		p.m.onSuccess(token)
	}
	head := resp.Header.Clone()
	stripHopByHop(head)
	for name, values := range head {
		for _, value := range values {
			w.Header().Add(name, value)
		}
	}
	w.WriteHeader(resp.StatusCode)
	if strings.HasPrefix(strings.ToLower(resp.Header.Get("Content-Type")), "text/event-stream") {
		flusher, ok := w.(http.Flusher)
		if !ok {
			return resp.StatusCode, "flush_unsupported"
		}
		buf := make([]byte, 4096)
		for {
			n, err := resp.Body.Read(buf)
			if n > 0 {
				if _, writeErr := w.Write(buf[:n]); writeErr != nil {
					return resp.StatusCode, "client_disconnect"
				}
				flusher.Flush()
			}
			if err != nil {
				if err != io.EOF {
					return resp.StatusCode, "upstream_stream"
				}
				break
			}
		}
		return resp.StatusCode, ""
	}
	if _, err := io.Copy(w, resp.Body); err != nil {
		return resp.StatusCode, "body_copy"
	}
	return resp.StatusCode, ""
}

func proxyError(w http.ResponseWriter, err error) (int, string) {
	if errors.Is(err, errReauthorize) {
		http.Error(w, "reauthorization required; run authorize", http.StatusServiceUnavailable)
		return 503, "reauthorize"
	}
	if errors.Is(err, context.Canceled) {
		http.Error(w, "request canceled", 502)
		return 502, "canceled"
	}
	http.Error(w, "upstream or OAuth request failed", http.StatusBadGateway)
	return 502, "upstream_or_oauth"
}
