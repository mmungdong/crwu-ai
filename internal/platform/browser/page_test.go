package browser

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"

	"github.com/gorilla/websocket"
)

func TestScrollScriptWalksWholePageAndReturnsToTop(t *testing.T) {
	script := ScrollScript()
	for _, want := range []string{"scrollHeight", "window.scrollTo(0,0)", "window.scrollTo(0,y)"} {
		if !strings.Contains(script, want) {
			t.Fatalf("ScrollScript() = %q, want it to contain %q", script, want)
		}
	}
}

func TestScrollAllAsksCDPToAwaitThePromise(t *testing.T) {
	var seen map[string]any
	url := fakeCDP(t, func(conn *websocket.Conn, request map[string]any) {
		if request["method"] == "Runtime.evaluate" {
			seen, _ = request["params"].(map[string]any)
		}
		_ = conn.WriteJSON(map[string]any{"id": request["id"], "result": map[string]any{}})
	})

	client, err := Dial(context.Background(), url)
	if err != nil {
		t.Fatalf("Dial() error = %v, want nil", err)
	}
	defer func() { _ = client.Close() }()

	if err := client.ScrollAll(context.Background()); err != nil {
		t.Fatalf("ScrollAll() error = %v, want nil", err)
	}
	if seen == nil {
		t.Fatal("ScrollAll() sent no Runtime.evaluate")
	}
	if await, _ := seen["awaitPromise"].(bool); !await {
		t.Fatalf("ScrollAll() params = %v, want awaitPromise true (the script is async)", seen)
	}
	expression, _ := seen["expression"].(string)
	if !strings.Contains(expression, "scrollHeight") {
		t.Fatalf("ScrollAll() expression = %q, want the scroll script", expression)
	}
}

// evaluateResponder 让假 CDP 服务把给定字符串当作 Runtime.evaluate 的返回值。
func evaluateResponder(value string) func(*websocket.Conn, map[string]any) {
	return func(conn *websocket.Conn, request map[string]any) {
		_ = conn.WriteJSON(map[string]any{
			"id": request["id"],
			"result": map[string]any{
				"result": map[string]any{"type": "string", "value": value},
			},
		})
	}
}

func TestFactsParsesEvaluateResult(t *testing.T) {
	payload, err := json.Marshal(map[string]string{
		"href": "https://bj.ke.com/ershoufang/chaoyang/", "title": "二手房", "text": "在售",
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	url := fakeCDP(t, evaluateResponder(string(payload)))

	client, err := Dial(context.Background(), url)
	if err != nil {
		t.Fatalf("Dial() error = %v, want nil", err)
	}
	defer func() { _ = client.Close() }()

	facts, err := client.Facts(context.Background())
	if err != nil {
		t.Fatalf("Facts() error = %v, want nil", err)
	}
	if facts.Href != "https://bj.ke.com/ershoufang/chaoyang/" || facts.Title != "二手房" || facts.Text != "在售" {
		t.Fatalf("Facts() = %+v, want all three fields parsed", facts)
	}
}

func TestFactsTreatsUnparseableValueAsEmpty(t *testing.T) {
	url := fakeCDP(t, evaluateResponder("not json"))

	client, err := Dial(context.Background(), url)
	if err != nil {
		t.Fatalf("Dial() error = %v, want nil", err)
	}
	defer func() { _ = client.Close() }()

	facts, err := client.Facts(context.Background())
	if err == nil {
		t.Fatal("Facts() = nil error for an unparseable value")
	}
	// 不能返回「半个结构」：出错时三个字段都必须是零值。
	if facts != (PageFacts{}) {
		t.Fatalf("Facts() = %+v on error, want the zero value", facts)
	}
}

func TestScreenshotDecodesBase64Payload(t *testing.T) {
	// 一个 1x1 的合法 PNG。
	raw, err := base64.StdEncoding.DecodeString(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")
	if err != nil {
		t.Fatalf("fixture: %v", err)
	}
	encoded := base64.StdEncoding.EncodeToString(raw)
	url := fakeCDP(t, func(conn *websocket.Conn, request map[string]any) {
		_ = conn.WriteJSON(map[string]any{"id": request["id"], "result": map[string]any{"data": encoded}})
	})

	client, err := Dial(context.Background(), url)
	if err != nil {
		t.Fatalf("Dial() error = %v, want nil", err)
	}
	defer func() { _ = client.Close() }()

	got, err := client.Screenshot(context.Background(), true)
	if err != nil {
		t.Fatalf("Screenshot() error = %v, want nil", err)
	}
	if string(got) != string(raw) {
		t.Fatalf("Screenshot() returned %d bytes, want the decoded PNG (%d bytes)", len(got), len(raw))
	}
}

func TestSetViewportSendsDeviceMetrics(t *testing.T) {
	var seen map[string]any
	url := fakeCDP(t, func(conn *websocket.Conn, request map[string]any) {
		if request["method"] == "Emulation.setDeviceMetricsOverride" {
			seen, _ = request["params"].(map[string]any)
		}
		_ = conn.WriteJSON(map[string]any{"id": request["id"], "result": map[string]any{}})
	})

	client, err := Dial(context.Background(), url)
	if err != nil {
		t.Fatalf("Dial() error = %v, want nil", err)
	}
	defer func() { _ = client.Close() }()

	if err := client.SetViewport(context.Background(), 1440, 1000); err != nil {
		t.Fatalf("SetViewport() error = %v, want nil", err)
	}
	if seen == nil {
		t.Fatal("SetViewport() sent no Emulation.setDeviceMetricsOverride")
	}
	if w, _ := seen["width"].(float64); int(w) != 1440 {
		t.Fatalf("SetViewport() width = %v, want 1440", seen["width"])
	}
	if h, _ := seen["height"].(float64); int(h) != 1000 {
		t.Fatalf("SetViewport() height = %v, want 1000", seen["height"])
	}
}
