// Package h3yun implements a minimal MCP Streamable HTTP client for the H3Yun
// agent gateway (https://www.h3yun.com/v1/agent/mcp). The gateway is stateless:
// each JSON-RPC request is a single POST and responses arrive as JSON or as a
// single SSE message. Authentication is the employee's H3Yun personal access
// token carried as "Authorization: Bearer".
//
// This package is the only place that knows the gateway wire protocol. It must
// stay free of DingTalk and host concerns.
package h3yun

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// DefaultBaseURL is the H3Yun agent gateway endpoint.
const DefaultBaseURL = "https://www.h3yun.com/v1/agent/mcp"

const (
	initializeMethod    = "initialize"
	toolsListMethod     = "tools/list"
	callToolMethod      = "tools/call"
	protocolVersion     = "2024-11-05"
	clientName          = "crwu"
	clientVersion       = "0.0.1"
	maxResponseBytes    = 8 << 20
	unauthorizedStatus  = http.StatusUnauthorized
	notFoundStatus      = http.StatusNotFound
	statusDenied        = http.StatusForbidden
	defaultRequestScope = 30 * time.Second
)

// ServerInfo describes the gateway after a successful initialize handshake.
type ServerInfo struct {
	Name    string `json:"name"`
	Title   string `json:"title"`
	Version string `json:"version"`
}

// Tool is one tool advertised by the gateway via tools/list.
type Tool struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	InputSchema json.RawMessage `json:"inputSchema,omitempty"`
}

// ToolError is the failure detail reported by the real gateway envelope.
type ToolError struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Retryable *bool  `json:"retryable"`
}

// Envelope is the H3Yun tool result envelope. The real gateway uses
// {status:"success"|"failure", data, error:{code,message,retryable}}; the
// documented legacy shape {errorCode,errorMessage,data} is tolerated too.
type Envelope struct {
	Status       string          `json:"status"`
	Data         json.RawMessage `json:"data"`
	Err          *ToolError      `json:"error"`
	ErrorCode    json.RawMessage `json:"errorCode"`
	ErrorMessage string          `json:"errorMessage"`
}

// codeValue normalizes the legacy errorCode field to its string value,
// tolerating JSON numbers ("0") and JSON strings ("\"0\"" / "\"Forbidden\"").
func (e Envelope) codeValue() string {
	if len(e.ErrorCode) == 0 {
		return ""
	}
	var quoted string
	if err := json.Unmarshal(e.ErrorCode, &quoted); err == nil {
		return strings.TrimSpace(quoted)
	}
	return strings.Trim(strings.TrimSpace(string(e.ErrorCode)), `"`)
}

// OK reports whether the envelope signals success. The real gateway uses
// status "success"; the legacy gateway documents errorCode 0 (or absent) as
// success.
func (e Envelope) OK() bool {
	if e.Status != "" {
		return e.Status == "success"
	}
	code := e.codeValue()
	return code == "" || code == "0"
}

// Error returns a non-nil error when the envelope signals failure.
func (e Envelope) Error() error {
	if e.OK() {
		return nil
	}
	code, message := e.codeValue(), strings.TrimSpace(e.ErrorMessage)
	if e.Err != nil {
		code, message = e.Err.Code, strings.TrimSpace(e.Err.Message)
	}
	if message == "" {
		if code == "" {
			return &GatewayError{Message: "H3Yun gateway reported a failed tool call"}
		}
		message = fmt.Sprintf("H3Yun gateway error code %s", code)
	}
	return &GatewayError{Code: code, Message: message}
}

// GatewayError is a non-zero errorCode reported inside a tool envelope.
type GatewayError struct {
	Code    string
	Message string
}

func (e *GatewayError) Error() string {
	if e.Code == "" {
		return "H3Yun gateway error: " + e.Message
	}
	return fmt.Sprintf("H3Yun gateway error %s: %s", e.Code, e.Message)
}

// Config configures a Client.
type Config struct {
	// Token is the H3Yun personal access token (required).
	Token string
	// BaseURL defaults to DefaultBaseURL.
	BaseURL string
	// Headers are extra headers attached to every gateway request (for example
	// EngineCode routing hints when the gateway needs one).
	Headers map[string]string
	// HTTPClient is optional; a client with a default timeout is created when nil.
	HTTPClient *http.Client
}

// Client talks to the H3Yun agent gateway.
type Client struct {
	token   string
	baseURL string
	headers map[string]string
	http    *http.Client

	mu      sync.Mutex
	nextID  int64
	server  *ServerInfo
	haveSrv bool
}

// NewClient validates the configuration and returns a Client.
func NewClient(config Config) (*Client, error) {
	token := strings.TrimSpace(config.Token)
	if token == "" {
		return nil, errors.New("H3Yun personal access token is required")
	}
	baseURL := strings.TrimRight(strings.TrimSpace(config.BaseURL), "/")
	if baseURL == "" {
		baseURL = DefaultBaseURL
	}
	httpClient := config.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{Timeout: defaultRequestScope}
	}
	headers := make(map[string]string, len(config.Headers))
	for name, value := range config.Headers {
		if trimmed := strings.TrimSpace(name); trimmed != "" {
			headers[trimmed] = strings.TrimSpace(value)
		}
	}
	return &Client{
		token:   token,
		baseURL: baseURL,
		headers: headers,
		http:    httpClient,
		nextID:  1,
	}, nil
}

// ServerURL returns the configured gateway URL.
func (c *Client) ServerURL() string { return c.baseURL }

// Ping performs the MCP initialize handshake and returns the gateway identity.
func (c *Client) Ping(ctx context.Context) (ServerInfo, error) {
	result, err := c.rpc(ctx, initializeMethod, map[string]any{
		"protocolVersion": protocolVersion,
		"capabilities":    map[string]any{},
		"clientInfo": map[string]string{
			"name":    clientName,
			"version": clientVersion,
		},
	})
	if err != nil {
		return ServerInfo{}, err
	}
	var payload struct {
		ProtocolVersion string     `json:"protocolVersion"`
		ServerInfo      ServerInfo `json:"serverInfo"`
	}
	if err := json.Unmarshal(result, &payload); err != nil {
		return ServerInfo{}, fmt.Errorf("decode initialize result: %w", err)
	}
	if payload.ServerInfo.Name == "" {
		return ServerInfo{}, errors.New("initialize result did not include serverInfo")
	}
	c.mu.Lock()
	c.server = &payload.ServerInfo
	c.haveSrv = true
	c.mu.Unlock()
	return payload.ServerInfo, nil
}

// Tools lists the tools advertised by the gateway.
func (c *Client) Tools(ctx context.Context) ([]Tool, error) {
	result, err := c.rpc(ctx, toolsListMethod, map[string]any{})
	if err != nil {
		return nil, err
	}
	var payload struct {
		Tools []Tool `json:"tools"`
	}
	if err := json.Unmarshal(result, &payload); err != nil {
		return nil, fmt.Errorf("decode tools/list result: %w", err)
	}
	return payload.Tools, nil
}

// CallTool invokes one gateway tool and returns its envelope. A non-zero
// errorCode is returned as a *GatewayError.
func (c *Client) CallTool(ctx context.Context, name string, arguments any) (Envelope, error) {
	params := map[string]any{"name": name}
	if arguments != nil {
		params["arguments"] = arguments
	}
	result, err := c.rpc(ctx, callToolMethod, params)
	if err != nil {
		return Envelope{}, err
	}

	var callResult struct {
		Structured json.RawMessage `json:"structuredContent"`
		IsError    bool            `json:"isError"`
		Content    []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	}
	if err := json.Unmarshal(result, &callResult); err != nil {
		return Envelope{}, fmt.Errorf("decode tools/call result: %w", err)
	}

	envelope := Envelope{}
	candidates := make([]json.RawMessage, 0, 2)
	if len(callResult.Structured) > 0 && !bytes.Equal(bytes.TrimSpace(callResult.Structured), []byte("null")) {
		candidates = append(candidates, callResult.Structured)
	}
	for _, part := range callResult.Content {
		if part.Type == "text" && strings.TrimSpace(part.Text) != "" {
			candidates = append(candidates, json.RawMessage(part.Text))
		}
	}
	for _, candidate := range candidates {
		var parsed Envelope
		if err := json.Unmarshal(candidate, &parsed); err == nil {
			envelope = parsed
			break
		}
	}
	if err := envelope.Error(); err != nil {
		return envelope, err
	}
	if callResult.IsError {
		fallback := "H3Yun gateway tool call failed"
		if len(candidates) > 0 {
			trimmed := strings.TrimSpace(string(candidates[0]))
			if trimmed != "" {
				fallback = trimmed
			}
		}
		return envelope, &GatewayError{Message: fallback}
	}
	if envelope.Data == nil {
		envelope.Data = json.RawMessage("null")
	}
	return envelope, nil
}

type rpcEnvelope struct {
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func (c *Client) rpc(ctx context.Context, method string, params any) (json.RawMessage, error) {
	c.mu.Lock()
	id := c.nextID
	c.nextID++
	c.mu.Unlock()

	body, err := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"method":  method,
	})
	if err != nil {
		return nil, err
	}
	message := map[string]any{}
	if err := json.Unmarshal(body, &message); err != nil {
		return nil, err
	}
	message["params"] = params
	body, err = json.Marshal(message)
	if err != nil {
		return nil, err
	}

	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json, text/event-stream")
	request.Header.Set("Authorization", "Bearer "+c.token)
	for name, value := range c.headers {
		request.Header.Set(name, value)
	}

	response, err := c.http.Do(request)
	if err != nil {
		return nil, fmt.Errorf("H3Yun gateway request: %w", err)
	}
	defer response.Body.Close()

	payload, err := readResponseBody(response)
	if err != nil {
		return nil, err
	}

	var decoded rpcEnvelope
	if err := json.Unmarshal(payload, &decoded); err != nil {
		return nil, fmt.Errorf("decode H3Yun gateway response: %w", err)
	}
	if decoded.Error != nil {
		return nil, fmt.Errorf("H3Yun gateway RPC error %d: %s", decoded.Error.Code, decoded.Error.Message)
	}
	if len(decoded.Result) == 0 {
		return nil, errors.New("H3Yun gateway response did not include a result")
	}
	return decoded.Result, nil
}

// readResponseBody performs the SSE/data extraction when needed and enforces a
// bounded read and clear errors for authentication failures.
func readResponseBody(response *http.Response) ([]byte, error) {
	if response.StatusCode == unauthorizedStatus || response.StatusCode == statusDenied {
		status := http.StatusText(response.StatusCode)
		if status == "" {
			status = fmt.Sprintf("%d", response.StatusCode)
		}
		return nil, errors.New("H3Yun gateway rejected the personal access token (HTTP " + status + ")")
	}
	if response.StatusCode == notFoundStatus {
		return nil, fmt.Errorf("H3Yun gateway endpoint not found (HTTP %d); check the base URL", response.StatusCode)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		limited, _ := io.ReadAll(io.LimitReader(response.Body, 512))
		return nil, fmt.Errorf("H3Yun gateway returned HTTP %d: %s", response.StatusCode, strings.TrimSpace(string(limited)))
	}

	body, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes))
	if err != nil {
		return nil, fmt.Errorf("read H3Yun gateway response: %w", err)
	}
	contentType := response.Header.Get("Content-Type")
	if !strings.Contains(contentType, "text/event-stream") {
		return body, nil
	}
	lines := strings.Split(string(body), "\n")
	var data strings.Builder
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "data:") {
			value := strings.TrimSpace(strings.TrimPrefix(trimmed, "data:"))
			if value == "" {
				continue
			}
			data.WriteString(value)
		}
	}
	if data.Len() == 0 {
		return nil, errors.New("H3Yun gateway returned an empty SSE stream")
	}
	return []byte(data.String()), nil
}
