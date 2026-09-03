// Package h3yuncreds stores H3Yun credentials locally in the operating system
// credential store. This is an approved temporary deviation from AGENTS.md
// ("server holds H3Yun credentials") until crwu-server hosts a credential
// vault; the storage seam is kept swappable.
package h3yuncreds

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/zalando/go-keyring"
)

const (
	serviceName = "crwu-h3yun"
	accountName = "current"
)

// Session is the stored web-console session credential for one employee.
type Session struct {
	EngineCode  string    `json:"engineCode"`
	ShardKey    string    `json:"shardKey,omitempty"`
	UserID      string    `json:"userId"`
	AccountType string    `json:"accountType,omitempty"`
	Token       string    `json:"token"`
	ExpiresAt   time.Time `json:"expiresAt"`
}

// Backend abstracts the OS credential store.
type Backend interface {
	Set(service, account, secret string) error
	Get(service, account string) (string, error)
	Delete(service, account string) error
}

type systemBackend struct{}

func (systemBackend) Set(service, account, secret string) error {
	return keyring.Set(service, account, secret)
}
func (systemBackend) Get(service, account string) (string, error) {
	return keyring.Get(service, account)
}
func (systemBackend) Delete(service, account string) error {
	return keyring.Delete(service, account)
}

// Store persists one current H3Yun session per machine.
type Store struct {
	backend Backend
}

// NewStore returns a Store backed by the operating system credential store.
func NewStore() *Store {
	return &Store{backend: systemBackend{}}
}

// NewStoreWithBackend is used by tests.
func NewStoreWithBackend(backend Backend) *Store {
	return &Store{backend: backend}
}

// Save validates and stores the session.
func (s *Store) Save(ctx context.Context, session Session) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if strings.TrimSpace(session.Token) == "" {
		return errors.New("H3Yun session token is required")
	}
	if strings.TrimSpace(session.EngineCode) == "" || strings.TrimSpace(session.UserID) == "" {
		return errors.New("H3Yun engine code and user id are required")
	}
	encoded, err := json.Marshal(session)
	if err != nil {
		return fmt.Errorf("encode H3Yun session: %w", err)
	}
	if err := s.backend.Set(serviceName, accountName, string(encoded)); err != nil {
		return fmt.Errorf("store H3Yun session in operating system credential store: %w", err)
	}
	return nil
}

// Load returns the stored session.
func (s *Store) Load(ctx context.Context) (Session, error) {
	if err := ctx.Err(); err != nil {
		return Session{}, err
	}
	encoded, err := s.backend.Get(serviceName, accountName)
	if err != nil {
		return Session{}, fmt.Errorf("read H3Yun session from operating system credential store: %w", err)
	}
	var session Session
	if err := json.Unmarshal([]byte(encoded), &session); err != nil {
		return Session{}, fmt.Errorf("decode stored H3Yun session: %w", err)
	}
	return session, nil
}

// Delete removes the stored session.
func (s *Store) Delete(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := s.backend.Delete(serviceName, accountName); err != nil {
		return fmt.Errorf("delete H3Yun session from operating system credential store: %w", err)
	}
	return nil
}
