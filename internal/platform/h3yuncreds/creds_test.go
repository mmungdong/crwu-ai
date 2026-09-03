package h3yuncreds

import (
	"context"
	"errors"
	"testing"
	"time"
)

type memBackend struct {
	values map[string]string
}

func (b *memBackend) Set(service, account, secret string) error {
	if b.values == nil {
		b.values = map[string]string{}
	}
	b.values[service+"|"+account] = secret
	return nil
}

func (b *memBackend) Get(service, account string) (string, error) {
	value, ok := b.values[service+"|"+account]
	if !ok {
		return "", errors.New("not found")
	}
	return value, nil
}

func (b *memBackend) Delete(service, account string) error {
	delete(b.values, service+"|"+account)
	return nil
}

func TestStoreRoundTrip(t *testing.T) {
	store := NewStoreWithBackend(&memBackend{})
	session := Session{
		EngineCode:  "eng-1",
		ShardKey:    "Vessel15",
		UserID:      "u1",
		AccountType: "DingId",
		Token:       "jwt",
		ExpiresAt:   time.Now().Add(time.Hour),
	}
	if err := store.Save(context.Background(), session); err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	loaded, err := store.Load(context.Background())
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if loaded.Token != "jwt" || loaded.EngineCode != "eng-1" || loaded.UserID != "u1" {
		t.Fatalf("loaded = %+v", loaded)
	}
	if err := store.Delete(context.Background()); err != nil {
		t.Fatalf("Delete() error = %v", err)
	}
	if _, err := store.Load(context.Background()); err == nil {
		t.Fatal("Load() after Delete() = nil error, want failure")
	}
}

func TestStoreValidatesSession(t *testing.T) {
	store := NewStoreWithBackend(&memBackend{})
	empty := Session{}
	if err := store.Save(context.Background(), empty); err == nil {
		t.Fatal("Save(empty) error = nil, want validation error")
	}
	partial := Session{Token: "x", EngineCode: "eng"}
	if err := store.Save(context.Background(), partial); err == nil {
		t.Fatal("Save(missing userId) error = nil, want validation error")
	}
}
