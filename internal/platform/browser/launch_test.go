package browser

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestLaunchArgsAlwaysHeadedWithSandboxOff(t *testing.T) {
	args := LaunchArgs(LaunchSpec{ProfileDir: "/tmp/p", Port: 9333, URLs: []string{"https://a/"}})
	joined := strings.Join(args, " ")
	for _, want := range []string{
		"--remote-debugging-port=9333", "--user-data-dir=/tmp/p",
		"--no-sandbox", "--disable-gpu", "--remote-allow-origins=*",
		"--no-first-run", "--no-default-browser-check", "--disable-crashpad",
		"https://a/",
	} {
		if !strings.Contains(joined, want) {
			t.Fatalf("LaunchArgs missing %q: %v", want, args)
		}
	}
	for _, banned := range []string{"--headless", "--window-position"} {
		if strings.Contains(joined, banned) {
			t.Fatalf("LaunchArgs must not contain %q: %v", banned, args)
		}
	}
}

// debuggerServer 起一个只实现 /json/list 的假调试端点，返回它的端口。
func debuggerServer(t *testing.T, targets any) int {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/json/list" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(targets)
	}))
	t.Cleanup(srv.Close)
	parsed, err := url.Parse(srv.URL)
	if err != nil {
		t.Fatalf("parse httptest url: %v", err)
	}
	port, err := strconv.Atoi(parsed.Port())
	if err != nil {
		t.Fatalf("parse httptest port: %v", err)
	}
	return port
}

func TestWaitForPageTargetPicksThePageTarget(t *testing.T) {
	port := debuggerServer(t, []map[string]string{
		{"type": "browser", "webSocketDebuggerUrl": "ws://127.0.0.1:1/browser"},
		{"type": "page", "webSocketDebuggerUrl": "ws://127.0.0.1:1/page-ok"},
	})
	ws, err := WaitForPageTarget(context.Background(), port, 2*time.Second)
	if err != nil {
		t.Fatalf("WaitForPageTarget() error = %v, want nil", err)
	}
	if ws != "ws://127.0.0.1:1/page-ok" {
		t.Fatalf("WaitForPageTarget() = %q, want the page target's ws url", ws)
	}
}

func TestWaitForPageTargetSkipsTargetsWithoutWebSocketURL(t *testing.T) {
	port := debuggerServer(t, []map[string]string{
		{"type": "page"},
		{"type": "page", "webSocketDebuggerUrl": "ws://127.0.0.1:1/late"},
	})
	ws, err := WaitForPageTarget(context.Background(), port, 2*time.Second)
	if err != nil {
		t.Fatalf("WaitForPageTarget() error = %v, want nil", err)
	}
	if ws != "ws://127.0.0.1:1/late" {
		t.Fatalf("WaitForPageTarget() = %q, want the first target that has a ws url", ws)
	}
}

// 端口上没有任何监听者 —— 这正是「浏览器已在运行但调试端口不可达」的形状。
func TestWaitForPageTargetTimesOutWhenDebuggerNeverAnswers(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve port: %v", err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	_ = listener.Close()

	start := time.Now()
	_, err = WaitForPageTarget(context.Background(), port, 600*time.Millisecond)
	if err == nil {
		t.Fatal("WaitForPageTarget() = nil error, want a timeout error")
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Fatalf("WaitForPageTarget() took %s, want it to honour its timeout", elapsed)
	}
	if !strings.Contains(err.Error(), strconv.Itoa(port)) {
		t.Fatalf("WaitForPageTarget() error = %q, want it to name port %d", err.Error(), port)
	}
}

func TestWaitForPageTargetHonoursCancelledContext(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve port: %v", err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	_ = listener.Close()

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := WaitForPageTarget(ctx, port, 30*time.Second); err == nil {
		t.Fatal("WaitForPageTarget() = nil error with a cancelled context")
	}
}

func TestFreePortReturnsUsablePort(t *testing.T) {
	port, err := FreePort()
	if err != nil {
		t.Fatalf("FreePort() error = %v, want nil", err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(port))
	if err != nil {
		t.Fatalf("FreePort() returned %d which cannot be re-bound: %v", port, err)
	}
	_ = listener.Close()
}
