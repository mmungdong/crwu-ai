package h3yunweb

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/mmungdong/crwu-ai/internal/integrations/h3yun"
	"github.com/mmungdong/crwu-ai/internal/platform/h3yuncreds"
)

// testToken builds an unsigned-shaped JWT (payload only matters for parsing).
func testToken(engine, user string, exp int64) string {
	payload, _ := json.Marshal(map[string]any{
		"enginecode":  engine,
		"shardkey":    "Vessel15",
		"userid":      user,
		"accounttype": "DingId",
		"exp":         exp,
		"iat":         exp - 48*3600,
	})
	enc := base64.RawURLEncoding.EncodeToString(payload)
	return "header." + enc + ".sig"
}

type fakeStore struct {
	session h3yuncreds.Session
	exists  bool
}

func (f *fakeStore) Save(_ context.Context, session h3yuncreds.Session) error {
	f.session, f.exists = session, true
	return nil
}

func (f *fakeStore) Load(context.Context) (h3yuncreds.Session, error) {
	if !f.exists {
		return h3yuncreds.Session{}, errors.New("no session bound")
	}
	return f.session, nil
}

func (f *fakeStore) Delete(context.Context) error {
	f.session, f.exists = h3yuncreds.Session{}, false
	return nil
}

type fakeClient struct {
	token     string
	engine    string
	apps      json.RawMessage
	children  json.RawMessage
	forms     json.RawMessage
	records   json.RawMessage
	record    json.RawMessage
	refresh   string
	lastQuery h3yun.QueryRecordsParams
}

func (f *fakeClient) UserInfo(context.Context) (json.RawMessage, error) {
	return json.RawMessage(`{"name":"Alice"}`), nil
}
func (f *fakeClient) EngineInfo(context.Context) (json.RawMessage, error) {
	return json.RawMessage(`{"engineCode":"eng"}`), nil
}
func (f *fakeClient) ListApps(context.Context) (json.RawMessage, error) { return f.apps, nil }
func (f *fakeClient) ListChildren(context.Context, string, []int) (json.RawMessage, error) {
	return f.children, nil
}
func (f *fakeClient) SearchFunctionNodes(context.Context, string, []int) (json.RawMessage, error) {
	return f.forms, nil
}
func (f *fakeClient) QueryRecords(ctx context.Context, params h3yun.QueryRecordsParams) (json.RawMessage, error) {
	f.lastQuery = params
	return f.records, nil
}
func (f *fakeClient) GetRecord(context.Context, string, string) (json.RawMessage, error) {
	return f.record, nil
}
func (f *fakeClient) DownloadAttachment(context.Context, string) ([]byte, string, error) {
	return []byte("PK file"), "application/test", nil
}
func (f *fakeClient) Refresh(context.Context) (string, error) {
	if f.refresh == "" {
		return "fresh", nil
	}
	return f.refresh, nil
}

func testService(store *fakeStore, client *fakeClient) *Service {
	return &Service{
		Store: store,
		NewClient: func(token, engine string) (Client, error) {
			client.token, client.engine = token, engine
			return client, nil
		},
	}
}

func TestBindStoresParsedSession(t *testing.T) {
	store := &fakeStore{}
	service := testService(store, &fakeClient{})
	now := time.Now()
	service.Now = func() time.Time { return now }
	token := testToken("eng-1", "u1", now.Add(24*time.Hour).Unix())

	session, err := service.Bind(context.Background(), token)
	if err != nil {
		t.Fatalf("Bind() error = %v", err)
	}
	if session.EngineCode != "eng-1" || session.UserID != "u1" {
		t.Fatalf("session = %+v", session)
	}
	if !store.exists {
		t.Fatal("Bind() did not store the session")
	}
	if store.session.Token != token {
		t.Fatal("stored token differs from bound token")
	}
}

func TestBindRejectsExpiredToken(t *testing.T) {
	service := testService(&fakeStore{}, &fakeClient{})
	now := time.Now()
	service.Now = func() time.Time { return now }
	token := testToken("eng-1", "u1", now.Add(-time.Hour).Unix())
	if _, err := service.Bind(context.Background(), token); err == nil {
		t.Fatal("Bind() error = nil, want expired-token error")
	}
}

func TestAppsFiltersByKeyword(t *testing.T) {
	store := &fakeStore{exists: true, session: h3yuncreds.Session{Token: "t", EngineCode: "e"}}
	client := &fakeClient{apps: json.RawMessage(`[
		{"code":"Aeed1","displayName":"瑞联项目管理系统","appCode":"Aeed1"},
		{"code":"D1494","displayName":"投标报价","appCode":"D1494"}
	]`)}
	service := testService(store, client)

	data, err := service.Apps(context.Background(), "项目")
	if err != nil {
		t.Fatalf("Apps() error = %v", err)
	}
	if !strings.Contains(string(data), "Aeed1") || strings.Contains(string(data), "D1494") {
		t.Fatalf("data = %s", data)
	}
	if client.token != "t" || client.engine != "e" {
		t.Fatalf("client bound with token=%q engine=%q", client.token, client.engine)
	}
}

func TestAppsRequiresBoundSession(t *testing.T) {
	service := testService(&fakeStore{}, &fakeClient{})
	if _, err := service.Apps(context.Background(), ""); err == nil {
		t.Fatal("Apps() error = nil, want no-session error")
	}
}

func TestRecordsPassesFilterToQuery(t *testing.T) {
	store := &fakeStore{exists: true, session: h3yuncreds.Session{Token: "t", EngineCode: "e"}}
	client := &fakeClient{records: json.RawMessage(`{"returnData":[]}`)}
	service := testService(store, client)

	data, err := service.Records(context.Background(), "Syx1", 1, 20, "客户", `F0000036 Equal '国有企业'`)
	if err != nil {
		t.Fatalf("Records() error = %v", err)
	}
	if !strings.Contains(string(data), "returnData") {
		t.Fatalf("data = %s", data)
	}
	if client.lastQuery.Keyword != "客户" {
		t.Fatalf("keyword = %q", client.lastQuery.Keyword)
	}
	if client.lastQuery.Filter == nil {
		t.Fatal("Records() sent no filter although one was requested")
	}
	encoded, _ := json.Marshal(client.lastQuery.Filter)
	for _, want := range []string{`"Syx1.F0000036"`, `"Equal"`, `国有企业`} {
		if !strings.Contains(string(encoded), want) {
			t.Fatalf("filter payload = %s, want containing %q", encoded, want)
		}
	}
}

func TestRecordsWithoutFilterOmitsFilter(t *testing.T) {
	store := &fakeStore{exists: true, session: h3yuncreds.Session{Token: "t", EngineCode: "e"}}
	client := &fakeClient{records: json.RawMessage(`{"returnData":[]}`)}
	service := testService(store, client)

	if _, err := service.Records(context.Background(), "Syx1", 0, 20, "", ""); err != nil {
		t.Fatalf("Records() error = %v", err)
	}
	if client.lastQuery.Filter != nil {
		t.Fatalf("Records() sent a filter without --filter: %#v", client.lastQuery.Filter)
	}
}

func TestRecordsRejectsInvalidFilterExpression(t *testing.T) {
	store := &fakeStore{exists: true, session: h3yuncreds.Session{Token: "t", EngineCode: "e"}}
	client := &fakeClient{records: json.RawMessage(`{"returnData":[]}`)}
	service := testService(store, client)

	if _, err := service.Records(context.Background(), "Syx1", 0, 20, "", "Status ="); err == nil {
		t.Fatal("Records() error = nil, want filter parse error")
	} else if !strings.Contains(err.Error(), "invalid record filter") {
		t.Fatalf("Records() error = %q, want invalid-record-filter", err)
	}
	if client.lastQuery.SchemaCode != "" {
		t.Fatalf("QueryRecords was called although the filter is invalid: %+v", client.lastQuery)
	}
}
