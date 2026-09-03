// Package h3yunlogin implements the host-neutral employee login use case used by
// CLI and future MCP transports.
package h3yunlogin

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/mmungdong/crwu-ai/internal/auth"
)

type State string

const (
	StatePending       State = "pending"
	StateAuthenticated State = "authenticated"
	StateFailed        State = "failed"
)

var (
	ErrAuthorizationFailed = errors.New("employee authorization failed")
	ErrFlowExpired         = errors.New("login flow expired")
)

type Flow struct {
	ID               string
	AuthorizationURL string
	ExpiresAt        time.Time
	PollAfter        time.Duration
}

type PollResult struct {
	State        State
	Principal    auth.Principal
	Session      auth.Session
	ErrorCode    string
	ErrorMessage string
}

type Gateway interface {
	Start(ctx context.Context, serverURL string) (Flow, error)
	Poll(ctx context.Context, serverURL, flowID string) (PollResult, error)
}

type URLOpener interface {
	Open(value string) error
}

type Request struct {
	ServerURL               string
	OpenBrowser             bool
	OnAuthorizationRequired func(authorizationURL string)
}

type Result struct {
	Principal auth.Principal
	ExpiresAt time.Time
}

type Service struct {
	Gateway  Gateway
	Opener   URLOpener
	Sessions auth.SessionStore
	Now      func() time.Time
	Wait     func(context.Context, time.Duration) error
}

func (s Service) Login(ctx context.Context, request Request) (Result, error) {
	if s.Gateway == nil {
		return Result{}, errors.New("login gateway is required")
	}
	if s.Sessions == nil {
		return Result{}, errors.New("session store is required")
	}

	flow, err := s.Gateway.Start(ctx, request.ServerURL)
	if err != nil {
		return Result{}, fmt.Errorf("start login: %w", err)
	}
	if request.OnAuthorizationRequired != nil {
		request.OnAuthorizationRequired(flow.AuthorizationURL)
	}
	if request.OpenBrowser && s.Opener != nil {
		if err := s.Opener.Open(flow.AuthorizationURL); err != nil {
			return Result{}, fmt.Errorf("open authorization URL: %w", err)
		}
	}

	now := s.Now
	if now == nil {
		now = time.Now
	}
	wait := s.Wait
	if wait == nil {
		wait = waitContext
	}
	pollAfter := flow.PollAfter
	if pollAfter <= 0 {
		pollAfter = 2 * time.Second
	}

	for {
		if !flow.ExpiresAt.IsZero() && !now().Before(flow.ExpiresAt) {
			return Result{}, ErrFlowExpired
		}

		poll, err := s.Gateway.Poll(ctx, request.ServerURL, flow.ID)
		if err != nil {
			return Result{}, fmt.Errorf("poll login: %w", err)
		}
		switch poll.State {
		case StatePending:
			if err := wait(ctx, pollAfter); err != nil {
				return Result{}, err
			}
		case StateAuthenticated:
			poll.Session.Principal = poll.Principal
			if err := s.Sessions.Save(ctx, request.ServerURL, poll.Session); err != nil {
				return Result{}, fmt.Errorf("store CRWU session: %w", err)
			}
			return Result{Principal: poll.Principal, ExpiresAt: poll.Session.ExpiresAt}, nil
		case StateFailed:
			message := poll.ErrorMessage
			if message == "" {
				message = "DingTalk authorization did not complete"
			}
			return Result{}, fmt.Errorf("%w: %s (%s)", ErrAuthorizationFailed, message, poll.ErrorCode)
		default:
			return Result{}, fmt.Errorf("unsupported login state %q", poll.State)
		}
	}
}

func waitContext(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
