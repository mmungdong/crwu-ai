package browser

import (
	"context"
	"encoding/base64"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/gorilla/websocket"
)

// recorder 记录假 CDP 收到的每一次调用，并允许按方法给出响应。
type recorder struct {
	mu    sync.Mutex
	calls []string
	seen  []map[string]any
}

func (r *recorder) note(request map[string]any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	method, _ := request["method"].(string)
	r.calls = append(r.calls, method)
	params, _ := request["params"].(map[string]any)
	r.seen = append(r.seen, params)
}

func (r *recorder) methods() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.calls...)
}

func (r *recorder) count(method string) int {
	n := 0
	for _, m := range r.methods() {
		if m == method {
			n++
		}
	}
	return n
}

// lastParamsFor 返回最后一次该方法收到的参数。
func (r *recorder) lastParamsFor(method string) map[string]any {
	r.mu.Lock()
	defer r.mu.Unlock()
	for i := len(r.calls) - 1; i >= 0; i-- {
		if r.calls[i] == method {
			return r.seen[i]
		}
	}
	return nil
}

func TestScreenshotViewportOnlyWhenNotFullPage(t *testing.T) {
	rec := &recorder{}
	url := fakeCDP(t, func(conn *websocket.Conn, request map[string]any) {
		rec.note(request)
		_ = conn.WriteJSON(map[string]any{"id": request["id"], "result": map[string]any{
			"cssContentSize": map[string]any{"width": 1440, "height": 5000},
			"data":           base64.StdEncoding.EncodeToString(contentPNG(t, 1440, 1200)),
		}})
	})
	client, err := Dial(context.Background(), url)
	if err != nil {
		t.Fatalf("Dial() error = %v, want nil", err)
	}
	defer func() { _ = client.Close() }()

	if _, err := client.Screenshot(context.Background(), false); err != nil {
		t.Fatalf("Screenshot(false) error = %v, want nil", err)
	}
	if rec.count("Page.getLayoutMetrics") != 0 {
		t.Fatal("Screenshot(false) measured the page; a viewport capture must not resize to page height")
	}
	params := rec.lastParamsFor("Page.captureScreenshot")
	if beyond, _ := params["captureBeyondViewport"].(bool); beyond {
		t.Fatalf("Screenshot(false) params = %v, want no captureBeyondViewport", params)
	}
}

func TestScreenshotFullPageMeasuresAndCapturesBeyondViewport(t *testing.T) {
	rec := &recorder{}
	url := fakeCDP(t, func(conn *websocket.Conn, request map[string]any) {
		rec.note(request)
		_ = conn.WriteJSON(map[string]any{"id": request["id"], "result": map[string]any{
			"cssContentSize": map[string]any{"width": 1440, "height": 5000},
			"data":           base64.StdEncoding.EncodeToString(contentPNG(t, 1440, 1200)),
		}})
	})
	client, err := Dial(context.Background(), url)
	if err != nil {
		t.Fatalf("Dial() error = %v, want nil", err)
	}
	defer func() { _ = client.Close() }()

	if _, err := client.Screenshot(context.Background(), true); err != nil {
		t.Fatalf("Screenshot(true) error = %v, want nil", err)
	}
	if rec.count("Page.getLayoutMetrics") == 0 {
		t.Fatal("Screenshot(true) did not measure the page")
	}
	params := rec.lastParamsFor("Page.captureScreenshot")
	if beyond, _ := params["captureBeyondViewport"].(bool); !beyond {
		t.Fatalf("Screenshot(true) params = %v, want captureBeyondViewport", params)
	}
}

// 登录态就在 profile 里。SIGKILL 不给浏览器刷盘的机会，员工刚完成的登录可能因此丢失，
// 所以自有实例必须先请求优雅关闭。
func TestReleaseClosesBrowserGracefullyBeforeKilling(t *testing.T) {
	rec := &recorder{}
	url := fakeCDP(t, func(conn *websocket.Conn, request map[string]any) {
		rec.note(request)
		_ = conn.WriteJSON(map[string]any{"id": request["id"], "result": map[string]any{}})
	})
	client, err := Dial(context.Background(), url)
	if err != nil {
		t.Fatalf("Dial() error = %v, want nil", err)
	}

	cmd := exec.Command("sleep", "30")
	if err := cmd.Start(); err != nil {
		t.Skipf("cannot start a stand-in process: %v", err)
	}

	browser := &Browser{Port: 1, Owned: true, Client: client, process: cmd.Process, profileDir: t.TempDir()}
	if err := browser.Release(); err != nil {
		t.Fatalf("Release() error = %v, want nil", err)
	}
	if rec.count("Browser.close") == 0 {
		t.Fatal("Release() killed an owned browser without asking it to shut down; cookies may never reach the profile")
	}
}

func TestProfileDirRejectsRelativeOverride(t *testing.T) {
	_, err := ProfileDir(envOf(map[string]string{"CRWU_BROWSER_PROFILE": "relative/profile"}))
	if err == nil {
		t.Fatal("ProfileDir() = nil error for a relative override; the credential directory must not follow the cwd")
	}
	if !strings.Contains(err.Error(), "绝对") {
		t.Fatalf("ProfileDir() error = %q, want it to require an absolute path", err.Error())
	}
}

func TestDoFetchRejectsNonHTTPURL(t *testing.T) {
	for _, raw := range []string{"file:///etc/passwd", "ftp://example.com/x", "javascript:alert(1)"} {
		browser := browserOnFakeCDP(t, func(conn *websocket.Conn, request map[string]any) {
			t.Errorf("the browser was used for a rejected URL: %v", request)
		})
		_, err := DoFetch(context.Background(), browser, Options{URL: raw, Out: filepath.Join(t.TempDir(), "o.html")})
		if err == nil {
			t.Fatalf("DoFetch(%q) = nil error, want a rejection", raw)
		}
	}
}

func TestDoFetchRejectsLoopbackAndPrivateHosts(t *testing.T) {
	for _, raw := range []string{
		"http://127.0.0.1:8080/x", "http://localhost/x", "http://10.0.0.5/x",
		"http://192.168.1.1/x", "http://172.16.9.9/x", "http://[::1]/x", "http://169.254.1.1/x",
	} {
		browser := browserOnFakeCDP(t, func(conn *websocket.Conn, request map[string]any) {
			t.Errorf("the browser was used for a rejected URL: %v", request)
		})
		_, err := DoFetch(context.Background(), browser, Options{URL: raw, Out: filepath.Join(t.TempDir(), "o.html")})
		if err == nil {
			t.Fatalf("DoFetch(%q) = nil error, want a rejection", raw)
		}
	}
}

func TestDoFetchAllowsPublicHTTPHost(t *testing.T) {
	rec := &recorder{}
	browser := browserOnFakeCDP(t, func(conn *websocket.Conn, request map[string]any) {
		rec.note(request)
		params, _ := request["params"].(map[string]any)
		expression, _ := params["expression"].(string)
		reply := func(result map[string]any) {
			_ = conn.WriteJSON(map[string]any{"id": request["id"], "result": result})
		}
		switch {
		case strings.Contains(expression, "outerHTML"):
			reply(map[string]any{"result": map[string]any{"type": "string", "value": "<html>ok</html>"}})
		case strings.Contains(expression, "location.href"):
			reply(map[string]any{"result": map[string]any{"type": "string", "value": `{"href":"https://bj.ke.com/x","title":"t","text":"in sale"}`}})
		default:
			reply(map[string]any{"result": map[string]any{"type": "number", "value": 200}})
		}
	})

	out := filepath.Join(t.TempDir(), "o.html")
	result, err := DoFetch(context.Background(), browser, Options{URL: "https://bj.ke.com/ershoufang/1.html", Out: out})
	if err != nil {
		t.Fatalf("DoFetch() error = %v, want nil for a public https host", err)
	}
	if !result.OK {
		t.Fatalf("DoFetch() = %+v, want OK", result)
	}
}

// 读不出来不等于「这是一张正常页」。把它报成 OK 会写出一个我们根本没读懂的文件。
//
// 注意：Navigate 自己也轮询 Facts，所以「一次都读不出来」表现为导航失败。
// 这里要构造的是「导航成功之后、最终那次读取失败」—— 于是第一次调用给合法值，之后给废值。
func TestDoFetchReportsUnknownWhenFactsAreUnreadable(t *testing.T) {
	factsCalls := 0
	browser := browserOnFakeCDP(t, func(conn *websocket.Conn, request map[string]any) {
		params, _ := request["params"].(map[string]any)
		expression, _ := params["expression"].(string)
		reply := func(result map[string]any) {
			_ = conn.WriteJSON(map[string]any{"id": request["id"], "result": result})
		}
		switch {
		case strings.Contains(expression, "location.href"):
			factsCalls++
			value := `{"href":"https://bj.ke.com/x","title":"t","text":"in sale"}`
			if factsCalls > 1 {
				value = "not json at all"
			}
			reply(map[string]any{"result": map[string]any{"type": "string", "value": value}})
		case strings.Contains(expression, "outerHTML"):
			reply(map[string]any{"result": map[string]any{"type": "string", "value": "<html>unknown</html>"}})
		default:
			reply(map[string]any{"result": map[string]any{"type": "number", "value": 200}})
		}
	})

	out := filepath.Join(t.TempDir(), "o.html")
	result, err := DoFetch(context.Background(), browser, Options{URL: "https://bj.ke.com/x", Out: out})
	if err != nil {
		t.Fatalf("DoFetch() error = %v, want nil (an unreadable page is a classification, not an error)", err)
	}
	if result.OK {
		t.Fatal("DoFetch() reported OK for a page whose facts could not be read")
	}
	if result.FailureKind != FailureUnknown {
		t.Fatalf("FailureKind = %q, want %q", result.FailureKind, FailureUnknown)
	}
	if _, statErr := os.Stat(out); statErr == nil {
		t.Fatal("DoFetch() wrote --out for a page it could not read")
	}
}

func TestDoShotRestoresViewportWhenVerificationFails(t *testing.T) {
	rec := &recorder{}
	browser := browserOnFakeCDP(t, func(conn *websocket.Conn, request map[string]any) {
		rec.note(request)
		params, _ := request["params"].(map[string]any)
		expression, _ := params["expression"].(string)
		reply := func(result map[string]any) {
			_ = conn.WriteJSON(map[string]any{"id": request["id"], "result": result})
		}
		switch {
		case strings.Contains(expression, "location.href"):
			reply(map[string]any{"result": map[string]any{"type": "string", "value": `{"href":"https://bj.ke.com/x","title":"t","text":"in sale"}`}})
		case strings.Contains(expression, "getEntriesByType"):
			reply(map[string]any{"result": map[string]any{"type": "string", "value": "200"}})
		default:
			// 截图一律回空白图：校验必然失败，从而走到错误返回路径。
			reply(map[string]any{
				"cssContentSize": map[string]any{"width": 1440, "height": 5000},
				"data":           base64.StdEncoding.EncodeToString(blankPNG(t, 1440, 1200)),
			})
		}
	})

	out := filepath.Join(t.TempDir(), "o.png")
	if _, err := DoShot(context.Background(), browser, Options{URL: "https://bj.ke.com/x", Out: out}); err == nil {
		t.Fatal("DoShot() = nil error for a blank capture, want a verification failure")
	}
	params := rec.lastParamsFor("Emulation.setDeviceMetricsOverride")
	if params == nil {
		t.Fatal("no viewport was ever set")
	}
	if h, _ := params["height"].(float64); int(h) != defaultViewportHeight {
		t.Fatalf("last viewport height = %v, want %d: the page-height viewport leaked past the failure",
			params["height"], defaultViewportHeight)
	}
}
