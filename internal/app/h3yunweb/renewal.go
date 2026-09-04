package h3yunweb

import (
	"context"
	"errors"
	"fmt"
	"time"
)

// autoRenewThreshold triggers a silent refresh when the remaining session time
// drops to or below this duration.
const autoRenewThreshold = 24 * time.Hour

// EnsureFresh renews the bound session when it is at or near expiry. It is
// called by the CLI middleware before employee-scope read commands so users
// never hit an expired session in normal use.
func (s *Service) EnsureFresh(ctx context.Context) error {
	if s.Store == nil {
		return errors.New("h3yun session store is required")
	}
	session, err := s.Store.Load(ctx)
	if err != nil {
		return errors.New("no H3Yun session bound; run `crwu h3yun session login` to bind one")
	}
	now := s.now()
	if !now.Before(session.ExpiresAt) {
		return errors.New("H3Yun session expired; run `crwu h3yun session login` to re-scan and re-bind")
	}
	if now.Before(session.ExpiresAt.Add(-autoRenewThreshold)) {
		return nil // plenty of time left; nothing to do
	}
	if _, err := s.Refresh(ctx); err != nil {
		return fmt.Errorf("H3Yun session auto-refresh failed: %w", err)
	}
	return nil
}
