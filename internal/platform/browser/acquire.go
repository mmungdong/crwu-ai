package browser

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/mmungdong/crwu-ai/internal/platform/scanlogin"
)

// debugPortFileName sits beside the profile, not inside it: the profile directory
// is handed whole to the browser, and anything placed there becomes profile state.
const debugPortFileName = "debug-port"

const (
	// probeTimeout bounds the cheap "is the debugger answering" check.
	probeTimeout = 800 * time.Millisecond
	// attachTimeout bounds waiting for a page target on an existing debugger.
	attachTimeout = 3 * time.Second
	// launchTimeout bounds a cold browser start.
	launchTimeout = 20 * time.Second
	// gracefulCloseWait is how long an owned browser is given to flush its cookie
	// store after being asked to close, before it is killed.
	gracefulCloseWait = 800 * time.Millisecond
)

// DebugPortFile is where the port of the helper's own browser instance is recorded.
func DebugPortFile(profileDir string) string {
	return filepath.Join(filepath.Dir(profileDir), debugPortFileName)
}

// RunningPort reports a live debugger port recorded for this profile.
//
// "The port file exists" is not enough: the process may have died and left it
// behind. The port is only reported when something actually answers on it.
func RunningPort(profileDir string) (int, bool) {
	raw, err := os.ReadFile(DebugPortFile(profileDir))
	if err != nil {
		return 0, false
	}
	port, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil || port <= 0 || port > 65535 {
		return 0, false
	}
	if !debuggerAlive(port) {
		return 0, false
	}
	return port, true
}

func debuggerAlive(port int) bool {
	client := &http.Client{Timeout: probeTimeout}
	response, err := client.Get("http://127.0.0.1:" + strconv.Itoa(port) + "/json/version")
	if err != nil {
		return false
	}
	defer func() { _ = response.Body.Close() }()
	return response.StatusCode == http.StatusOK
}

// Browser is one acquired browser session.
type Browser struct {
	Port   int
	Owned  bool
	Client *Client

	profileDir string
	process    *os.Process
	mu         sync.Mutex
	released   bool
}

// Release closes the connection and, only for an instance this process started,
// terminates the browser.
//
// It is idempotent because callers release from both a success path and a deferred
// error path, and it never kills a browser it attached to: that browser belongs to
// whoever started it, usually the employee looking at the window.
func (b *Browser) Release() error {
	if b == nil {
		return nil
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.released {
		return nil
	}
	b.released = true

	var firstErr error

	// 自有实例先请求优雅关闭再动手杀。登录态就存在 profile 的 cookie 库里，
	// 而浏览器是批量刷盘的：SIGKILL 会让员工刚刚完成的登录根本没落盘，
	// 下一次 status 就报未登录 —— 那正是这个功能存在的理由。
	if b.Owned && b.process != nil && b.Client != nil {
		closeCtx, cancel := context.WithTimeout(context.Background(), gracefulCloseWait)
		_, _ = b.Client.Call(closeCtx, "Browser.close", nil)
		cancel()
		time.Sleep(gracefulCloseWait)
	}

	if b.Client != nil {
		if err := b.Client.Close(); err != nil {
			firstErr = err
		}
		b.Client = nil
	}
	if b.profileDir != "" {
		_ = os.Remove(DebugPortFile(b.profileDir))
	}
	return firstErr
}

// Acquire returns a browser session, reusing a running debugger when there is one.
//
// Attaching first is not an optimisation. The login session lives in the profile,
// and starting a second instance against the same profile makes the browser hand
// the request to the instance that is already running — which was not started with
// a debugging port, so the new port never opens and the call hangs.
func Acquire(ctx context.Context, exe, profileDir string, urls []string) (*Browser, error) {
	if strings.TrimSpace(profileDir) == "" {
		return nil, errors.New("profile 目录为空")
	}

	if port, ok := RunningPort(profileDir); ok {
		if browser, err := attach(ctx, port, profileDir); err == nil {
			return browser, nil
		}
		// 端口活着但页面目标没起来：退回自己启动一个受控实例。
	}

	if strings.TrimSpace(exe) == "" {
		exe = scanlogin.DiscoverBrowser()
	}
	if strings.TrimSpace(exe) == "" {
		return nil, errors.New("找不到可用的 Chromium 系浏览器：请安装 Edge/Chrome，或设置 CRWU_BROWSER")
	}
	if err := EnsureProfileDir(profileDir); err != nil {
		return nil, err
	}

	port, err := FreePort()
	if err != nil {
		return nil, err
	}
	process, err := StartBrowser(exe, LaunchArgs(LaunchSpec{ProfileDir: profileDir, Port: port, URLs: urls}))
	if err != nil {
		return nil, err
	}

	wsURL, err := WaitForPageTarget(ctx, port, launchTimeout)
	if err != nil {
		stopProcess(process)
		return nil, err
	}
	client, err := Dial(ctx, wsURL)
	if err != nil {
		stopProcess(process)
		return nil, err
	}
	if err := os.WriteFile(DebugPortFile(profileDir), []byte(strconv.Itoa(port)), 0o600); err != nil {
		_ = client.Close()
		stopProcess(process)
		return nil, fmt.Errorf("写入调试端口文件失败：%w", err)
	}

	return &Browser{Port: port, Owned: true, Client: client, profileDir: profileDir, process: process}, nil
}

func attach(ctx context.Context, port int, profileDir string) (*Browser, error) {
	wsURL, err := WaitForPageTarget(ctx, port, attachTimeout)
	if err != nil {
		return nil, err
	}
	client, err := Dial(ctx, wsURL)
	if err != nil {
		return nil, err
	}
	return &Browser{Port: port, Owned: false, Client: client, profileDir: profileDir}, nil
}

// stopProcess reaps a browser this package started after a failed setup, so a
// half-configured launch does not leave an orphan window behind.
func stopProcess(process *os.Process) {
	if process == nil {
		return
	}
	_ = process.Kill()
	_, _ = process.Wait()
}
