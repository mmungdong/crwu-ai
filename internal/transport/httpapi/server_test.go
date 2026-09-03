package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/mmungdong/crwu-ai/internal/auth"
)

func TestLoginFlowReturnsExplicitDingTalkIdentityAndOpaqueCRWUSession(t *testing.T) {
	now := time.Date(2026, 9, 3, 10, 0, 0, 0, time.UTC)
	oauth := &fakeDingTalkOAuth{
		identity: auth.Principal{
			Provider: "dingtalk",
			CorpID:   "ding-corp",
			UserID:   "ding-user-1",
			UnionID:  "union-1",
			OpenID:   "open-1",
			Name:     "Test Employee",
		},
	}
	server, err := NewServer(ServerConfig{
		OAuth:      oauth,
		Now:        func() time.Time { return now },
		FlowTTL:    5 * time.Minute,
		SessionTTL: time.Hour,
	})
	if err != nil {
		t.Fatalf("NewServer() error = %v", err)
	}

	startRecorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(startRecorder, httptest.NewRequest(http.MethodPost, "/v1/auth/h3yun/login", nil))
	if startRecorder.Code != http.StatusCreated {
		t.Fatalf("start status = %d, want %d; body = %s", startRecorder.Code, http.StatusCreated, startRecorder.Body.String())
	}
	var start struct {
		FlowID           string    `json:"flowId"`
		AuthorizationURL string    `json:"authorizationUrl"`
		ExpiresAt        time.Time `json:"expiresAt"`
		PollAfterSeconds int       `json:"pollAfterSeconds"`
	}
	if err := json.NewDecoder(startRecorder.Body).Decode(&start); err != nil {
		t.Fatalf("decode start response: %v", err)
	}
	if start.FlowID == "" || start.AuthorizationURL == "" || start.ExpiresAt != now.Add(5*time.Minute) || start.PollAfterSeconds < 1 {
		t.Fatalf("start response = %#v", start)
	}

	pendingRecorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(pendingRecorder, httptest.NewRequest(http.MethodGet, "/v1/auth/h3yun/login/"+start.FlowID, nil))
	var pending map[string]any
	if err := json.NewDecoder(pendingRecorder.Body).Decode(&pending); err != nil {
		t.Fatalf("decode pending response: %v", err)
	}
	if pending["state"] != "pending" {
		t.Fatalf("pending response = %#v", pending)
	}

	authorizationURL, err := url.Parse(start.AuthorizationURL)
	if err != nil {
		t.Fatalf("parse authorization URL: %v", err)
	}
	state := authorizationURL.Query().Get("state")
	callbackRecorder := httptest.NewRecorder()
	callbackTarget := "/oauth/dingtalk/callback?state=" + url.QueryEscape(state) + "&authCode=one-time-code"
	server.Handler().ServeHTTP(callbackRecorder, httptest.NewRequest(http.MethodGet, callbackTarget, nil))
	if callbackRecorder.Code != http.StatusOK || !strings.Contains(callbackRecorder.Body.String(), "DingTalk login succeeded") {
		t.Fatalf("callback status = %d; body = %q", callbackRecorder.Code, callbackRecorder.Body.String())
	}
	if oauth.code != "one-time-code" {
		t.Fatalf("exchanged code = %q", oauth.code)
	}

	completeRecorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(completeRecorder, httptest.NewRequest(http.MethodGet, "/v1/auth/h3yun/login/"+start.FlowID, nil))
	if completeRecorder.Code != http.StatusOK {
		t.Fatalf("poll status = %d; body = %s", completeRecorder.Code, completeRecorder.Body.String())
	}
	var complete struct {
		State     string `json:"state"`
		Principal struct {
			Provider string `json:"provider"`
			CorpID   string `json:"corpId"`
			UserID   string `json:"userId"`
			UnionID  string `json:"unionId"`
			OpenID   string `json:"openId"`
			Name     string `json:"name"`
		} `json:"principal"`
		Session struct {
			AccessToken string    `json:"accessToken"`
			ExpiresAt   time.Time `json:"expiresAt"`
		} `json:"session"`
	}
	if err := json.NewDecoder(completeRecorder.Body).Decode(&complete); err != nil {
		t.Fatalf("decode complete response: %v", err)
	}
	if complete.State != "authenticated" || complete.Principal.Provider != "dingtalk" || complete.Principal.CorpID != "ding-corp" || complete.Principal.UserID != "ding-user-1" || complete.Principal.UnionID != "union-1" || complete.Principal.OpenID != "open-1" || complete.Principal.Name != "Test Employee" {
		t.Fatalf("complete response = %#v", complete)
	}
	if complete.Session.AccessToken == "" || complete.Session.AccessToken == "dingtalk-user-token" {
		t.Fatalf("CRWU access token = %q, want non-provider opaque token", complete.Session.AccessToken)
	}
	if complete.Session.ExpiresAt != now.Add(time.Hour) {
		t.Fatalf("session expiry = %s", complete.Session.ExpiresAt)
	}
}

func TestCallbackRejectsUnknownStateWithoutCallingDingTalk(t *testing.T) {
	oauth := &fakeDingTalkOAuth{}
	server, err := NewServer(ServerConfig{OAuth: oauth})
	if err != nil {
		t.Fatalf("NewServer() error = %v", err)
	}

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/oauth/dingtalk/callback?state=unknown&authCode=code", nil)
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusBadRequest)
	}
	if oauth.calls != 0 {
		t.Fatalf("ExchangeUser calls = %d, want 0", oauth.calls)
	}
}

type fakeDingTalkOAuth struct {
	identity auth.Principal
	code     string
	calls    int
}

func (f *fakeDingTalkOAuth) AuthorizationURL(state string) string {
	return "https://login.dingtalk.example/oauth2/auth?state=" + url.QueryEscape(state)
}

func (f *fakeDingTalkOAuth) ExchangeUser(_ context.Context, code string) (auth.Principal, error) {
	f.calls++
	f.code = code
	return f.identity, nil
}
