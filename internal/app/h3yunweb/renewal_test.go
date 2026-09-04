package h3yunweb

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/mmungdong/crwu-ai/internal/platform/h3yuncreds"
)

func TestEnsureFreshRefreshesNearExpiry(t *testing.T) {
	store := &fakeStore{}
	now := time.Now()
	newToken := testToken("eng-1", "u1", now.Add(48*time.Hour).Unix())
	client := &fakeClient{refresh: newToken}
	store.session = h3yuncreds.Session{EngineCode: "eng-1", UserID: "u1", Token: "old", ExpiresAt: now.Add(time.Hour)}
	store.exists = true
	service := testService(store, client)
	service.Now = func() time.Time { return now }
	if err := service.EnsureFresh(context.Background()); err != nil {
		t.Fatalf("EnsureFresh() error = %v", err)
	}
	if store.session.Token == "old" {
		t.Fatalf("session was not refreshed: %q", store.session.Token)
	}
	if !strings.HasPrefix(store.session.Token, "header.") {
		t.Fatalf("unexpected stored token: %q", store.session.Token)
	}
	if store.session.ExpiresAt.Before(now.Add(47 * time.Hour)) {
		t.Fatalf("expiry not extended: %v", store.session.ExpiresAt)
	}
}

func TestEnsureFreshSkipsWhenSessionIsFresh(t *testing.T) {
	store := &fakeStore{}
	now := time.Now()
	client := &fakeClient{}
	store.session = h3yuncreds.Session{EngineCode: "eng-1", UserID: "u1", Token: "old", ExpiresAt: now.Add(40 * time.Hour)}
	store.exists = true
	service := testService(store, client)
	service.Now = func() time.Time { return now }
	if err := service.EnsureFresh(context.Background()); err != nil {
		t.Fatalf("EnsureFresh() error = %v", err)
	}
	if store.session.Token != "old" {
		t.Fatalf("session changed unexpectedly: %q", store.session.Token)
	}
}

func TestEnsureFreshExpiredGuidesRelogin(t *testing.T) {
	store := &fakeStore{}
	now := time.Now()
	store.session = h3yuncreds.Session{EngineCode: "eng-1", UserID: "u1", Token: "old", ExpiresAt: now.Add(-time.Minute)}
	store.exists = true
	service := testService(store, &fakeClient{})
	service.Now = func() time.Time { return now }
	err := service.EnsureFresh(context.Background())
	if err == nil || !strings.Contains(err.Error(), "session login") {
		t.Fatalf("EnsureFresh() error = %v, want relogin hint", err)
	}
}

func TestEnsureFreshWithoutSessionGuidesLogin(t *testing.T) {
	store := &fakeStore{}
	service := testService(store, &fakeClient{})
	if err := service.EnsureFresh(context.Background()); err == nil || !strings.Contains(err.Error(), "session login") {
		t.Fatalf("EnsureFresh() error = %v, want login hint", err)
	}
}
