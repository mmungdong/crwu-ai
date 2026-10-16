package browser

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// fakeCDP starts a websocket endpoint that answers every request with whatever
// handler writes. Tests must never touch the network, so every CDP interaction
// in this file goes through here.
func fakeCDP(t *testing.T, handler func(conn *websocket.Conn, request map[string]any)) string {
	t.Helper()
	upgrader := websocket.Upgrader{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer func() { _ = conn.Close() }()
		for {
			_, raw, err := conn.ReadMessage()
			if err != nil {
				return
			}
			var request map[string]any
			if err := json.Unmarshal(raw, &request); err != nil {
				continue
			}
			handler(conn, request)
		}
	}))
	t.Cleanup(srv.Close)
	return "ws" + strings.TrimPrefix(srv.URL, "http")
}

func TestCallRoutesResponseByID(t *testing.T) {
	url := fakeCDP(t, func(conn *websocket.Conn, request map[string]any) {
		// 先推一条不带 id 的事件，再回带 id 的响应：读循环必须跳过前者。
		_ = conn.WriteJSON(map[string]any{"method": "Page.loadEventFired", "params": map[string]any{}})
		_ = conn.WriteJSON(map[string]any{"id": request["id"], "result": map[string]any{"ok": true}})
	})

	client, err := Dial(context.Background(), url)
	if err != nil {
		t.Fatalf("Dial() error = %v, want nil", err)
	}
	defer func() { _ = client.Close() }()

	result, err := client.Call(context.Background(), "Page.enable", nil)
	if err != nil {
		t.Fatalf("Call() error = %v, want nil", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(result, &decoded); err != nil {
		t.Fatalf("Call() result is not JSON: %v", err)
	}
	if decoded["ok"] != true {
		t.Fatalf("Call() result = %v, want the id-matched response, not the event", decoded)
	}
}

func TestCallReturnsErrorOnErrorField(t *testing.T) {
	url := fakeCDP(t, func(conn *websocket.Conn, request map[string]any) {
		_ = conn.WriteJSON(map[string]any{
			"id":    request["id"],
			"error": map[string]any{"code": -1, "message": "boom"},
		})
	})

	client, err := Dial(context.Background(), url)
	if err != nil {
		t.Fatalf("Dial() error = %v, want nil", err)
	}
	defer func() { _ = client.Close() }()

	_, err = client.Call(context.Background(), "Page.enable", nil)
	if err == nil {
		t.Fatal("Call() = nil error, want the CDP error surfaced")
	}
	if !strings.Contains(err.Error(), "boom") {
		t.Fatalf("Call() error = %q, want it to contain %q", err.Error(), "boom")
	}
	if !strings.Contains(err.Error(), "Page.enable") {
		t.Fatalf("Call() error = %q, want it to name the method", err.Error())
	}
}

func TestCallUnblocksWhenContextIsCancelled(t *testing.T) {
	url := fakeCDP(t, func(_ *websocket.Conn, _ map[string]any) {
		// 故意不回：没有取消机制的话这里会一直挂住。
	})

	client, err := Dial(context.Background(), url)
	if err != nil {
		t.Fatalf("Dial() error = %v, want nil", err)
	}
	defer func() { _ = client.Close() }()

	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()

	start := time.Now()
	if _, err := client.Call(ctx, "Page.enable", nil); err == nil {
		t.Fatal("Call() = nil error with a cancelled context")
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Fatalf("Call() took %s, want it to unblock on cancellation", elapsed)
	}
}

func TestCookiesParsesNameDomainAndValue(t *testing.T) {
	url := fakeCDP(t, func(conn *websocket.Conn, request map[string]any) {
		_ = conn.WriteJSON(map[string]any{
			"id": request["id"],
			"result": map[string]any{"cookies": []map[string]any{
				{
					"name": "lianjia_token", "domain": ".lianjia.com", "value": "sentinel-value",
					// 平台会带一堆额外字段：解析必须忽略它们而不是失败。
					"path": "/", "httpOnly": true, "secure": true, "size": 36, "session": false,
				},
			}},
		})
	})

	client, err := Dial(context.Background(), url)
	if err != nil {
		t.Fatalf("Dial() error = %v, want nil", err)
	}
	defer func() { _ = client.Close() }()

	cookies, err := client.Cookies(context.Background())
	if err != nil {
		t.Fatalf("Cookies() error = %v, want nil", err)
	}
	if len(cookies) != 1 {
		t.Fatalf("Cookies() returned %d cookies, want 1", len(cookies))
	}
	got := cookies[0]
	if got.Name != "lianjia_token" || got.Domain != ".lianjia.com" || got.Value != "sentinel-value" {
		t.Fatalf("Cookies() = %+v, want name/domain/value parsed", got)
	}
}

func TestDialRejectsUnreachableEndpoint(t *testing.T) {
	if _, err := Dial(context.Background(), "ws://127.0.0.1:1/nope"); err == nil {
		t.Fatal("Dial() = nil error for an unreachable endpoint")
	}
}

// TestCookiesReadsBrowserWideNotCurrentURL pins the call shape that decides
// whether a signed-in employee is seen as signed in.
//
// CDP's `Network.getCookies` is documented as returning cookies **for the current
// URL**: with no `urls` filter it is scoped to whatever page the attached target
// happens to show. The CLI attaches to one page target, so a read shaped that way
// sees nothing on `about:blank` and only one site's cookies when the tab sits on
// the other site's login page — both of which were observed on a real profile
// (2026-10-14: 0 cookies on about:blank, 28 with explicit urls, 66 browser-wide).
//
// `Storage.getCookies` is the browser-wide read. The fake below is deliberately
// Chromium-shaped: the URL-scoped call answers only when it is given `urls`.
func TestCookiesReadsBrowserWideNotCurrentURL(t *testing.T) {
	ws := fakeCDP(t, func(conn *websocket.Conn, request map[string]any) {
		reply := func(result map[string]any) {
			_ = conn.WriteJSON(map[string]any{"id": request["id"], "result": result})
		}
		switch request["method"] {
		case "Network.getCookies":
			params, _ := request["params"].(map[string]any)
			if _, ok := params["urls"]; !ok {
				reply(map[string]any{"cookies": []any{}})
				return
			}
			reply(map[string]any{"cookies": []map[string]any{
				{"name": "lianjia_token", "domain": ".lianjia.com", "value": "v"},
			}})
		case "Storage.getCookies":
			reply(map[string]any{"cookies": []map[string]any{
				{"name": "lianjia_token", "domain": ".lianjia.com", "value": "v"},
				{"name": "lianjia_token", "domain": ".lianjia.com", "value": "v"},
			}})
		default:
			reply(map[string]any{})
		}
	})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	client, err := Dial(ctx, ws)
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer func() { _ = client.Close() }()

	cookies, err := client.Cookies(ctx)
	if err != nil {
		t.Fatalf("Cookies: %v", err)
	}
	if len(cookies) != 2 {
		t.Fatalf("Cookies() returned %d cookies, want the 2 browser-wide ones "+
			"(a URL-scoped read sees 0 on about:blank): %+v", len(cookies), cookies)
	}
}
