// Package h3yunweb is the application service behind the CLI "session"
// channel: it binds, stores, refreshes, and clears the employee's H3Yun
// web-console session and executes read operations as that employee.
package h3yunweb

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/mmungdong/crwu-ai/internal/integrations/h3yun"
	"github.com/mmungdong/crwu-ai/internal/platform/h3yuncreds"
	"github.com/mmungdong/crwu-ai/internal/platform/scanlogin"
)

// Session aliases the stored credential type.
type Session = h3yuncreds.Session

// Store persists the current session.
type Store interface {
	Save(ctx context.Context, session Session) error
	Load(ctx context.Context) (Session, error)
	Delete(ctx context.Context) error
}

// Client is the web-console REST surface used by this service.
type Client interface {
	UserInfo(ctx context.Context) (json.RawMessage, error)
	EngineInfo(ctx context.Context) (json.RawMessage, error)
	ListApps(ctx context.Context) (json.RawMessage, error)
	ListChildren(ctx context.Context, parentCode string, nodeTypes []int) (json.RawMessage, error)
	SearchFunctionNodes(ctx context.Context, keyword string, nodeTypes []int) (json.RawMessage, error)
	QueryRecords(ctx context.Context, params h3yun.QueryRecordsParams) (json.RawMessage, error)
	GetRecord(ctx context.Context, schemaCode, objectID string) (json.RawMessage, error)
	DownloadAttachment(ctx context.Context, attachmentID string) ([]byte, string, error)
	Refresh(ctx context.Context) (string, error)
}

// ClientFactory builds a Client for one session and engine.
type ClientFactory func(token, engineCode string) (Client, error)

// RealClientFactory builds clients against the real web console.
func RealClientFactory(baseURL string) ClientFactory {
	return func(token, engineCode string) (Client, error) {
		return h3yun.NewWebClient(h3yun.WebConfig{Token: token, EngineCode: engineCode, BaseURL: baseURL})
	}
}

// Service executes session-channel operations for the stored employee.
type Service struct {
	Store     Store
	NewClient ClientFactory
	Now       func() time.Time
	BaseURL   string
	// Capturer captures a fresh employee web session via the local browser.
	// Set by EnvService; nil disables `session login`.
	Capturer func(ctx context.Context) (string, error)
}

// EnvService wires a Service from environment configuration (base URL from
// H3YUN_BASE_URL, defaulting to the official console).
func EnvService(getenv func(string) string) *Service {
	baseURL := ""
	if getenv != nil {
		baseURL = strings.TrimSpace(getenv("H3YUN_BASE_URL"))
	}
	browser := ""
	if getenv != nil {
		browser = strings.TrimSpace(getenv("CRWU_BROWSER"))
	}
	return &Service{
		Store:     h3yuncreds.NewStore(),
		NewClient: RealClientFactory(baseURL),
		BaseURL:   baseURL,
		Capturer: func(ctx context.Context) (string, error) {
			return scanlogin.Capture(ctx, scanlogin.Config{BrowserPath: browser})
		},
	}
}

func accountTypeString(value any) string {
	if value == nil {
		return ""
	}
	if text, ok := value.(string); ok {
		return text
	}
	return fmt.Sprintf("%v", value)
}

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

func (s *Service) client(ctx context.Context) (Client, Session, error) {
	if s.Store == nil {
		return nil, Session{}, errors.New("h3yun session store is required")
	}
	if s.NewClient == nil {
		return nil, Session{}, errors.New("h3yun web client factory is required")
	}
	session, err := s.Store.Load(ctx)
	if err != nil {
		return nil, Session{}, fmt.Errorf("no H3Yun session bound: %w", err)
	}
	client, err := s.NewClient(session.Token, session.EngineCode)
	if err != nil {
		return nil, Session{}, err
	}
	return client, session, nil
}

// Bind decodes the pasted session JWT, validates it, and stores it.
func (s *Service) Bind(ctx context.Context, rawToken string) (Session, error) {
	token := strings.TrimSpace(rawToken)
	token = strings.TrimPrefix(token, "Bearer ")
	token = strings.TrimPrefix(token, "bearer ")
	if token == "" {
		return Session{}, errors.New("H3Yun session token is required")
	}
	claims, err := h3yun.DecodeSessionToken(token)
	if err != nil {
		return Session{}, err
	}
	if s.now().After(claims.ExpiresAt) {
		return Session{}, errors.New("the session token has already expired; scan again at h3yun.com")
	}
	session := Session{
		EngineCode:  claims.EngineCode,
		ShardKey:    claims.ShardKey,
		UserID:      claims.UserID,
		AccountType: accountTypeString(claims.AccountType),
		Token:       token,
		ExpiresAt:   claims.ExpiresAt,
	}
	if err := s.Store.Save(ctx, session); err != nil {
		return Session{}, err
	}
	return session, nil
}

// Status reports the stored session.
func (s *Service) Status(ctx context.Context) (Session, error) {
	if s.Store == nil {
		return Session{}, errors.New("h3yun session store is required")
	}
	return s.Store.Load(ctx)
}

// Clear removes the stored session.
func (s *Service) Clear(ctx context.Context) error {
	if s.Store == nil {
		return errors.New("h3yun session store is required")
	}
	return s.Store.Delete(ctx)
}

// Refresh renews the session token and re-stores it.
func (s *Service) Refresh(ctx context.Context) (Session, error) {
	client, session, err := s.client(ctx)
	if err != nil {
		return Session{}, err
	}
	newToken, err := client.Refresh(ctx)
	if err != nil {
		return Session{}, err
	}
	claims, err := h3yun.DecodeSessionToken(newToken)
	if err != nil {
		return Session{}, fmt.Errorf("refreshed token could not be parsed: %w", err)
	}
	if s.now().After(claims.ExpiresAt) {
		return Session{}, errors.New("refreshed session token is already expired")
	}
	session.Token = newToken
	session.ExpiresAt = claims.ExpiresAt
	if claims.EngineCode != "" {
		session.EngineCode = claims.EngineCode
	}
	if claims.ShardKey != "" {
		session.ShardKey = claims.ShardKey
	}
	if err := s.Store.Save(ctx, session); err != nil {
		return Session{}, err
	}
	return session, nil
}

// Apps lists the applications visible to the session user, optionally filtered
// by a keyword against the display name or code.
func (s *Service) Apps(ctx context.Context, keyword string) (json.RawMessage, error) {
	client, _, err := s.client(ctx)
	if err != nil {
		return nil, err
	}
	raw, err := client.ListApps(ctx)
	if err != nil {
		return nil, err
	}
	keyword = strings.ToLower(strings.TrimSpace(keyword))
	if keyword == "" {
		return raw, nil
	}
	var apps []json.RawMessage
	if err := json.Unmarshal(raw, &apps); err != nil {
		return nil, fmt.Errorf("decode application list: %w", err)
	}
	kept := make([]json.RawMessage, 0, len(apps))
	for _, app := range apps {
		var meta struct {
			DisplayName string `json:"displayName"`
			Code        string `json:"code"`
			AppCode     string `json:"appCode"`
		}
		if err := json.Unmarshal(app, &meta); err != nil {
			continue
		}
		if strings.Contains(strings.ToLower(meta.DisplayName), keyword) ||
			strings.Contains(strings.ToLower(meta.Code), keyword) ||
			strings.Contains(strings.ToLower(meta.AppCode), keyword) {
			kept = append(kept, app)
		}
	}
	payload, err := json.Marshal(kept)
	if err != nil {
		return nil, err
	}
	return payload, nil
}

// Children lists the function nodes (forms) below one application.
func (s *Service) Children(ctx context.Context, appCode string) (json.RawMessage, error) {
	client, _, err := s.client(ctx)
	if err != nil {
		return nil, err
	}
	return client.ListChildren(ctx, appCode, nil)
}

// SearchForms searches form function nodes by name keyword.
func (s *Service) SearchForms(ctx context.Context, keyword string) (json.RawMessage, error) {
	client, _, err := s.client(ctx)
	if err != nil {
		return nil, err
	}
	return client.SearchFunctionNodes(ctx, keyword, nil)
}

// Records queries business records of a form for the session user. filter is
// the --filter expression (syntax documented in docs/cli-manual.md §5); an
// empty filter means no field condition.
func (s *Service) Records(ctx context.Context, schemaCode string, pageIndex, pageSize int, keyword, filter string) (json.RawMessage, error) {
	client, _, err := s.client(ctx)
	if err != nil {
		return nil, err
	}
	params := h3yun.QueryRecordsParams{
		SchemaCode:   schemaCode,
		PageIndex:    pageIndex,
		PageSize:     pageSize,
		Keyword:      keyword,
		RequireCount: true,
	}
	if strings.TrimSpace(filter) != "" {
		built, err := h3yun.BuildFilter(schemaCode, filter)
		if err != nil {
			return nil, fmt.Errorf("invalid record filter: %w", err)
		}
		params.Filter = built
	}
	return client.QueryRecords(ctx, params)
}

// RecordsGet loads one business record row (filtered query, the same source
// the web console detail page uses).
func (s *Service) RecordsGet(ctx context.Context, schemaCode, objectID string) (json.RawMessage, error) {
	rows, err := s.recordRows(ctx, schemaCode, objectID)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, errors.New("record not found")
	}
	return rows[0], nil
}

// recordRows queries one record row via the ObjectId filter (the web console
// detail source). loaddata returns a designer preview shell and is not used for
// reads here.
func (s *Service) recordRows(ctx context.Context, schemaCode, objectID string) ([]json.RawMessage, error) {
	client, _, err := s.client(ctx)
	if err != nil {
		return nil, err
	}
	raw, err := client.QueryRecords(ctx, h3yun.QueryRecordsParams{
		SchemaCode:   schemaCode,
		PageIndex:    0,
		PageSize:     1,
		RequireCount: false,
		Filter: map[string]any{
			"matcher": map[string]any{
				"type": "And",
				"matchers": []any{
					map[string]any{
						"type":     "Item",
						"name":     schemaCode + ".ObjectId",
						"operator": "In",
						"value":    []string{objectID},
						"matchers": []any{},
					},
				},
			},
		},
	})
	if err != nil {
		return nil, err
	}
	if !json.Valid(raw) {
		return nil, errors.New("record query returned invalid JSON")
	}
	if raw == nil {
		return nil, nil
	}
	// returnData may be the row array directly or wrapped.
	var array []json.RawMessage
	if err := json.Unmarshal(raw, &array); err == nil {
		return array, nil
	}
	var wrapped struct {
		ReturnData []json.RawMessage `json:"returnData"`
	}
	if err := json.Unmarshal(raw, &wrapped); err == nil {
		return wrapped.ReturnData, nil
	}
	return nil, fmt.Errorf("unexpected record query payload: %.120s", raw)
}

// Attachment describes one file inside a record.
type Attachment struct {
	Field       string `json:"field"`
	FileID      string `json:"fileId"`
	FileName    string `json:"fileName"`
	FileSize    string `json:"fileSize"`
	ContentType string `json:"contentType"`
	DownloadURL string `json:"downloadUrl"`
}

// Files lists the attachment fields of one record.
func (s *Service) Files(ctx context.Context, schemaCode, objectID string) ([]Attachment, error) {
	rows, err := s.recordRows(ctx, schemaCode, objectID)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, errors.New("record not found")
	}
	var row map[string]json.RawMessage
	if err := json.Unmarshal(rows[0], &row); err != nil {
		return nil, err
	}
	var out []Attachment
	for field, raw := range row {
		if field == "" || field == "ObjectId" {
			continue
		}
		var items []struct {
			FileID      string `json:"FileId"`
			ObjectID    string `json:"ObjectId"`
			FileName    string `json:"FileName"`
			FileSize    string `json:"FileSize"`
			ContentType string `json:"ContentType"`
			URL         string `json:"Url"`
		}
		if err := json.Unmarshal(raw, &items); err != nil || len(items) == 0 {
			continue
		}
		for _, it := range items {
			id := it.FileID
			if id == "" {
				id = it.ObjectID
			}
			if id == "" || it.FileName == "" {
				continue
			}
			out = append(out, Attachment{
				Field:       field,
				FileID:      id,
				FileName:    it.FileName,
				FileSize:    it.FileSize,
				ContentType: it.ContentType,
				DownloadURL: it.URL,
			})
		}
	}
	return out, nil
}

// Download saves every attachment of one record into outDir and returns the
// list of written file paths.
func (s *Service) Download(ctx context.Context, schemaCode, objectID, outDir string) ([]string, error) {
	files, err := s.Files(ctx, schemaCode, objectID)
	if err != nil {
		return nil, err
	}
	if len(files) == 0 {
		return nil, errors.New("record has no attachments")
	}
	client, _, err := s.client(ctx)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return nil, fmt.Errorf("create output directory: %w", err)
	}
	used := map[string]bool{}
	var written []string
	for _, file := range files {
		data, _, err := client.DownloadAttachment(ctx, file.FileID)
		if err != nil {
			return written, fmt.Errorf("download %q (%s): %w", file.FileName, file.FileID, err)
		}
		name := file.FileName
		if name == "" {
			name = file.FileID + ".bin"
		}
		path := uniquePath(outDir, name, used)
		if err := os.WriteFile(path, data, 0o644); err != nil {
			return written, err
		}
		used[path] = true
		written = append(written, path)
	}
	return written, nil
}

// DownloadOne downloads a single record attachment by file id and writes it to
// outPath. It never lists or downloads the record's other attachments — this is
// the primitive the audit phase-1 isolation gate relies on (review-record files
// must not be fetched).
func (s *Service) DownloadOne(ctx context.Context, fileID, outPath string) error {
	if strings.TrimSpace(fileID) == "" {
		return errors.New("attachment file id is required")
	}
	if strings.TrimSpace(outPath) == "" {
		return errors.New("output file path is required")
	}
	client, _, err := s.client(ctx)
	if err != nil {
		return err
	}
	data, _, err := client.DownloadAttachment(ctx, strings.TrimSpace(fileID))
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(outPath), 0o755); err != nil {
		return fmt.Errorf("create output directory: %w", err)
	}
	if err := os.WriteFile(outPath, data, 0o644); err != nil {
		return err
	}
	return nil
}

func uniquePath(dir, name string, used map[string]bool) string {
	candidate := filepath.Join(dir, filepath.Base(name))
	if !used[candidate] {
		return candidate
	}
	ext := filepath.Ext(name)
	stem := strings.TrimSuffix(filepath.Base(name), ext)
	for i := 2; ; i++ {
		candidate = filepath.Join(dir, fmt.Sprintf("%s(%d)%s", stem, i, ext))
		if !used[candidate] {
			return candidate
		}
	}
}

// Login captures a fresh employee session through the local browser (QR scan)
// Login captures a fresh employee session through the local browser (QR scan)
// and binds it. The session token is captured in-process and never printed.
func (s *Service) Login(ctx context.Context, onStatus func(string)) (Session, error) {
	if s.Capturer == nil {
		return Session{}, errors.New("interactive browser login is unavailable")
	}
	if onStatus != nil {
		onStatus("正在打开浏览器窗口，请用钉钉扫码登录氚云（无需密码）…")
	}
	token, err := s.Capturer(ctx)
	if err != nil {
		return Session{}, err
	}
	session, err := s.Bind(ctx, token)
	if err != nil {
		return Session{}, err
	}
	if onStatus != nil {
		onStatus("会话已获取并写入本机凭据存储（令牌未显示、未外传）。")
	}
	return session, nil
}

// WhoAmI returns the session user payload.
// WhoAmI returns the session user payload.
func (s *Service) WhoAmI(ctx context.Context) (json.RawMessage, error) {
	client, _, err := s.client(ctx)
	if err != nil {
		return nil, err
	}
	return client.UserInfo(ctx)
}
