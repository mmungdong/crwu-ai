package h3yunlogin

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/mmungdong/crwu-ai/internal/auth"
)

func TestServiceAuthenticatesAndStoresOnlyCRWUSession(t *testing.T) {
	now := time.Date(2026, 9, 3, 9, 0, 0, 0, time.UTC)
	gateway := &fakeGateway{
		flow: Flow{
			ID:               "flow-1",
			AuthorizationURL: "https://login.dingtalk.com/oauth2/auth?state=state-1",
			ExpiresAt:        now.Add(5 * time.Minute),
			PollAfter:        time.Millisecond,
		},
		results: []PollResult{
			{State: StatePending},
			{
				State: StateAuthenticated,
				Principal: auth.Principal{
					Provider: "dingtalk",
					CorpID:   "ding-corp",
					UnionID:  "union-1",
					OpenID:   "open-1",
					Name:     "Test Employee",
				},
				Session: auth.Session{
					AccessToken: "crwu-session-token",
					ExpiresAt:   now.Add(time.Hour),
				},
			},
		},
	}
	opener := &fakeOpener{}
	store := &fakeSessionStore{}
	var reportedURL string

	service := Service{
		Gateway:  gateway,
		Opener:   opener,
		Sessions: store,
		Now:      func() time.Time { return now },
		Wait: func(context.Context, time.Duration) error {
			return nil
		},
	}

	result, err := service.Login(context.Background(), Request{
		ServerURL:   "https://crwu.example.com",
		OpenBrowser: true,
		OnAuthorizationRequired: func(value string) {
			reportedURL = value
		},
	})
	if err != nil {
		t.Fatalf("Login() error = %v", err)
	}
	if reportedURL != gateway.flow.AuthorizationURL {
		t.Fatalf("reported URL = %q, want %q", reportedURL, gateway.flow.AuthorizationURL)
	}
	if opener.opened != gateway.flow.AuthorizationURL {
		t.Fatalf("opened URL = %q, want %q", opener.opened, gateway.flow.AuthorizationURL)
	}
	if result.Principal.UnionID != "union-1" || result.Principal.CorpID != "ding-corp" {
		t.Fatalf("principal = %#v, want explicit DingTalk identity", result.Principal)
	}
	if store.serverURL != "https://crwu.example.com" {
		t.Fatalf("stored server URL = %q", store.serverURL)
	}
	if store.session.AccessToken != "crwu-session-token" {
		t.Fatalf("stored session = %#v", store.session)
	}
}

func TestServiceDoesNotStoreFailedLogin(t *testing.T) {
	gateway := &fakeGateway{
		flow:    Flow{ID: "flow-1", AuthorizationURL: "https://login.example", ExpiresAt: time.Now().Add(time.Minute)},
		results: []PollResult{{State: StateFailed, ErrorCode: "access_denied", ErrorMessage: "DingTalk authorization was denied."}},
	}
	store := &fakeSessionStore{}
	service := Service{
		Gateway:  gateway,
		Opener:   &fakeOpener{},
		Sessions: store,
		Now:      time.Now,
		Wait:     func(context.Context, time.Duration) error { return nil },
	}

	_, err := service.Login(context.Background(), Request{ServerURL: "https://crwu.example.com"})
	if err == nil || !errors.Is(err, ErrAuthorizationFailed) {
		t.Fatalf("Login() error = %v, want ErrAuthorizationFailed", err)
	}
	if store.calls != 0 {
		t.Fatalf("session store calls = %d, want 0", store.calls)
	}
}

type fakeGateway struct {
	flow    Flow
	results []PollResult
	polls   int
}

func (f *fakeGateway) Start(context.Context, string) (Flow, error) {
	return f.flow, nil
}

func (f *fakeGateway) Poll(context.Context, string, string) (PollResult, error) {
	index := f.polls
	if index >= len(f.results) {
		index = len(f.results) - 1
	}
	f.polls++
	return f.results[index], nil
}

type fakeOpener struct {
	opened string
}

func (f *fakeOpener) Open(value string) error {
	f.opened = value
	return nil
}

type fakeSessionStore struct {
	calls     int
	serverURL string
	session   auth.Session
}

func (f *fakeSessionStore) Save(_ context.Context, serverURL string, session auth.Session) error {
	f.calls++
	f.serverURL = serverURL
	f.session = session
	return nil
}
