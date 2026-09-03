package h3yunops

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/mmungdong/crwu-ai/internal/integrations/h3yun"
)

type stubToken struct {
	token string
	err   error
}

func (s stubToken) Token(context.Context) (string, error) { return s.token, s.err }

type fakeClient struct {
	token  string
	name   string
	args   map[string]any
	env    h3yun.Envelope
	err    error
	pinned bool
}

func (f *fakeClient) Ping(context.Context) (h3yun.ServerInfo, error) {
	f.pinned = true
	return h3yun.ServerInfo{Name: "fake-gateway", Version: "1.0.0"}, nil
}

func (f *fakeClient) Tools(context.Context) ([]h3yun.Tool, error) {
	return []h3yun.Tool{{Name: "h3yun_search_apps", Description: "Search apps"}}, nil
}

func (f *fakeClient) CallTool(_ context.Context, name string, arguments any) (h3yun.Envelope, error) {
	f.name = name
	if arguments != nil {
		args, ok := arguments.(map[string]any)
		if !ok {
			return h3yun.Envelope{}, errors.New("arguments are not an object")
		}
		f.args = args
	}
	if f.err != nil {
		return h3yun.Envelope{}, f.err
	}
	return f.env, nil
}

func fakeService(token stubToken, client *fakeClient) *Service {
	return &Service{
		Token: token,
		NewClient: func(t string) (Client, error) {
			client.token = t
			return client, nil
		},
	}
}

func TestCallUsesTokenAndArguments(t *testing.T) {
	fake := &fakeClient{env: h3yun.Envelope{Data: json.RawMessage(`{"total":3}`)}}
	service := fakeService(stubToken{token: "employee-token"}, fake)

	data, err := service.Call(context.Background(), "h3yun_search_apps", map[string]any{
		"keyword": "CRM", "pageIndex": 1, "pageSize": 20,
	})
	if err != nil {
		t.Fatalf("Call() error = %v", err)
	}
	if fake.token != "employee-token" {
		t.Fatalf("client token = %q, want employee-token", fake.token)
	}
	if fake.name != "h3yun_search_apps" {
		t.Fatalf("tool = %q, want h3yun_search_apps", fake.name)
	}
	if fake.args["keyword"] != "CRM" || fake.args["pageIndex"] != 1 {
		t.Fatalf("args = %#v", fake.args)
	}
	if !strings.Contains(string(data), `"total":3`) {
		t.Fatalf("data = %s", data)
	}
}

func TestCallPropagatesTokenSourceError(t *testing.T) {
	fake := &fakeClient{}
	service := fakeService(stubToken{err: errors.New("no token available")}, fake)

	if _, err := service.Call(context.Background(), "h3yun_search_apps", nil); err == nil {
		t.Fatal("Call() error = nil, want token source error")
	}
	if fake.name != "" {
		t.Fatalf("tool call was attempted: %q", fake.name)
	}
}

func TestCallReportsGatewayErrorEnvelope(t *testing.T) {
	fake := &fakeClient{env: h3yun.Envelope{
		ErrorCode:    json.RawMessage(`"Forbidden"`),
		ErrorMessage: "no access to this form",
	}}
	service := fakeService(stubToken{token: "tok"}, fake)

	_, err := service.Call(context.Background(), "h3yun_get_bizobject", nil)
	if err == nil {
		t.Fatal("Call() error = nil, want gateway error")
	}
	if !strings.Contains(err.Error(), "no access to this form") {
		t.Fatalf("Call() error = %v", err)
	}
}

func TestPingReturnsServerInfoJSON(t *testing.T) {
	fake := &fakeClient{}
	service := fakeService(stubToken{token: "tok"}, fake)

	raw, err := service.Ping(context.Background())
	if err != nil {
		t.Fatalf("Ping() error = %v", err)
	}
	var info h3yun.ServerInfo
	if err := json.Unmarshal(raw, &info); err != nil {
		t.Fatalf("Ping() output is not ServerInfo JSON: %v", err)
	}
	if info.Name != "fake-gateway" {
		t.Fatalf("Ping() = %+v", info)
	}
	if !fake.pinned {
		t.Fatal("Ping() did not reach the client")
	}
}

func TestEnvTokenRequiresConfiguration(t *testing.T) {
	source := EnvToken{Getenv: func(string) string { return "" }}
	_, err := source.Token(context.Background())
	if err == nil {
		t.Fatal("Token() error = nil, want missing-token error")
	}
	if !strings.Contains(err.Error(), "H3YUN_TOKEN") {
		t.Fatalf("Token() error = %v, want H3YUN_TOKEN hint", err)
	}
}

func TestEnvTokenReadsVariable(t *testing.T) {
	source := EnvToken{Getenv: func(name string) string {
		if name == "H3YUN_TOKEN" {
			return "abc"
		}
		return ""
	}}
	token, err := source.Token(context.Background())
	if err != nil {
		t.Fatalf("Token() error = %v", err)
	}
	if token != "abc" {
		t.Fatalf("Token() = %q, want abc", token)
	}
}

func TestEnvServiceWiresEnvironment(t *testing.T) {
	service := EnvService(func(name string) string {
		switch name {
		case "H3YUN_TOKEN":
			return "tok"
		case "H3YUN_BASE_URL":
			return "https://example.test/v1/agent/mcp"
		}
		return ""
	})
	if service == nil || service.Token == nil || service.NewClient == nil {
		t.Fatal("EnvService() left dependencies unset")
	}
	token, err := service.Token.Token(context.Background())
	if err != nil || token != "tok" {
		t.Fatalf("token = %q, %v", token, err)
	}
}
