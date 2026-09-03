package auth

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/zalando/go-keyring"
)

const keyringService = "crwu"

type keyringBackend interface {
	Set(service, account, secret string) error
	Get(service, account string) (string, error)
	Delete(service, account string) error
}

type systemKeyring struct{}

func (systemKeyring) Set(service, account, secret string) error {
	return keyring.Set(service, account, secret)
}

func (systemKeyring) Get(service, account string) (string, error) {
	return keyring.Get(service, account)
}

func (systemKeyring) Delete(service, account string) error {
	return keyring.Delete(service, account)
}

type KeyringStore struct {
	backend keyringBackend
}

func NewKeyringStore() *KeyringStore {
	return newKeyringStore(systemKeyring{})
}

func newKeyringStore(backend keyringBackend) *KeyringStore {
	return &KeyringStore{backend: backend}
}

func (s *KeyringStore) Save(ctx context.Context, serverURL string, session Session) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if strings.TrimSpace(serverURL) == "" {
		return errors.New("CRWU server URL is required")
	}
	if session.AccessToken == "" || session.ExpiresAt.IsZero() {
		return errors.New("CRWU session token and expiry are required")
	}
	principal := session.Principal
	if principal.Provider != "dingtalk" || principal.CorpID == "" || principal.UserID == "" || principal.UnionID == "" || principal.OpenID == "" {
		return errors.New("explicit DingTalk principal is required")
	}
	encoded, err := json.Marshal(session)
	if err != nil {
		return fmt.Errorf("encode CRWU session: %w", err)
	}
	if err := s.backend.Set(keyringService, sessionAccount(serverURL), string(encoded)); err != nil {
		return fmt.Errorf("save CRWU session in operating system credential store: %w", err)
	}
	return nil
}

func (s *KeyringStore) Load(ctx context.Context, serverURL string) (Session, error) {
	if err := ctx.Err(); err != nil {
		return Session{}, err
	}
	encoded, err := s.backend.Get(keyringService, sessionAccount(serverURL))
	if err != nil {
		return Session{}, fmt.Errorf("read CRWU session from operating system credential store: %w", err)
	}
	var session Session
	if err := json.Unmarshal([]byte(encoded), &session); err != nil {
		return Session{}, fmt.Errorf("decode stored CRWU session: %w", err)
	}
	return session, nil
}

func (s *KeyringStore) Delete(ctx context.Context, serverURL string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := s.backend.Delete(keyringService, sessionAccount(serverURL)); err != nil {
		return fmt.Errorf("delete CRWU session from operating system credential store: %w", err)
	}
	return nil
}

func sessionAccount(serverURL string) string {
	digest := sha256.Sum256([]byte(strings.TrimRight(strings.TrimSpace(serverURL), "/")))
	return "h3yun:" + hex.EncodeToString(digest[:])
}
