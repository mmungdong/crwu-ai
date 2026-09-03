package config

import (
	"strings"
	"testing"
)

func TestLoadServerRequiresDingTalkOnlyConfiguration(t *testing.T) {
	values := map[string]string{
		"CRWU_PUBLIC_URL":             "https://crwu.example.com/",
		"CRWU_DINGTALK_CLIENT_ID":     "ding-client",
		"CRWU_DINGTALK_CLIENT_SECRET": "server-secret",
		"CRWU_DINGTALK_CORP_ID":       "ding-corp",
	}
	configuration, err := LoadServer(func(name string) string { return values[name] })
	if err != nil {
		t.Fatalf("LoadServer() error = %v", err)
	}
	if configuration.Addr != "127.0.0.1:8080" || configuration.PublicURL != "https://crwu.example.com" || configuration.DingTalk.ClientID != "ding-client" || configuration.DingTalk.ClientSecret != "server-secret" || configuration.DingTalk.CorpID != "ding-corp" {
		t.Fatalf("configuration = %#v", configuration)
	}
	if configuration.DingTalk.RedirectURL != "https://crwu.example.com/oauth/dingtalk/callback" {
		t.Fatalf("redirect URL = %q", configuration.DingTalk.RedirectURL)
	}
}

func TestLoadServerReportsEveryMissingRequiredSettingWithoutValues(t *testing.T) {
	_, err := LoadServer(func(string) string { return "" })
	if err == nil {
		t.Fatal("LoadServer() error = nil")
	}
	message := err.Error()
	for _, name := range []string{"CRWU_PUBLIC_URL", "CRWU_DINGTALK_CLIENT_ID", "CRWU_DINGTALK_CLIENT_SECRET", "CRWU_DINGTALK_CORP_ID"} {
		if !strings.Contains(message, name) {
			t.Errorf("error %q does not mention %s", message, name)
		}
	}
}

func TestLoadServerAllowsHTTPOnlyForLoopbackDevelopment(t *testing.T) {
	base := map[string]string{
		"CRWU_DINGTALK_CLIENT_ID":     "client",
		"CRWU_DINGTALK_CLIENT_SECRET": "secret",
		"CRWU_DINGTALK_CORP_ID":       "corp",
	}
	for _, value := range []string{"http://localhost:8080", "http://127.0.0.1:8080"} {
		values := cloneValues(base)
		values["CRWU_PUBLIC_URL"] = value
		if _, err := LoadServer(func(name string) string { return values[name] }); err != nil {
			t.Errorf("LoadServer(%q) error = %v", value, err)
		}
	}
	values := cloneValues(base)
	values["CRWU_PUBLIC_URL"] = "http://crwu.example.com"
	if _, err := LoadServer(func(name string) string { return values[name] }); err == nil {
		t.Fatal("LoadServer() accepted insecure remote public URL")
	}
}

func cloneValues(source map[string]string) map[string]string {
	result := make(map[string]string, len(source))
	for key, value := range source {
		result[key] = value
	}
	return result
}
