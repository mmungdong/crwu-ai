package crwuserver

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestLoginClientStartsAndPollsAFlow(t *testing.T) {
	expiresAt := time.Date(2026, 9, 3, 12, 0, 0, 0, time.UTC)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/v1/auth/h3yun/login":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"flowId":           "flow-1",
				"authorizationUrl": "https://login.dingtalk.com/oauth2/auth?state=state-1",
				"expiresAt":        expiresAt,
				"pollAfterSeconds": 3,
			})
		case r.Method == http.MethodGet && r.URL.Path == "/v1/auth/h3yun/login/flow-1":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"state": "authenticated",
				"principal": map[string]any{
					"provider": "dingtalk",
					"corpId":   "ding-corp",
					"userId":   "ding-user-1",
					"unionId":  "union-1",
					"openId":   "open-1",
					"name":     "Test Employee",
				},
				"session": map[string]any{
					"accessToken": "crwu-session-token",
					"expiresAt":   expiresAt,
				},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(provider.Close)

	client := NewLoginClient(provider.Client())
	flow, err := client.Start(context.Background(), provider.URL)
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	if flow.ID != "flow-1" || flow.AuthorizationURL == "" || flow.ExpiresAt != expiresAt || flow.PollAfter != 3*time.Second {
		t.Fatalf("flow = %#v", flow)
	}

	result, err := client.Poll(context.Background(), provider.URL, flow.ID)
	if err != nil {
		t.Fatalf("Poll() error = %v", err)
	}
	if result.State != "authenticated" || result.Principal.Provider != "dingtalk" || result.Principal.CorpID != "ding-corp" || result.Principal.UserID != "ding-user-1" || result.Session.AccessToken != "crwu-session-token" || result.Session.ExpiresAt != expiresAt {
		t.Fatalf("poll result = %#v", result)
	}
}

func TestLoginClientRejectsInsecureRemoteServerURL(t *testing.T) {
	client := NewLoginClient(http.DefaultClient)
	if _, err := client.Start(context.Background(), "http://crwu.example.com"); err == nil {
		t.Fatal("Start() error = nil, want insecure remote URL error")
	}
}
