package main

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func proxyFixture(t *testing.T, handler http.HandlerFunc) (*proxy, *httptest.Server) {
	t.Helper()
	server := httptest.NewServer(handler)
	u, _ := url.Parse(server.URL + "/v2/mcp")
	c := config{UpstreamURL: u.String(), upstream: u, Store: t.TempDir() + "/oauth.json", refreshBefore: 5 * time.Minute}
	m, err := newTokenManager(c, nil)
	if err != nil {
		t.Fatal(err)
	}
	m.s = credentials{Upstream: c.UpstreamURL, AccessToken: "token", RefreshToken: "refresh", ExpiresAt: time.Now().Add(time.Hour)}
	t.Cleanup(server.Close)
	return newProxy(c, m), server
}

func localReq(method, target string, body io.Reader) *http.Request {
	r := httptest.NewRequest(method, target, body)
	r.Host = "127.0.0.1:8765"
	return r
}

func TestForwardBodyHeadersStatusAndQuery(t *testing.T) {
	p, _ := proxyFixture(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if string(body) != `{"id":1}` || r.URL.Path != "/v2/mcp" || r.URL.RawQuery != "x=1%202" || r.Header.Get("Mcp-Session-Id") != "sid" || r.Header.Get("Authorization") != "Bearer token" || r.Header.Get("Cookie") != "" || r.Header.Get("X-Api-Key") != "" {
			t.Errorf("upstream request: path=%s query=%s headers=%v body=%q", r.URL.Path, r.URL.RawQuery, r.Header, body)
		}
		w.Header().Set("Mcp-Session-Id", "next")
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(418)
		w.Write([]byte(`{"error":true}`))
	})
	r := localReq("POST", "http://127.0.0.1:8765/mcp?x=1%202", strings.NewReader(`{"id":1}`))
	r.Header.Set("Mcp-Session-Id", "sid")
	r.Header.Set("Cookie", "private")
	r.Header.Set("X-Api-Key", "private")
	w := httptest.NewRecorder()
	p.ServeHTTP(w, r)
	if w.Code != 418 || w.Body.String() != `{"error":true}` || w.Header().Get("Mcp-Session-Id") != "next" {
		t.Fatalf("response: %d %s %v", w.Code, w.Body.String(), w.Header())
	}
}

func TestDeletePreservesMethodAndSession(t *testing.T) {
	p, _ := proxyFixture(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete || r.Header.Get("Mcp-Session-Id") != "delete-session" {
			t.Errorf("method=%s session=%q", r.Method, r.Header.Get("Mcp-Session-Id"))
		}
		w.WriteHeader(204)
	})
	r := localReq(http.MethodDelete, "http://127.0.0.1:8765/mcp", nil)
	r.Header.Set("Mcp-Session-Id", "delete-session")
	w := httptest.NewRecorder()
	p.ServeHTTP(w, r)
	if w.Code != 204 {
		t.Fatalf("status=%d", w.Code)
	}
}

func TestLocalOriginHostAndConnectionFailure(t *testing.T) {
	p, _ := proxyFixture(t, func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) })
	for _, tc := range []struct{ host, origin string }{{"evil.example:8765", ""}, {"127.0.0.1:8765", "http://evil.example:8765"}} {
		r := localReq("GET", "http://127.0.0.1:8765/mcp", nil)
		r.Host = tc.host
		r.Header.Set("Origin", tc.origin)
		w := httptest.NewRecorder()
		p.ServeHTTP(w, r)
		if w.Code != 403 {
			t.Fatalf("host=%q origin=%q status=%d", tc.host, tc.origin, w.Code)
		}
	}
	p.client.Transport = roundTripFunc(func(*http.Request) (*http.Response, error) { return nil, context.DeadlineExceeded })
	w := httptest.NewRecorder()
	p.ServeHTTP(w, localReq("GET", "http://127.0.0.1:8765/mcp", nil))
	if w.Code != 502 {
		t.Fatalf("connection failure: %d", w.Code)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestUnauthorizedNeverReplays(t *testing.T) {
	var calls atomic.Int32
	p, _ := proxyFixture(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v2/mcp" && r.Method == http.MethodPost {
			calls.Add(1)
		}
		w.Header().Set("WWW-Authenticate", "Bearer secret")
		w.WriteHeader(401)
	})
	// A deliberately missing issuer makes the controlled refresh fail. The request is still sent once.
	w := httptest.NewRecorder()
	p.ServeHTTP(w, localReq("POST", "http://127.0.0.1:8765/mcp", strings.NewReader(`{"method":"tools/call"}`)))
	if calls.Load() != 1 || w.Code == 401 || w.Header().Get("WWW-Authenticate") != "" {
		t.Fatalf("calls=%d status=%d headers=%v", calls.Load(), w.Code, w.Header())
	}
}

func TestRepeatedUnauthorizedRequiresReauthorization(t *testing.T) {
	var calls atomic.Int32
	p, server := proxyFixture(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/token" {
			r.ParseForm()
			if r.Form.Get("refresh_token") != "refresh" {
				t.Errorf("refresh token=%q", r.Form.Get("refresh_token"))
			}
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{"access_token":"new-token","refresh_token":"new-refresh","expires_in":3600,"token_type":"Bearer"}`))
			return
		}
		calls.Add(1)
		w.WriteHeader(401)
	})
	p.m.tokenEndpoint = server.URL + "/token"
	for i, want := range []int{502, 503} {
		w := httptest.NewRecorder()
		p.ServeHTTP(w, localReq(http.MethodPost, "http://127.0.0.1:8765/mcp", strings.NewReader(`{"method":"tools/call"}`)))
		if w.Code != want {
			t.Fatalf("request %d status=%d want=%d", i, w.Code, want)
		}
	}
	if calls.Load() != 2 {
		t.Fatalf("upstream calls=%d", calls.Load())
	}
	s, err := readStore(p.c.Store, p.c.UpstreamURL)
	if err != nil || s.RefreshToken != "" || s.AccessToken != "" {
		t.Fatalf("stored rejection: %+v %v", s, err)
	}
}

func TestSSEFirstEventAndCancel(t *testing.T) {
	upstreamCanceled := make(chan struct{})
	p, _ := proxyFixture(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Write([]byte("data: first\n\n"))
		w.(http.Flusher).Flush()
		<-r.Context().Done()
		close(upstreamCanceled)
	})
	server := httptest.NewServer(p)
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	req, _ := http.NewRequestWithContext(ctx, "GET", server.URL+"/mcp", nil)
	req.Host = "127.0.0.1:8765"
	client := &http.Client{Timeout: 2 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	b := make([]byte, 13)
	if _, err := io.ReadFull(resp.Body, b); err != nil || string(b) != "data: first\n\n" {
		t.Fatalf("first event %q %v", b, err)
	}
	cancel()
	resp.Body.Close()
	select {
	case <-upstreamCanceled:
	case <-time.After(time.Second):
		t.Fatal("upstream stream was not canceled")
	}
}
