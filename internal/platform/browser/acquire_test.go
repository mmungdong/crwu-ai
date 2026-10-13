package browser

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// fakeBrowser starts a stand-in debugger: /json/version and /json/list answer like
// Chromium's, and /ws upgrades. It reports how many times /json/version was hit so a
// test can show an endpoint is still alive after Release.
func fakeBrowser(t *testing.T) (port int, versionHits *int32) {
	t.Helper()
	hits := new(int32)
	upgrader := websocket.Upgrader{}
	mux := http.NewServeMux()
	srv := httptest.NewServer(mux)

	mux.HandleFunc("/json/version", func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(hits, 1)
		_ = json.NewEncoder(w).Encode(map[string]string{"Browser": "Edg/test"})
	})
	mux.HandleFunc("/json/list", func(w http.ResponseWriter, _ *http.Request) {
		wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws"
		_ = json.NewEncoder(w).Encode([]map[string]string{
			{"type": "page", "webSocketDebuggerUrl": wsURL},
		})
	})
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer func() { _ = conn.Close() }()
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	})
	t.Cleanup(srv.Close)

	parsed, err := url.Parse(srv.URL)
	if err != nil {
		t.Fatalf("parse fake browser url: %v", err)
	}
	value, err := strconv.Atoi(parsed.Port())
	if err != nil {
		t.Fatalf("parse fake browser port: %v", err)
	}
	return value, hits
}

// seedPortFile 把端口写进 profile 对应的端口文件，返回 profileDir。
func seedPortFile(t *testing.T, port int) string {
	t.Helper()
	profileDir := filepath.Join(t.TempDir(), "profile")
	if err := os.MkdirAll(filepath.Dir(DebugPortFile(profileDir)), 0o700); err != nil {
		t.Fatalf("seed profile parent: %v", err)
	}
	if err := os.WriteFile(DebugPortFile(profileDir), []byte(strconv.Itoa(port)), 0o600); err != nil {
		t.Fatalf("seed port file: %v", err)
	}
	return profileDir
}

func TestDebugPortFileSitsBesideTheProfileNotInsideIt(t *testing.T) {
	profileDir := "/home/x/.crwu/browser/profile"
	want := "/home/x/.crwu/browser/debug-port"
	if got := DebugPortFile(profileDir); got != want {
		t.Fatalf("DebugPortFile() = %q, want %q (a file inside the profile would be profile content)", got, want)
	}
}

func TestRunningPortReturnsFalseWhenPortFileMissing(t *testing.T) {
	profileDir := filepath.Join(t.TempDir(), "profile")
	port, ok := RunningPort(profileDir)
	if ok || port != 0 {
		t.Fatalf("RunningPort() = (%d,%v), want (0,false) when no port file exists", port, ok)
	}
}

func TestRunningPortReturnsFalseWhenPortFileIsGarbage(t *testing.T) {
	profileDir := filepath.Join(t.TempDir(), "profile")
	if err := os.MkdirAll(filepath.Dir(DebugPortFile(profileDir)), 0o700); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := os.WriteFile(DebugPortFile(profileDir), []byte("abc"), 0o600); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if port, ok := RunningPort(profileDir); ok || port != 0 {
		t.Fatalf("RunningPort() = (%d,%v), want (0,false) for a garbage port file", port, ok)
	}
}

func TestRunningPortReturnsFalseWhenDebuggerNotAnswering(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve port: %v", err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	_ = listener.Close()

	profileDir := seedPortFile(t, port)
	if got, ok := RunningPort(profileDir); ok || got != 0 {
		t.Fatalf("RunningPort() = (%d,%v), want (0,false) when nothing answers", got, ok)
	}
}

func TestRunningPortReturnsPortWhenDebuggerAnswers(t *testing.T) {
	port, _ := fakeBrowser(t)
	profileDir := seedPortFile(t, port)

	got, ok := RunningPort(profileDir)
	if !ok || got != port {
		t.Fatalf("RunningPort() = (%d,%v), want (%d,true)", got, ok, port)
	}
}

func TestAcquireAttachesToARunningBrowser(t *testing.T) {
	port, _ := fakeBrowser(t)
	profileDir := seedPortFile(t, port)

	browser, err := Acquire(context.Background(), "/nonexistent/browser", profileDir, nil)
	if err != nil {
		t.Fatalf("Acquire() error = %v, want nil when a debugger is already running", err)
	}
	defer func() { _ = browser.Release() }()

	if browser.Owned {
		t.Fatal("Acquire() reported Owned=true for an already-running browser")
	}
	if browser.Port != port {
		t.Fatalf("Acquire() port = %d, want %d", browser.Port, port)
	}
	if browser.Client == nil {
		t.Fatal("Acquire() returned no client")
	}
}

func TestReleaseIsIdempotent(t *testing.T) {
	port, _ := fakeBrowser(t)
	profileDir := seedPortFile(t, port)

	browser, err := Acquire(context.Background(), "/nonexistent/browser", profileDir, nil)
	if err != nil {
		t.Fatalf("Acquire() error = %v, want nil", err)
	}
	if err := browser.Release(); err != nil {
		t.Fatalf("first Release() error = %v, want nil", err)
	}
	if err := browser.Release(); err != nil {
		t.Fatalf("second Release() error = %v, want nil (release must be idempotent)", err)
	}
}

func TestReleaseNeverKillsNonOwnedBrowser(t *testing.T) {
	port, hits := fakeBrowser(t)
	profileDir := seedPortFile(t, port)

	browser, err := Acquire(context.Background(), "/nonexistent/browser", profileDir, nil)
	if err != nil {
		t.Fatalf("Acquire() error = %v, want nil", err)
	}
	if err := browser.Release(); err != nil {
		t.Fatalf("Release() error = %v, want nil", err)
	}

	// 附着来的浏览器不是我们的，释放不能把它弄没。
	endpoint := "http://127.0.0.1:" + strconv.Itoa(port) + "/json/version"
	client := &http.Client{Timeout: time.Second}
	response, err := client.Get(endpoint)
	if err != nil {
		t.Fatalf("the attached browser became unreachable after Release: %v", err)
	}
	_ = response.Body.Close()
	if atomic.LoadInt32(hits) == 0 {
		t.Fatal("the fake browser was never hit; the test did not prove liveness")
	}
}
