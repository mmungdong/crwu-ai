package tests

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/mmungdong/crwu-ai/internal/app/h3yunlogin"
	"github.com/mmungdong/crwu-ai/internal/auth"
	"github.com/mmungdong/crwu-ai/internal/integrations/crwuserver"
	"github.com/mmungdong/crwu-ai/internal/integrations/dingtalk"
	"github.com/mmungdong/crwu-ai/internal/transport/httpapi"
)

func TestDingTalkLoginVerticalSlice(t *testing.T) {
	dingTalk := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1.0/oauth2/userAccessToken":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"accessToken":  "provider-user-token",
				"refreshToken": "provider-refresh-token",
				"expireIn":     7200,
				"corpId":       "ding-corp",
			})
		case "/v1.0/contact/users/me":
			if r.Header.Get("x-acs-dingtalk-access-token") != "provider-user-token" {
				t.Fatal("DingTalk user token was not used server-side")
			}
			_ = json.NewEncoder(w).Encode(map[string]string{
				"nick": "Test Employee", "openId": "open-1", "unionId": "union-1",
			})
		case "/v1.0/oauth2/accessToken":
			_ = json.NewEncoder(w).Encode(map[string]any{"accessToken": "provider-app-token", "expireIn": 7200})
		case "/topapi/user/getbyunionid":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"errcode": 0, "errmsg": "ok", "result": map[string]string{"userid": "ding-user-1"},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(dingTalk.Close)

	oauth, err := dingtalk.NewOAuthClient(dingtalk.OAuthConfig{
		ClientID:              "ding-client",
		ClientSecret:          "server-only-secret",
		CorpID:                "ding-corp",
		RedirectURL:           "http://localhost/oauth/dingtalk/callback",
		AuthorizationEndpoint: dingTalk.URL + "/oauth2/auth",
		APIBaseURL:            dingTalk.URL,
		LegacyAPIBaseURL:      dingTalk.URL,
		HTTPClient:            dingTalk.Client(),
	})
	if err != nil {
		t.Fatalf("create DingTalk OAuth client: %v", err)
	}
	api, err := httpapi.NewServer(httpapi.ServerConfig{OAuth: dingTalkOAuthAdapter{client: oauth}})
	if err != nil {
		t.Fatalf("create CRWU server: %v", err)
	}
	crwuServer := httptest.NewServer(api.Handler())
	t.Cleanup(crwuServer.Close)

	store := &memorySessionStore{}
	service := h3yunlogin.Service{
		Gateway:  crwuserver.NewLoginClient(crwuServer.Client()),
		Sessions: store,
	}
	result, err := service.Login(context.Background(), h3yunlogin.Request{
		ServerURL: crwuServer.URL,
		OnAuthorizationRequired: func(authorizationURL string) {
			parsed, parseErr := url.Parse(authorizationURL)
			if parseErr != nil {
				t.Fatalf("parse authorization URL: %v", parseErr)
			}
			callback := crwuServer.URL + "/oauth/dingtalk/callback?state=" + url.QueryEscape(parsed.Query().Get("state")) + "&authCode=valid-code"
			response, callbackErr := crwuServer.Client().Get(callback)
			if callbackErr != nil {
				t.Fatalf("complete callback: %v", callbackErr)
			}
			_ = response.Body.Close()
			if response.StatusCode != http.StatusOK {
				t.Fatalf("callback status = %d", response.StatusCode)
			}
		},
	})
	if err != nil {
		t.Fatalf("Login() error = %v", err)
	}
	if result.Principal.Provider != "dingtalk" || result.Principal.CorpID != "ding-corp" || result.Principal.UserID != "ding-user-1" || result.Principal.UnionID != "union-1" || result.Principal.OpenID != "open-1" {
		t.Fatalf("authenticated principal = %#v", result.Principal)
	}
	if store.session.AccessToken == "" || store.session.AccessToken == "provider-user-token" || store.session.AccessToken == "provider-refresh-token" || store.session.AccessToken == "provider-app-token" {
		t.Fatalf("stored access token is not an opaque CRWU token: %q", store.session.AccessToken)
	}
	if store.session.ExpiresAt.Before(time.Now()) {
		t.Fatalf("stored session is already expired: %s", store.session.ExpiresAt)
	}
}

type memorySessionStore struct {
	session auth.Session
}

type dingTalkOAuthAdapter struct {
	client *dingtalk.OAuthClient
}

func (a dingTalkOAuthAdapter) AuthorizationURL(state string) string {
	return a.client.AuthorizationURL(state)
}

func (a dingTalkOAuthAdapter) ExchangeUser(ctx context.Context, code string) (auth.Principal, error) {
	identity, _, err := a.client.ExchangeUser(ctx, code)
	if err != nil {
		return auth.Principal{}, err
	}
	return auth.Principal{
		Provider: "dingtalk",
		CorpID:   identity.CorpID,
		UserID:   identity.UserID,
		UnionID:  identity.UnionID,
		OpenID:   identity.OpenID,
		Name:     identity.Name,
	}, nil
}

func (s *memorySessionStore) Save(_ context.Context, _ string, session auth.Session) error {
	s.session = session
	return nil
}
