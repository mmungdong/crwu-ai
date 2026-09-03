package auth

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

func TestKeyringStoreSavesOpaqueCRWUSessionUnderServerSpecificAccount(t *testing.T) {
	backend := &fakeKeyring{}
	store := newKeyringStore(backend)
	session := Session{
		AccessToken: "opaque-crwu-token",
		ExpiresAt:   time.Date(2026, 9, 3, 13, 0, 0, 0, time.UTC),
		Principal: Principal{
			Provider: "dingtalk",
			CorpID:   "ding-corp",
			UserID:   "ding-user-1",
			UnionID:  "union-1",
			OpenID:   "open-1",
			Name:     "Test Employee",
		},
	}

	if err := store.Save(context.Background(), "https://crwu.example.com", session); err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	if backend.service != "crwu" {
		t.Fatalf("keyring service = %q, want crwu", backend.service)
	}
	if backend.account == "" || backend.account == "https://crwu.example.com" {
		t.Fatalf("keyring account = %q, want non-empty server-specific identifier", backend.account)
	}
	var stored Session
	if err := json.Unmarshal([]byte(backend.secret), &stored); err != nil {
		t.Fatalf("decode stored session: %v", err)
	}
	if stored.AccessToken != session.AccessToken || stored.Principal.UserID != session.Principal.UserID || stored.ExpiresAt != session.ExpiresAt {
		t.Fatalf("stored session = %#v", stored)
	}
}

func TestKeyringStoreRejectsProviderlessOrEmptySession(t *testing.T) {
	store := newKeyringStore(&fakeKeyring{})
	if err := store.Save(context.Background(), "https://crwu.example.com", Session{}); err == nil {
		t.Fatal("Save() error = nil, want validation error")
	}
}

type fakeKeyring struct {
	service string
	account string
	secret  string
}

func (f *fakeKeyring) Set(service, account, secret string) error {
	f.service = service
	f.account = account
	f.secret = secret
	return nil
}

func (f *fakeKeyring) Get(string, string) (string, error) {
	return f.secret, nil
}

func (f *fakeKeyring) Delete(string, string) error {
	return nil
}
