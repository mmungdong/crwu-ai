package h3yun

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func writeRPC(t *testing.T, w http.ResponseWriter, result any) {
	t.Helper()
	payload, err := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"id":      1,
		"result":  result,
	})
	if err != nil {
		t.Fatalf("marshal rpc response: %v", err)
	}
	w.Header().Set("Content-Type", "text/event-stream")
	fmt.Fprintf(w, "event: message\ndata: %s\n\n", payload)
}

func testClient(t *testing.T, handler http.Handler) (*Client, string) {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	client, err := NewClient(Config{Token: "test-token", BaseURL: server.URL})
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}
	return client, server.URL
}

func TestPingReturnsServerInfo(t *testing.T) {
	client, _ := testClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer test-token" {
			t.Errorf("Authorization = %q, want Bearer test-token", got)
		}
		writeRPC(t, w, map[string]any{
			"protocolVersion": "2024-11-05",
			"capabilities":    map[string]any{"tools": map[string]any{}},
			"serverInfo": map[string]string{
				"name":    "h3yun-agent-platform-tools",
				"title":   "氚云 Agent 平台工具",
				"version": "1.0.0",
			},
		})
	}))

	info, err := client.Ping(context.Background())
	if err != nil {
		t.Fatalf("Ping() error = %v", err)
	}
	if info.Name != "h3yun-agent-platform-tools" || info.Version != "1.0.0" {
		t.Fatalf("Ping() = %+v", info)
	}
}

func TestPingMissingServerInfoFails(t *testing.T) {
	client, _ := testClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeRPC(t, w, map[string]any{"protocolVersion": "2024-11-05"})
	}))
	if _, err := client.Ping(context.Background()); err == nil {
		t.Fatal("Ping() error = nil, want failure when serverInfo is missing")
	}
}

func TestToolsListsGatewayTools(t *testing.T) {
	client, _ := testClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeRPC(t, w, map[string]any{
			"tools": []map[string]any{
				{"name": "h3yun_search_apps", "description": "Search apps", "inputSchema": map[string]any{"type": "object"}},
				{"name": "h3yun_get_bizobject_schema", "description": "Get schema", "inputSchema": map[string]any{"type": "object"}},
			},
		})
	}))

	tools, err := client.Tools(context.Background())
	if err != nil {
		t.Fatalf("Tools() error = %v", err)
	}
	if len(tools) != 2 || tools[0].Name != "h3yun_search_apps" || tools[1].Name != "h3yun_get_bizobject_schema" {
		t.Fatalf("Tools() = %+v", tools)
	}
}

func TestCallToolSuccessFromTextContent(t *testing.T) {
	client, _ := testClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req map[string]any
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Errorf("decode request: %v", err)
		}
		if req["method"] != "tools/call" {
			t.Errorf("method = %v, want tools/call", req["method"])
		}
		writeRPC(t, w, map[string]any{
			"content": []map[string]string{
				{"type": "text", "text": `{"errorCode":0,"errorMessage":null,"data":{"total":1,"data":[{"name":"CRM"}]}}`},
			},
			"isError": false,
		})
	}))

	envelope, err := client.CallTool(context.Background(), "h3yun_search_apps", map[string]any{"keyword": "CRM"})
	if err != nil {
		t.Fatalf("CallTool() error = %v", err)
	}
	if !envelope.OK() {
		t.Fatalf("envelope = %+v, want success", envelope)
	}
	var data struct {
		Total int `json:"total"`
	}
	if err := json.Unmarshal(envelope.Data, &data); err != nil || data.Total != 1 {
		t.Fatalf("data = %s, want total 1 (%v)", envelope.Data, err)
	}
}

func TestCallToolSuccessFromStructuredContent(t *testing.T) {
	client, _ := testClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeRPC(t, w, map[string]any{
			"structuredContent": map[string]any{
				"errorCode": 0,
				"data":      map[string]any{"ok": true},
			},
			"isError": false,
		})
	}))

	envelope, err := client.CallTool(context.Background(), "h3yun_get_todo_count", nil)
	if err != nil {
		t.Fatalf("CallTool() error = %v", err)
	}
	if !strings.Contains(string(envelope.Data), `"ok":true`) {
		t.Fatalf("data = %s, want ok:true", envelope.Data)
	}
}

func TestCallToolRealEnvelopeSuccess(t *testing.T) {
	client, _ := testClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeRPC(t, w, map[string]any{
			"content": []map[string]string{
				{"type": "text", "text": `{"status":"success","data":{"total":9,"data":[]}}`},
			},
			"isError": false,
		})
	}))

	envelope, err := client.CallTool(context.Background(), "h3yun_search_apps", map[string]any{"keyword": "客户"})
	if err != nil {
		t.Fatalf("CallTool() error = %v", err)
	}
	if !envelope.OK() {
		t.Fatalf("envelope = %+v, want success", envelope)
	}
	var data struct {
		Total int `json:"total"`
	}
	if err := json.Unmarshal(envelope.Data, &data); err != nil || data.Total != 9 {
		t.Fatalf("data = %s, want total 9 (%v)", envelope.Data, err)
	}
}

func TestCallToolRealEnvelopeFailure(t *testing.T) {
	client, _ := testClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeRPC(t, w, map[string]any{
			"content": []map[string]string{
				{"type": "text", "text": `{"status":"failure","data":null,"error":{"code":"h3yun.read.upstream_error","message":"上游响应异常，本次读取失败","retryable":false}}`},
			},
			"isError": true,
		})
	}))

	_, err := client.CallTool(context.Background(), "h3yun_search_apps", nil)
	if err == nil {
		t.Fatal("CallTool() error = nil, want failure")
	}
	var gatewayErr *GatewayError
	if !errors.As(err, &gatewayErr) {
		t.Fatalf("CallTool() error = %v, want *GatewayError", err)
	}
	if gatewayErr.Code != "h3yun.read.upstream_error" {
		t.Fatalf("GatewayError code = %q", gatewayErr.Code)
	}
	if !strings.Contains(gatewayErr.Message, "上游响应异常") {
		t.Fatalf("GatewayError message = %q", gatewayErr.Message)
	}
}

func TestCallToolReportsGatewayErrorEnvelope(t *testing.T) {
	client, _ := testClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeRPC(t, w, map[string]any{
			"content": []map[string]string{
				{"type": "text", "text": `{"errorCode":"Forbidden","errorMessage":"no access","data":null}`},
			},
			"isError": false,
		})
	}))

	_, err := client.CallTool(context.Background(), "h3yun_remove_bizobject", nil)
	if err == nil {
		t.Fatal("CallTool() error = nil, want GatewayError")
	}
	var gatewayErr *GatewayError
	if !errors.As(err, &gatewayErr) {
		t.Fatalf("CallTool() error = %v, want *GatewayError", err)
	}
	if gatewayErr.Code != "Forbidden" || !strings.Contains(gatewayErr.Message, "no access") {
		t.Fatalf("GatewayError = %+v", gatewayErr)
	}
}

func TestCallToolReportsIsErrorFlag(t *testing.T) {
	client, _ := testClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeRPC(t, w, map[string]any{
			"content": []map[string]string{
				{"type": "text", "text": "internal failure"},
			},
			"isError": true,
		})
	}))

	_, err := client.CallTool(context.Background(), "h3yun_query_bizobject_list", nil)
	if err == nil {
		t.Fatal("CallTool() error = nil, want failure")
	}
}

func TestCustomHeadersAreSent(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("EngineCode"); got != "fjwebyfe8qq3xtryd37t7r641" {
			t.Errorf("EngineCode header = %q", got)
		}
		writeRPC(t, w, map[string]any{"serverInfo": map[string]string{"name": "g", "version": "1"}})
	}))
	t.Cleanup(server.Close)

	client, err := NewClient(Config{
		Token:   "tok",
		BaseURL: server.URL,
		Headers: map[string]string{"EngineCode": "fjwebyfe8qq3xtryd37t7r641"},
	})
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}
	if _, err := client.Ping(context.Background()); err != nil {
		t.Fatalf("Ping() error = %v", err)
	}
}

func TestCallToolRejectsBadToken(t *testing.T) {
	client, _ := testClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))

	_, err := client.CallTool(context.Background(), "h3yun_search_apps", nil)
	if err == nil {
		t.Fatal("CallTool() error = nil, want unauthorized error")
	}
	if !strings.Contains(err.Error(), "rejected the personal access token") {
		t.Fatalf("CallTool() error = %v", err)
	}
}

func TestCallToolRejectsMissingToken(t *testing.T) {
	if _, err := NewClient(Config{Token: "  "}); err == nil {
		t.Fatal("NewClient() error = nil, want missing-token error")
	}
}

func TestRPCErrorSurface(t *testing.T) {
	client, _ := testClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		payload, _ := json.Marshal(map[string]any{
			"jsonrpc": "2.0",
			"id":      1,
			"error":   map[string]any{"code": -32601, "message": "method not found"},
		})
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, string(payload))
	}))

	if _, err := client.Tools(context.Background()); err == nil {
		t.Fatal("Tools() error = nil, want RPC error")
	}
}

func TestJSONResponseWithoutSSE(t *testing.T) {
	client, _ := testClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		payload, _ := json.Marshal(map[string]any{
			"jsonrpc": "2.0",
			"id":      1,
			"result":  map[string]any{"tools": []map[string]any{}},
		})
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, string(payload))
	}))

	tools, err := client.Tools(context.Background())
	if err != nil {
		t.Fatalf("Tools() error = %v", err)
	}
	if len(tools) != 0 {
		t.Fatalf("Tools() = %+v, want empty", tools)
	}
}
