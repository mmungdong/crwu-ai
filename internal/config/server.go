// Package config loads and validates CRWU process configuration.
package config

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"strings"
)

type Server struct {
	Addr      string
	PublicURL string
	DingTalk  DingTalk
}

type DingTalk struct {
	ClientID     string
	ClientSecret string
	CorpID       string
	RedirectURL  string
}

func LoadServer(getenv func(string) string) (Server, error) {
	if getenv == nil {
		return Server{}, errors.New("environment reader is required")
	}
	values := map[string]string{
		"CRWU_PUBLIC_URL":             strings.TrimSpace(getenv("CRWU_PUBLIC_URL")),
		"CRWU_DINGTALK_CLIENT_ID":     strings.TrimSpace(getenv("CRWU_DINGTALK_CLIENT_ID")),
		"CRWU_DINGTALK_CLIENT_SECRET": strings.TrimSpace(getenv("CRWU_DINGTALK_CLIENT_SECRET")),
		"CRWU_DINGTALK_CORP_ID":       strings.TrimSpace(getenv("CRWU_DINGTALK_CORP_ID")),
	}
	var missing []string
	for _, name := range []string{"CRWU_PUBLIC_URL", "CRWU_DINGTALK_CLIENT_ID", "CRWU_DINGTALK_CLIENT_SECRET", "CRWU_DINGTALK_CORP_ID"} {
		if values[name] == "" {
			missing = append(missing, name)
		}
	}
	if len(missing) != 0 {
		return Server{}, fmt.Errorf("missing required settings: %s", strings.Join(missing, ", "))
	}

	publicURL, err := validatePublicURL(values["CRWU_PUBLIC_URL"])
	if err != nil {
		return Server{}, fmt.Errorf("CRWU_PUBLIC_URL: %w", err)
	}
	addr := strings.TrimSpace(getenv("CRWU_SERVER_ADDR"))
	if addr == "" {
		addr = "127.0.0.1:8080"
	}
	return Server{
		Addr:      addr,
		PublicURL: publicURL,
		DingTalk: DingTalk{
			ClientID:     values["CRWU_DINGTALK_CLIENT_ID"],
			ClientSecret: values["CRWU_DINGTALK_CLIENT_SECRET"],
			CorpID:       values["CRWU_DINGTALK_CORP_ID"],
			RedirectURL:  publicURL + "/oauth/dingtalk/callback",
		},
	}, nil
}

func validatePublicURL(value string) (string, error) {
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", errors.New("must be a valid absolute URL")
	}
	if parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || (parsed.Path != "" && parsed.Path != "/") {
		return "", errors.New("must contain only a scheme and host")
	}
	if parsed.Scheme != "https" && !(parsed.Scheme == "http" && isLoopback(parsed.Hostname())) {
		return "", errors.New("must use HTTPS; HTTP is allowed only for localhost")
	}
	return strings.TrimRight(parsed.String(), "/"), nil
}

func isLoopback(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
