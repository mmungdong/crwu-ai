package dingtalk

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

func TestAuthorizationURLUsesDingTalkOAuthAndOneTimeState(t *testing.T) {
	client, err := NewOAuthClient(OAuthConfig{
		ClientID:     "ding-client",
		ClientSecret: "server-secret",
		CorpID:       "ding-corp",
		RedirectURL:  "https://crwu.example.com/oauth/dingtalk/callback",
	})
	if err != nil {
		t.Fatalf("NewOAuthClient() error = %v", err)
	}

	value := client.AuthorizationURL("one-time-state")
	parsed, err := url.Parse(value)
	if err != nil {
		t.Fatalf("parse authorization URL: %v", err)
	}
	if parsed.Scheme != "https" || parsed.Host != "login.dingtalk.com" || parsed.Path != "/oauth2/auth" {
		t.Fatalf("authorization endpoint = %s", parsed.String())
	}
	query := parsed.Query()
	if query.Get("client_id") != "ding-client" || query.Get("state") != "one-time-state" {
		t.Fatalf("authorization query = %v", query)
	}
	if query.Get("redirect_uri") != "https://crwu.example.com/oauth/dingtalk/callback" {
		t.Fatalf("redirect_uri = %q", query.Get("redirect_uri"))
	}
	if query.Get("scope") != "openid" || query.Get("response_type") != "code" {
		t.Fatalf("OAuth query = %v", query)
	}
	if query.Get("client_secret") != "" {
		t.Fatal("authorization URL must not expose the client secret")
	}
}

func TestExchangeUserKeepsProviderTokenServerSideAndReturnsExplicitIdentity(t *testing.T) {
	var tokenRequest map[string]string
	var appTokenRequest map[string]string
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1.0/oauth2/userAccessToken":
			if err := json.NewDecoder(r.Body).Decode(&tokenRequest); err != nil {
				t.Fatalf("decode token request: %v", err)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"accessToken":  "dingtalk-user-token",
				"refreshToken": "dingtalk-refresh-token",
				"expireIn":     7200,
				"corpId":       "ding-corp",
			})
		case "/v1.0/contact/users/me":
			if got := r.Header.Get("x-acs-dingtalk-access-token"); got != "dingtalk-user-token" {
				t.Fatalf("access-token header = %q", got)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"nick":    "Test Employee",
				"openId":  "open-1",
				"unionId": "union-1",
			})
		case "/v1.0/oauth2/accessToken":
			if err := json.NewDecoder(r.Body).Decode(&appTokenRequest); err != nil {
				t.Fatalf("decode app token request: %v", err)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"accessToken": "dingtalk-app-token",
				"expireIn":    7200,
			})
		case "/topapi/user/getbyunionid":
			if got := r.URL.Query().Get("access_token"); got != "dingtalk-app-token" {
				t.Fatalf("app access_token query = %q", got)
			}
			var body map[string]string
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatalf("decode union ID request: %v", err)
			}
			if body["unionid"] != "union-1" {
				t.Fatalf("unionid = %q", body["unionid"])
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"errcode": 0,
				"errmsg":  "ok",
				"result":  map[string]any{"userid": "ding-user-1"},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(provider.Close)

	client, err := NewOAuthClient(OAuthConfig{
		ClientID:         "ding-client",
		ClientSecret:     "server-secret",
		CorpID:           "ding-corp",
		RedirectURL:      "https://crwu.example.com/oauth/dingtalk/callback",
		APIBaseURL:       provider.URL,
		LegacyAPIBaseURL: provider.URL,
		HTTPClient:       provider.Client(),
	})
	if err != nil {
		t.Fatalf("NewOAuthClient() error = %v", err)
	}

	identity, providerSession, err := client.ExchangeUser(context.Background(), "one-time-code")
	if err != nil {
		t.Fatalf("ExchangeUser() error = %v", err)
	}
	if tokenRequest["clientId"] != "ding-client" || tokenRequest["clientSecret"] != "server-secret" || tokenRequest["code"] != "one-time-code" || tokenRequest["grantType"] != "authorization_code" {
		t.Fatalf("token request = %#v", tokenRequest)
	}
	if appTokenRequest["appKey"] != "ding-client" || appTokenRequest["appSecret"] != "server-secret" {
		t.Fatalf("app token request = %#v", appTokenRequest)
	}
	if identity.CorpID != "ding-corp" || identity.UserID != "ding-user-1" || identity.UnionID != "union-1" || identity.OpenID != "open-1" || identity.Name != "Test Employee" {
		t.Fatalf("identity = %#v", identity)
	}
	if providerSession.AccessToken != "dingtalk-user-token" || providerSession.RefreshToken != "dingtalk-refresh-token" {
		t.Fatalf("provider session = %#v", providerSession)
	}
}
