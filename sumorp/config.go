package main

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

type config struct {
	UpstreamURL   string `yaml:"upstream_url"`
	Listen        string `yaml:"listen"`
	Store         string `yaml:"store"`
	RefreshBefore string `yaml:"refresh_before"`
	OAuth         struct {
		Scopes          []string `yaml:"scopes"`
		ClientID        string   `yaml:"client_id"`
		ClientSecretEnv string   `yaml:"client_secret_env"`
	} `yaml:"oauth"`
	refreshBefore time.Duration
	upstream      *url.URL
}

func loadConfig(path string) (config, error) {
	var c config
	b, err := os.ReadFile(path)
	if err != nil {
		return c, err
	}
	dec := yaml.NewDecoder(strings.NewReader(string(b)))
	dec.KnownFields(true)
	if err := dec.Decode(&c); err != nil {
		return c, err
	}
	if c.Listen == "" {
		c.Listen = "0.0.0.0:8765"
	}
	if c.Store == "" {
		c.Store = "/data/oauth.json"
	}
	if c.RefreshBefore == "" {
		c.RefreshBefore = "5m"
	}
	c.refreshBefore, err = time.ParseDuration(c.RefreshBefore)
	if err != nil || c.refreshBefore < 0 {
		return c, errors.New("refresh_before must be a nonnegative duration")
	}
	c.upstream, err = url.Parse(c.UpstreamURL)
	if err != nil || c.upstream == nil || c.upstream.Scheme != "https" || c.upstream.Host == "" || c.upstream.User != nil || c.upstream.Fragment != "" || c.upstream.RawQuery != "" {
		return c, errors.New("upstream_url must be an HTTPS URL without credentials, query, or fragment")
	}
	if _, port, err := net.SplitHostPort(c.Listen); err != nil || port != "8765" {
		return c, errors.New("listen must use port 8765 (the OAuth redirect port)")
	}
	if len(c.OAuth.Scopes) == 0 {
		return c, errors.New("oauth.scopes is required")
	}
	if c.OAuth.ClientSecretEnv != "" && c.OAuth.ClientID == "" {
		return c, errors.New("oauth.client_secret_env requires client_id")
	}
	if c.OAuth.ClientSecretEnv != "" && os.Getenv(c.OAuth.ClientSecretEnv) == "" {
		return c, fmt.Errorf("client secret environment variable %s is empty", c.OAuth.ClientSecretEnv)
	}
	return c, nil
}

func (c config) redirectURI() string { return "http://127.0.0.1:8765/oauth/callback" }

func (c config) clientSecret() string {
	if c.OAuth.ClientSecretEnv == "" {
		return ""
	}
	return os.Getenv(c.OAuth.ClientSecretEnv)
}
