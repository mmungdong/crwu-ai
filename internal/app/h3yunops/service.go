// Package h3yunops hosts the host-neutral H3Yun application service: it owns
// the personal-access-token source and exposes small, typed operations on top
// of the gateway integration. Transports (CLI, MCP) depend on this package;
// they never touch the integration package directly.
package h3yunops

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/mmungdong/crwu-ai/internal/integrations/h3yun"
)

// Token supplies the employee's H3Yun personal access token. In the future the
// server-side principal mapping (docs/design-h3yun-auth.md) resolves the token
// for the current employee; the environment source is the local dev form.
type Token interface {
	Token(ctx context.Context) (string, error)
}

// EnvToken reads the token from the H3YUN_TOKEN environment variable.
type EnvToken struct {
	Getenv func(string) string
}

func (s EnvToken) Token(_ context.Context) (string, error) {
	getenv := s.Getenv
	if getenv == nil {
		getenv = func(string) string { return "" }
	}
	token := strings.TrimSpace(getenv("H3YUN_TOKEN"))
	if token == "" {
		return "", errors.New("H3YUN_TOKEN is not set; set it to a H3Yun personal access token (个人信息 → 管理凭证 → 新建凭证)")
	}
	return token, nil
}

// Client is the subset of the gateway integration used by this service.
type Client interface {
	Ping(ctx context.Context) (h3yun.ServerInfo, error)
	Tools(ctx context.Context) ([]h3yun.Tool, error)
	CallTool(ctx context.Context, name string, arguments any) (h3yun.Envelope, error)
}

// ClientFactory builds a Client bound to one employee token.
type ClientFactory func(token string) (Client, error)

// RealClientFactory builds clients against the real gateway.
func RealClientFactory(baseURL string) ClientFactory {
	return func(token string) (Client, error) {
		return h3yun.NewClient(h3yun.Config{Token: token, BaseURL: baseURL})
	}
}

// Service executes H3Yun operations for the token owner.
type Service struct {
	Token     Token
	NewClient ClientFactory
}

// EnvService wires a Service from environment configuration: the token comes
// from H3YUN_TOKEN and the gateway base URL from H3YUN_BASE_URL (defaults to
// the official gateway).
func EnvService(getenv func(string) string) *Service {
	baseURL := ""
	if getenv != nil {
		baseURL = strings.TrimSpace(getenv("H3YUN_BASE_URL"))
	}
	return &Service{
		Token:     EnvToken{Getenv: getenv},
		NewClient: RealClientFactory(baseURL),
	}
}

func (s *Service) client(ctx context.Context) (Client, error) {
	if s.Token == nil {
		return nil, errors.New("h3yun token source is required")
	}
	if s.NewClient == nil {
		return nil, errors.New("h3yun client factory is required")
	}
	token, err := s.Token.Token(ctx)
	if err != nil {
		return nil, err
	}
	return s.NewClient(token)
}

// Ping performs the gateway handshake and returns its identity as JSON.
func (s *Service) Ping(ctx context.Context) (json.RawMessage, error) {
	client, err := s.client(ctx)
	if err != nil {
		return nil, err
	}
	info, err := client.Ping(ctx)
	if err != nil {
		return nil, err
	}
	payload, err := json.Marshal(info)
	if err != nil {
		return nil, fmt.Errorf("encode server info: %w", err)
	}
	return payload, nil
}

// Tools lists the gateway tools visible to the token owner as JSON.
func (s *Service) Tools(ctx context.Context) (json.RawMessage, error) {
	client, err := s.client(ctx)
	if err != nil {
		return nil, err
	}
	tools, err := client.Tools(ctx)
	if err != nil {
		return nil, err
	}
	payload, err := json.Marshal(tools)
	if err != nil {
		return nil, fmt.Errorf("encode tool catalog: %w", err)
	}
	return payload, nil
}

// Call invokes one gateway tool with the token owner's identity and returns
// the tool data payload.
func (s *Service) Call(ctx context.Context, tool string, arguments map[string]any) (json.RawMessage, error) {
	if strings.TrimSpace(tool) == "" {
		return nil, errors.New("h3yun tool name is required")
	}
	client, err := s.client(ctx)
	if err != nil {
		return nil, err
	}
	envelope, err := client.CallTool(ctx, tool, arguments)
	if err != nil {
		return nil, err
	}
	if !envelope.OK() {
		return nil, envelope.Error()
	}
	return envelope.Data, nil
}
