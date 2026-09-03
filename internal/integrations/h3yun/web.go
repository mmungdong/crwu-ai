package h3yun

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// This file implements the H3Yun web-console REST client used by the "session"
// channel. The web console authenticates with the short-lived session JWT that
// employees obtain by QR-scanning into https://www.h3yun.com (no password),
// sent as "Authorization: Bearer" plus an "EngineCode" header. Responses use
// the envelope { returnData, successful, errorCode, errorMessage }.

const webBaseURL = "https://www.h3yun.com"

// SessionClaims is the decoded (unsigned) payload of the H3Yun session JWT.
// The CLI decodes it only to read routing/expiry metadata; the gateway verifies
// the signature.
type SessionClaims struct {
	EngineCode   string    `json:"enginecode"`
	ShardKey     string    `json:"shardkey"`
	UserID       string    `json:"userid"`
	AccountType  string    `json:"accounttype"`
	LoginName    string    `json:"loginname"`
	ExpiresHours int64     `json:"expireshours"`
	ExpiresAt    time.Time `json:"-"`
	IssuedAt     time.Time `json:"-"`
	RawExpiresAt int64     `json:"exp"`
	RawIssuedAt  int64     `json:"iat"`
}

// DecodeSessionToken parses the JWT payload without verifying the signature.
func DecodeSessionToken(token string) (SessionClaims, error) {
	parts := strings.Split(strings.TrimSpace(token), ".")
	if len(parts) < 2 {
		return SessionClaims{}, errors.New("not a JWT (expected three dot-separated segments)")
	}
	payload := parts[1]
	if rest := len(payload) % 4; rest != 0 {
		payload += strings.Repeat("=", 4-rest)
	}
	decoded, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(payload, "="))
	if err != nil {
		decoded, err = base64.URLEncoding.DecodeString(payload)
		if err != nil {
			return SessionClaims{}, fmt.Errorf("decode JWT payload: %w", err)
		}
	}
	var claims SessionClaims
	if err := json.Unmarshal(decoded, &claims); err != nil {
		return SessionClaims{}, fmt.Errorf("parse JWT payload: %w", err)
	}
	claims.ExpiresAt = time.Unix(claims.RawExpiresAt, 0)
	claims.IssuedAt = time.Unix(claims.RawIssuedAt, 0)
	if claims.EngineCode == "" || claims.UserID == "" || claims.ExpiresAt.IsZero() {
		return SessionClaims{}, errors.New("JWT payload is missing enginecode, userid, or exp")
	}
	return claims, nil
}

// WebConfig configures the web-console REST client.
type WebConfig struct {
	Token      string
	EngineCode string
	BaseURL    string
	HTTPClient *http.Client
}

// WebClient talks to the H3Yun web-console /v1 REST API.
type WebClient struct {
	token      string
	engineCode string
	baseURL    string
	http       *http.Client
}

// NewWebClient validates the configuration and returns a WebClient.
func NewWebClient(config WebConfig) (*WebClient, error) {
	token := strings.TrimSpace(config.Token)
	if token == "" {
		return nil, errors.New("H3Yun session token is required")
	}
	if strings.TrimSpace(config.EngineCode) == "" {
		return nil, errors.New("H3Yun engine code is required")
	}
	baseURL := strings.TrimRight(strings.TrimSpace(config.BaseURL), "/")
	if baseURL == "" {
		baseURL = webBaseURL
	}
	httpClient := config.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 30 * time.Second}
	}
	return &WebClient{
		token:      token,
		engineCode: strings.TrimSpace(config.EngineCode),
		baseURL:    baseURL,
		http:       httpClient,
	}, nil
}

type webEnvelope struct {
	Successful   bool            `json:"successful"`
	ErrorCode    string          `json:"errorCode"`
	ErrorMessage string          `json:"errorMessage"`
	ReturnData   json.RawMessage `json:"returnData"`
}

func (c *WebClient) call(ctx context.Context, method, path string, body any) (json.RawMessage, error) {
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reader = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, reader)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+c.token)
	request.Header.Set("EngineCode", c.engineCode)

	response, err := c.http.Do(request)
	if err != nil {
		return nil, fmt.Errorf("H3Yun web request: %w", err)
	}
	defer response.Body.Close()
	limited := io.LimitReader(response.Body, 4<<20)
	if response.StatusCode == http.StatusUnauthorized {
		return nil, errors.New("H3Yun web session rejected the token (HTTP 401); re-bind with a fresh session")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		snippet, _ := io.ReadAll(io.LimitReader(response.Body, 512))
		return nil, fmt.Errorf("H3Yun web returned HTTP %d: %s", response.StatusCode, strings.TrimSpace(string(snippet)))
	}
	payload, err := io.ReadAll(limited)
	if err != nil {
		return nil, fmt.Errorf("read H3Yun web response: %w", err)
	}
	var envelope webEnvelope
	if err := json.Unmarshal(payload, &envelope); err != nil {
		return nil, fmt.Errorf("decode H3Yun web response: %w", err)
	}
	if !envelope.Successful {
		message := envelope.ErrorMessage
		if message == "" {
			message = fmt.Sprintf("H3Yun web error %s", envelope.ErrorCode)
		}
		return nil, &WebError{Code: envelope.ErrorCode, Message: message}
	}
	return envelope.ReturnData, nil
}

// WebError is a non-successful web-console response.
type WebError struct {
	Code    string
	Message string
}

func (e *WebError) Error() string {
	if e.Code == "" {
		return "H3Yun web error: " + e.Message
	}
	return fmt.Sprintf("H3Yun web error %s: %s", e.Code, e.Message)
}

// UserInfo returns the current session user payload (raw JSON).
func (c *WebClient) UserInfo(ctx context.Context) (json.RawMessage, error) {
	return c.call(ctx, http.MethodGet, "/v1/user/info", nil)
}

// EngineInfo returns the current engine payload (raw JSON).
func (c *WebClient) EngineInfo(ctx context.Context) (json.RawMessage, error) {
	return c.call(ctx, http.MethodGet, "/v1/engine/info", nil)
}

// ListApps returns the applications visible to the session user (raw JSON).
func (c *WebClient) ListApps(ctx context.Context) (json.RawMessage, error) {
	return c.call(ctx, http.MethodGet, "/v1/functionnode/app/list", nil)
}

// ListChildren returns the function nodes (forms) below one application or
// parent node. nodeTypes, when non-empty, restricts the returned node kinds
// (for example 200 form, 210 flow form).
func (c *WebClient) ListChildren(ctx context.Context, parentCode string, nodeTypes []int) (json.RawMessage, error) {
	if strings.TrimSpace(parentCode) == "" {
		return nil, errors.New("parent application code is required")
	}
	body := map[string]any{"parentCode": strings.TrimSpace(parentCode), "checkHasChild": false}
	if len(nodeTypes) > 0 {
		body["nodeTypes"] = nodeTypes
	}
	return c.call(ctx, http.MethodPost, "/v1/functionnode/children", body)
}

// SearchFunctionNodes searches form function nodes by name keyword.
func (c *WebClient) SearchFunctionNodes(ctx context.Context, keyword string, nodeTypes []int) (json.RawMessage, error) {
	if strings.TrimSpace(keyword) == "" {
		return nil, errors.New("keyword is required")
	}
	body := map[string]any{"keyword": strings.TrimSpace(keyword)}
	if len(nodeTypes) > 0 {
		body["nodeTypes"] = nodeTypes
	}
	return c.call(ctx, http.MethodPost, "/v1/functionnode/list/bykeyword", body)
}

// GetRecord loads one business record including its attachment field values.
func (c *WebClient) GetRecord(ctx context.Context, schemaCode, objectID string) (json.RawMessage, error) {
	if strings.TrimSpace(schemaCode) == "" || strings.TrimSpace(objectID) == "" {
		return nil, errors.New("schema code and object id are required")
	}
	return c.call(ctx, http.MethodPost, "/v1/form/loaddata", map[string]any{
		"schemaCode": strings.TrimSpace(schemaCode),
		"objectId":   strings.TrimSpace(objectID),
	})
}

// QueryRecordsParams are the accepted web-console record query parameters.
type QueryRecordsParams struct {
	SchemaCode   string
	PageIndex    int
	PageSize     int
	Keyword      string
	RequireCount bool
	Filter       map[string]any
}

// QueryRecords queries business records of a form (scope = all visible to the
// session user). Returns the raw row payload.
func (c *WebClient) QueryRecords(ctx context.Context, params QueryRecordsParams) (json.RawMessage, error) {
	if strings.TrimSpace(params.SchemaCode) == "" {
		return nil, errors.New("schema code is required")
	}
	pageSize := params.PageSize
	if pageSize < 1 {
		pageSize = 20
	}
	if pageSize > 100 {
		pageSize = 100
	}
	body := map[string]any{
		"schemaCode":   strings.TrimSpace(params.SchemaCode),
		"pageIndex":    params.PageIndex,
		"pageSize":     pageSize,
		"scope":        4,
		"requireCount": params.RequireCount,
	}
	if strings.TrimSpace(params.Keyword) != "" {
		body["keyword"] = strings.TrimSpace(params.Keyword)
	}
	if params.Filter != nil {
		body["filter"] = params.Filter
	}
	return c.call(ctx, http.MethodPost, "/v1/bizdata/query", body)
}

// DownloadAttachment downloads a record attachment by its file id. The web
// console download path is /Form/Download/?AttachmentID=<id> on the same host,
// authenticated with the session bearer token.
func (c *WebClient) DownloadAttachment(ctx context.Context, attachmentID string) ([]byte, string, error) {
	if strings.TrimSpace(attachmentID) == "" {
		return nil, "", errors.New("attachment id is required")
	}
	url := c.baseURL + "/Form/Download/?AttachmentID=" + url.QueryEscape(strings.TrimSpace(attachmentID))
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, "", err
	}
	request.Header.Set("Authorization", "Bearer "+c.token)
	if c.engineCode != "" {
		request.Header.Set("EngineCode", c.engineCode)
	}
	response, err := c.http.Do(request)
	if err != nil {
		return nil, "", fmt.Errorf("H3Yun attachment download request: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 512))
		return nil, "", fmt.Errorf("H3Yun attachment download returned HTTP %d: %s", response.StatusCode, strings.TrimSpace(string(body)))
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, 512<<20))
	if err != nil {
		return nil, "", fmt.Errorf("read attachment download: %w", err)
	}
	contentType := response.Header.Get("Content-Type")
	if strings.Contains(contentType, "application/json") {
		return nil, "", fmt.Errorf("H3Yun attachment download returned JSON: %s", strings.TrimSpace(string(data)))
	}
	return data, contentType, nil
}

// Refresh exchanges the session token for a fresh one. The endpoint may answer
// with a bare JSON string or { token }.
func (c *WebClient) Refresh(ctx context.Context) (string, error) {
	raw, err := c.call(ctx, http.MethodGet, "/v1/token/refresh", nil)
	if err != nil {
		return "", err
	}
	trimmed := strings.TrimSpace(string(raw))
	if strings.HasPrefix(trimmed, `"`) {
		var token string
		if err := json.Unmarshal(raw, &token); err == nil && token != "" {
			c.token = token
			return token, nil
		}
	}
	var wrapper struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(raw, &wrapper); err == nil && wrapper.Token != "" {
		c.token = wrapper.Token
		return wrapper.Token, nil
	}
	return "", errors.New("H3Yun token refresh returned an unexpected payload")
}
