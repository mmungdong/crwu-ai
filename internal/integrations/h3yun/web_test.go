package h3yun

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func webServer(t *testing.T, handler http.HandlerFunc) *WebClient {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	client, err := NewWebClient(WebConfig{Token: "jwt-token", EngineCode: "eng-1", BaseURL: server.URL})
	if err != nil {
		t.Fatalf("NewWebClient() error = %v", err)
	}
	return client
}

func writeWeb(t *testing.T, w http.ResponseWriter, envelope map[string]any) {
	t.Helper()
	payload, err := json.Marshal(envelope)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(payload)
}

func TestWebClientUserInfo(t *testing.T) {
	client := webServer(t, func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer jwt-token" {
			t.Errorf("Authorization = %q", got)
		}
		if got := r.Header.Get("EngineCode"); got != "eng-1" {
			t.Errorf("EngineCode = %q", got)
		}
		if r.URL.Path != "/v1/user/info" {
			t.Errorf("path = %q", r.URL.Path)
		}
		writeWeb(t, w, map[string]any{
			"returnData": map[string]any{"userId": "u1", "name": "Alice"},
			"successful": true,
		})
	})
	data, err := client.UserInfo(context.Background())
	if err != nil {
		t.Fatalf("UserInfo() error = %v", err)
	}
	if !strings.Contains(string(data), "Alice") {
		t.Fatalf("data = %s", data)
	}
}

func TestWebClientReportsUnsuccessfulEnvelope(t *testing.T) {
	client := webServer(t, func(w http.ResponseWriter, r *http.Request) {
		writeWeb(t, w, map[string]any{
			"successful":   false,
			"errorCode":    "UnLogin",
			"errorMessage": "用户未登陆!",
		})
	})
	_, err := client.ListApps(context.Background())
	if err == nil {
		t.Fatal("ListApps() error = nil, want web error")
	}
	var webErr *WebError
	if !errors.As(err, &webErr) || !strings.Contains(webErr.Message, "用户未登陆") {
		t.Fatalf("error = %v", err)
	}
}

func TestWebClientUnauthorized(t *testing.T) {
	client := webServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	})
	_, err := client.UserInfo(context.Background())
	if err == nil {
		t.Fatal("UserInfo() error = nil, want 401 error")
	}
	if !strings.Contains(err.Error(), "re-bind") {
		t.Fatalf("error = %v", err)
	}
}

func TestWebClientRefreshUsesTokenQuery(t *testing.T) {
	client := webServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("token") != "jwt-token" {
			t.Errorf("missing token query: %s", r.URL.RawQuery)
		}
		writeWeb(t, w, map[string]any{"returnData": map[string]any{"token": "new-token"}, "successful": true})
	})
	token, err := client.Refresh(context.Background())
	if err != nil {
		t.Fatalf("Refresh() error = %v", err)
	}
	if token != "new-token" {
		t.Fatalf("token = %q", token)
	}
}

func TestDecodeSessionTokenClaims(t *testing.T) {
	// header.payload.signature — payload is crafted, signature ignored.
	token := "header.eyJlbmdpbmVjb2RlIjoiZW5nLTEiLCJzaGFyZGtleSI6IlZlc3NlbDE1IiwidXNlcmlkIjoidTEiLCJhY2NvdW50dHlwZSI6IkRpbmdJZCIsImV4cCI6OTk5OTk5OTk5OSwiaWF0IjoxfQ.sig"
	claims, err := DecodeSessionToken(token)
	if err != nil {
		t.Fatalf("DecodeSessionToken() error = %v", err)
	}
	if claims.EngineCode != "eng-1" || claims.UserID != "u1" || claims.ShardKey != "Vessel15" || claims.AccountType != "DingId" {
		t.Fatalf("claims = %+v", claims)
	}
	if claims.ExpiresAt.Unix() != 9999999999 {
		t.Fatalf("exp = %v", claims.ExpiresAt)
	}
}

func TestDecodeSessionTokenRejectsJunk(t *testing.T) {
	if _, err := DecodeSessionToken("not-a-jwt"); err == nil {
		t.Fatal("DecodeSessionToken() error = nil, want failure")
	}
}
