package browser

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gorilla/websocket"
)

func TestFailureKindMapsVerdictStatusAndNavError(t *testing.T) {
	cases := []struct {
		name   string
		v      Verdict
		status int
		navErr error
		want   FailureKind
	}{
		{"login wall", VerdictLoginWall, 200, nil, FailureLogin},
		{"captcha", VerdictCaptcha, 200, nil, FailureCaptcha},
		{"blocked", VerdictBlocked, 200, nil, FailureBlocked},
		{"rate limited", VerdictOK, 429, nil, FailureRateLimited},
		{"forbidden", VerdictOK, 403, nil, FailureRateLimited},
		{"not found", VerdictOK, 404, nil, FailureNotFound},
		{"server error", VerdictOK, 500, nil, FailureServerError},
		{"network", VerdictOK, 0, errors.New("dial tcp: timeout"), FailureNetwork},
		{"ok", VerdictOK, 200, nil, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := FailureKindOf(tc.v, tc.status, tc.navErr); got != tc.want {
				t.Fatalf("FailureKindOf(%q,%d,%v) = %q, want %q", tc.v, tc.status, tc.navErr, got, tc.want)
			}
		})
	}
}

// 导航都失败了，状态码必然是 0。把 0 当成「服务器错误」会让员工去查一个没坏的站点，
// 所以 navErr 必须先于状态码判定。
func TestFailureKindOfPrefersNavigationErrorOverZeroStatus(t *testing.T) {
	if got := FailureKindOf(VerdictOK, 0, errors.New("boom")); got != FailureNetwork {
		t.Fatalf("FailureKindOf() = %q, want %q", got, FailureNetwork)
	}
}

// 页面事实优先于状态码：一个 200 的验证码页仍然是验证码。
func TestFailureKindOfPrefersVerdictOverStatus(t *testing.T) {
	if got := FailureKindOf(VerdictCaptcha, 403, nil); got != FailureCaptcha {
		t.Fatalf("FailureKindOf() = %q, want %q", got, FailureCaptcha)
	}
}

// captchaResponder 让假 CDP 表现得像一张人机验证页。
func captchaResponder(conn *websocket.Conn, request map[string]any) {
	method, _ := request["method"].(string)
	params, _ := request["params"].(map[string]any)
	expression, _ := params["expression"].(string)
	reply := func(result map[string]any) {
		_ = conn.WriteJSON(map[string]any{"id": request["id"], "result": result})
	}
	switch {
	case method == "Runtime.evaluate" && strings.Contains(expression, "outerHTML"):
		reply(map[string]any{"result": map[string]any{"type": "string", "value": "<html><body>人机验证</body></html>"}})
	case method == "Runtime.evaluate" && strings.Contains(expression, "location.href"):
		reply(map[string]any{"result": map[string]any{"type": "string", "value": `{"href":"https://hip.lianjia.com/captcha?location=x","title":"CAPTCHA","text":"人机验证 点击按钮开始验证"}`}})
	case method == "Runtime.evaluate":
		reply(map[string]any{"result": map[string]any{"type": "number", "value": 200}})
	default:
		reply(map[string]any{})
	}
}

func browserOnFakeCDP(t *testing.T, responder func(*websocket.Conn, map[string]any)) *Browser {
	t.Helper()
	url := fakeCDP(t, responder)
	client, err := Dial(context.Background(), url)
	if err != nil {
		t.Fatalf("Dial() error = %v, want nil", err)
	}
	t.Cleanup(func() { _ = client.Close() })
	return &Browser{Client: client}
}

func TestDoShotDoesNotWriteFileWhenVerdictIsNotOK(t *testing.T) {
	browser := browserOnFakeCDP(t, captchaResponder)
	out := filepath.Join(t.TempDir(), "shot.png")

	result, err := DoShot(context.Background(), browser, Options{URL: "https://example.com/", Out: out})
	if err != nil {
		t.Fatalf("DoShot() error = %v, want nil (a classified page is a result, not an error)", err)
	}
	if result.OK {
		t.Fatal("DoShot() reported OK for a captcha page")
	}
	if result.FailureKind != FailureCaptcha {
		t.Fatalf("DoShot() FailureKind = %q, want %q", result.FailureKind, FailureCaptcha)
	}
	if _, statErr := os.Stat(out); statErr == nil {
		t.Fatal("DoShot() wrote a screenshot for a captcha page; a challenge page must never become evidence")
	}
}

func TestDoFetchDoesNotWriteOutWhenVerdictIsNotOK(t *testing.T) {
	browser := browserOnFakeCDP(t, captchaResponder)
	out := filepath.Join(t.TempDir(), "page.html")

	result, err := DoFetch(context.Background(), browser, Options{URL: "https://example.com/", Out: out})
	if err != nil {
		t.Fatalf("DoFetch() error = %v, want nil", err)
	}
	if result.OK {
		t.Fatal("DoFetch() reported OK for a captcha page")
	}
	if _, statErr := os.Stat(out); statErr == nil {
		t.Fatal("DoFetch() wrote --out for a captcha page")
	}
}

func TestDoFetchWritesDumpEvenWhenVerdictIsNotOK(t *testing.T) {
	browser := browserOnFakeCDP(t, captchaResponder)
	dir := t.TempDir()
	out := filepath.Join(dir, "page.html")
	dump := filepath.Join(dir, "dump.html")

	if _, err := DoFetch(context.Background(), browser, Options{URL: "https://example.com/", Out: out, Dump: dump}); err != nil {
		t.Fatalf("DoFetch() error = %v, want nil", err)
	}
	if _, statErr := os.Stat(out); statErr == nil {
		t.Fatal("DoFetch() wrote --out for a captcha page")
	}
	info, statErr := os.Stat(dump)
	if statErr != nil {
		t.Fatalf("DoFetch() did not write --dump for a captcha page: %v", statErr)
	}
	if info.Size() == 0 {
		t.Fatal("DoFetch() wrote an empty --dump; the point is to see the page that blocked us")
	}
}

func TestDoFetchWritesPageAndDigestWhenVerdictIsOK(t *testing.T) {
	responder := func(conn *websocket.Conn, request map[string]any) {
		method, _ := request["method"].(string)
		params, _ := request["params"].(map[string]any)
		expression, _ := params["expression"].(string)
		reply := func(result map[string]any) {
			_ = conn.WriteJSON(map[string]any{"id": request["id"], "result": result})
		}
		switch {
		case method == "Runtime.evaluate" && strings.Contains(expression, "outerHTML"):
			reply(map[string]any{"result": map[string]any{"type": "string", "value": "<html>listing page</html>"}})
		case method == "Runtime.evaluate" && strings.Contains(expression, "location.href"):
			reply(map[string]any{"result": map[string]any{"type": "string", "value": `{"href":"https://bj.lianjia.com/ershoufang/1.html","title":"房源","text":"在售"}`}})
		default:
			reply(map[string]any{"result": map[string]any{"type": "number", "value": 200}})
		}
	}
	browser := browserOnFakeCDP(t, responder)
	out := filepath.Join(t.TempDir(), "page.html")

	result, err := DoFetch(context.Background(), browser, Options{URL: "https://example.com/", Out: out})
	if err != nil {
		t.Fatalf("DoFetch() error = %v, want nil", err)
	}
	if !result.OK {
		t.Fatalf("DoFetch() reported not-OK for a normal page (kind=%q)", result.FailureKind)
	}
	if result.Digest == "" || result.Bytes == 0 {
		t.Fatalf("DoFetch() result = %+v, want a digest and a byte count", result)
	}
	written, readErr := os.ReadFile(out)
	if readErr != nil {
		t.Fatalf("DoFetch() did not write --out: %v", readErr)
	}
	if !strings.Contains(string(written), "listing page") {
		t.Fatalf("DoFetch() wrote %q, want the rendered DOM", string(written))
	}
}

// TestRequirePublicHTTPURLRejectsLocallyResolvableSpellings covers the forms
// Chromium canonicalises to 127.0.0.1 but net.ParseIP refuses: a shortened IPv4
// (127.1), a hex/octal/decimal word (0x7f.1, 0177.0.0.1, 2130706433), a trailing
// root dot (localhost.), and a single-label intranet name. Checking the raw
// spelling let every one of them through to a browser that runs without its own
// sandbox.
func TestRequirePublicHTTPURLRejectsLocallyResolvableSpellings(t *testing.T) {
	for _, raw := range []string{
		"http://127.0.0.1/", "http://127.1/", "http://0x7f.1/", "http://2130706433/",
		"http://0x7f000001/", "http://0177.0.0.1/", "http://0.0.0.0/",
		"http://localhost./", "http://LOCALHOST/", "http://app.localhost./",
		"http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://[fe80::1]/",
		"http://10.1.2.3/", "http://192.168.0.1./", "http://169.254.169.254/",
		"http://intranet/", "http://user:pass@127.0.0.1/",
	} {
		if err := requirePublicHTTPURL(raw); err == nil {
			t.Fatalf("requirePublicHTTPURL(%q) = nil, want a rejection", raw)
		}
	}
}

func TestRequirePublicHTTPURLAllowsPublicHosts(t *testing.T) {
	for _, raw := range []string{
		"https://bj.lianjia.com/ershoufang/1.html",
		"https://sub.domain.example.co.uk/path?q=1",
		"http://example.com./",
		"https://[2606:4700:4700::1111]/",
	} {
		if err := requirePublicHTTPURL(raw); err != nil {
			t.Fatalf("requirePublicHTTPURL(%q) = %v, want nil", raw, err)
		}
	}
}
