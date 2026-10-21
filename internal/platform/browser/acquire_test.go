package browser

import (
	"context"
	"encoding/json"
	"fmt"
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

// seedPortFile 把端口写进 profile 对应的端口记录，返回 profileDir。
func seedPortFile(t *testing.T, port int) string {
	t.Helper()
	profileDir := filepath.Join(t.TempDir(), "profile")
	if err := os.MkdirAll(filepath.Dir(DebugPortFile(profileDir)), 0o700); err != nil {
		t.Fatalf("seed profile parent: %v", err)
	}
	if err := writeDebugPort(profileDir, port); err != nil {
		t.Fatalf("seed port file: %v", err)
	}
	return profileDir
}

func TestDebugPortFileSitsBesideTheProfileNotInsideIt(t *testing.T) {
	profileDir := "/home/x/.crwu/browser/profile"
	got := DebugPortFile(profileDir)
	if filepath.Dir(got) != "/home/x/.crwu/browser" {
		t.Fatalf("DebugPortFile() = %q, want it beside the profile (a file inside the profile would be profile content)", got)
	}
	// 同一父目录下的两个 profile 不能共用一份记录：共用时第二个 profile 会连上
	// 第一个 profile 的浏览器，读写的都是别人的 Cookie 与标签页。
	other := DebugPortFile("/home/x/.crwu/browser/profile-test")
	if got == other {
		t.Fatalf("DebugPortFile() = %q for two profiles under one parent; the record must be per profile", got)
	}
	// 尾分隔符不能让"旁边的文件"退化成"profile 里的文件"。
	if same := DebugPortFile("/home/x/.crwu/browser/profile/"); same != got {
		t.Fatalf("DebugPortFile() = %q for a trailing separator, want %q", same, got)
	}
}

func TestRunningPortIgnoresARecordWrittenForAnotherProfile(t *testing.T) {
	port, _ := fakeBrowser(t)
	parent := t.TempDir()
	first := filepath.Join(parent, "profile")
	second := filepath.Join(parent, "profile-test")
	if err := os.MkdirAll(filepath.Dir(DebugPortFile(second)), 0o700); err != nil {
		t.Fatalf("seed parent: %v", err)
	}
	// 端口号合法、调试器也确实活着，但记录属于另一个 profile。
	raw, err := json.Marshal(debugPortRecord{Profile: normalizeProfileDir(first), Port: port})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if err := os.WriteFile(DebugPortFile(second), raw, 0o600); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if got, ok := RunningPort(second); ok || got != 0 {
		t.Fatalf("RunningPort(second) = (%d,%v), want (0,false): 它连上了第一个 profile 的浏览器", got, ok)
	}
	// 记录回到自己的 profile 上就必须认。
	if err := writeDebugPort(second, port); err != nil {
		t.Fatalf("seed own record: %v", err)
	}
	if got, ok := RunningPort(second); !ok || got != port {
		t.Fatalf("RunningPort(second) = (%d,%v), want (%d,true)", got, ok, port)
	}
}

func TestRunningPortIgnoresALegacyBarePortFile(t *testing.T) {
	// 旧格式只有一个端口号，没有属主：无法证明它是这个 profile 的，就不再采信。
	// 仍然活着的浏览器由 DevToolsActivePort 与 SingletonLock 两条回退发现。
	port, _ := fakeBrowser(t)
	profileDir := filepath.Join(t.TempDir(), "profile")
	if err := os.MkdirAll(filepath.Dir(DebugPortFile(profileDir)), 0o700); err != nil {
		t.Fatalf("seed parent: %v", err)
	}
	if err := os.WriteFile(DebugPortFile(profileDir), []byte(strconv.Itoa(port)), 0o600); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if got, ok := RunningPort(profileDir); ok || got != 0 {
		t.Fatalf("RunningPort() = (%d,%v), want (0,false) for a record with no owner", got, ok)
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

// ── 发现存活浏览器：不能只靠我们自己的端口文件 ────────────────────────────────
//
// 2026-10-14 现场：登录窗口按设计一直开着，但每条命令结束时都会把 `debug-port` 删掉，
// 于是**下一条命令再也发现不了那个浏览器** → 另起实例 → Chromium 把请求交给已运行的
// 实例 → 新调试端口永不打开 → 20 秒后报"调试端口 N 没有可用的页面目标"。
// 员工看着浏览器里"已登录"，面板却永远过不了检查。

func TestPortFromCommandLine(t *testing.T) {
	cases := []struct {
		name string
		cmd  string
		want int
		ok   bool
	}{
		{"edge with a port", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge --remote-debugging-port=59390 --user-data-dir=/x --no-sandbox", 59390, true},
		{"port comes last", "chrome --user-data-dir=/x --remote-debugging-port=9222", 9222, true},
		{"no debug flag", "Edge --user-data-dir=/x", 0, false},
		{"garbage port", "Edge --remote-debugging-port=abc", 0, false},
		{"out of range", "Edge --remote-debugging-port=99999", 0, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := portFromCommandLine(tc.cmd)
			if ok != tc.ok || got != tc.want {
				t.Fatalf("portFromCommandLine(%q) = (%d,%v), want (%d,%v)", tc.cmd, got, ok, tc.want, tc.ok)
			}
		})
	}
}

func TestRunningPortFallsBackToChromiumDevToolsActivePort(t *testing.T) {
	port, _ := fakeBrowser(t)
	profileDir := filepath.Join(t.TempDir(), "profile")
	if err := os.MkdirAll(profileDir, 0o700); err != nil {
		t.Fatalf("seed: %v", err)
	}
	// Chromium 自己的发现文件：第一行是端口，第二行是 ws 路径。
	if err := os.WriteFile(filepath.Join(profileDir, devToolsActivePortName),
		[]byte(strconv.Itoa(port)+"\n/devtools/browser/abc\n"), 0o600); err != nil {
		t.Fatalf("seed: %v", err)
	}

	got, ok := RunningPort(profileDir)
	if !ok || got != port {
		t.Fatalf("RunningPort() = (%d,%v), want (%d,true) from DevToolsActivePort", got, ok, port)
	}
}

func TestReleaseKeepsThePortFileWhileTheBrowserStillAnswers(t *testing.T) {
	port, _ := fakeBrowser(t)
	profileDir := seedPortFile(t, port)

	browser := &Browser{Port: port, Owned: false, profileDir: profileDir}
	if err := browser.Release(); err != nil {
		t.Fatalf("Release() error = %v", err)
	}
	// 释放的是**我们这条连接**，不是浏览器：端口文件是下一条命令发现它的唯一线索。
	if _, err := os.Stat(DebugPortFile(profileDir)); err != nil {
		t.Fatalf("Release 删掉了仍然存活的浏览器端口文件：下一条命令只能另起实例并卡死（%v）", err)
	}
}

func TestReleaseDropsThePortFileOnceTheBrowserIsGone(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve port: %v", err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	_ = listener.Close()
	profileDir := seedPortFile(t, port)

	browser := &Browser{Port: port, Owned: false, profileDir: profileDir}
	if err := browser.Release(); err != nil {
		t.Fatalf("Release() error = %v", err)
	}
	if _, err := os.Stat(DebugPortFile(profileDir)); err == nil {
		t.Fatal("端口已经没人应答，文件应当被清掉（否则会一直指向一个死端口）")
	}
}

func TestLaunchTimeoutErrorNamesTheLiveProfileOwner(t *testing.T) {
	profileDir := filepath.Join(t.TempDir(), "profile")
	if err := os.MkdirAll(profileDir, 0o700); err != nil {
		t.Fatalf("seed: %v", err)
	}
	// 本进程自己就是一个"活着并占着这个 profile"的进程：用它当 pid 来源。
	lock := filepath.Join(profileDir, "SingletonLock")
	if err := os.Symlink(fmt.Sprintf("localhost-%d", os.Getpid()), lock); err != nil {
		t.Fatalf("seed lock: %v", err)
	}

	message := launchTimeoutError(profileDir, 61234).Error()
	if !strings.Contains(message, "在用这个 profile") {
		t.Fatalf("message = %q, want it to say the profile is in use", message)
	}
	if !strings.Contains(message, strconv.Itoa(os.Getpid())) {
		t.Fatalf("message = %q, want it to name the owning pid", message)
	}
}

func TestLaunchTimeoutErrorStaysPlainWhenNobodyOwnsTheProfile(t *testing.T) {
	profileDir := filepath.Join(t.TempDir(), "profile")
	message := launchTimeoutError(profileDir, 61234).Error()
	if !strings.Contains(message, "61234") {
		t.Fatalf("message = %q, want the port in it", message)
	}
	if strings.Contains(message, "在用这个 profile") {
		t.Fatalf("message = %q, must not claim an owner when there is none", message)
	}
}
