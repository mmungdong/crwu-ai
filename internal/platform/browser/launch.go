package browser

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// LaunchSpec describes one browser launch.
type LaunchSpec struct {
	ProfileDir string
	Port       int
	// URLs are opened as tabs. For a login run these are the login pages, so the
	// employee can see where they are signing in.
	URLs []string
}

// debuggerPollEvery is how often the debugger endpoint is retried.
const debuggerPollEvery = 200 * time.Millisecond

// LaunchArgs builds the browser command line.
//
// It is a pure function on purpose: the flags that must (and must not) be present
// are the load-bearing part of this package, and they are only trustworthy if a
// test can assert them without launching anything.
//
// Two flags carry a decision worth recording:
//
//   - `--no-sandbox` is required: the DSH file sandbox denies Chromium's own
//     sandbox setup, and without this flag the browser dies with SIGTRAP before
//     the debugger ever opens. The cost is a renderer without its sandbox; the
//     mitigations are the dedicated profile and the fact that only caller-declared
//     sites are opened.
//   - there is deliberately no `--headless`: headless Chromium is fingerprinted
//     and refused by the sites this exists to read.
func LaunchArgs(spec LaunchSpec) []string {
	args := []string{
		"--remote-debugging-port=" + strconv.Itoa(spec.Port),
		"--user-data-dir=" + spec.ProfileDir,
		"--no-sandbox",
		"--disable-gpu",
		"--disable-dev-shm-usage",
		"--remote-allow-origins=*",
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-crashpad",
		"--window-size=1440,1000",
	}
	return append(args, spec.URLs...)
}

// FreePort reserves and releases a loopback port, returning the number.
//
// The port is free at reservation time only; the caller must tolerate the window
// between this call and the browser binding it.
func FreePort() (int, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, fmt.Errorf("取空闲端口失败：%w", err)
	}
	defer func() { _ = listener.Close() }()
	return listener.Addr().(*net.TCPAddr).Port, nil
}

// StartBrowser launches the browser detached. It does not wait: the process is
// owned by whoever calls StartBrowser, and releasing it is that caller's job.
func StartBrowser(exe string, args []string) (*os.Process, error) {
	if strings.TrimSpace(exe) == "" {
		return nil, errors.New("浏览器可执行文件为空")
	}
	cmd := exec.Command(exe, args...)
	cmd.Stdout = io.Discard
	cmd.Stderr = io.Discard
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("启动浏览器失败（%s）：%w", exe, err)
	}
	return cmd.Process, nil
}

// WaitForPageTarget polls the debugger until a page target exposes a websocket.
//
// It reports the port in every failure: a browser that is running while its
// debugger is unreachable is the shape that is hardest to diagnose from the
// outside, and the port is the one fact that distinguishes it.
func WaitForPageTarget(ctx context.Context, port int, timeout time.Duration) (string, error) {
	deadline := time.Now().Add(timeout)
	client := &http.Client{Timeout: time.Second}
	for {
		if ws, ok := pageTargetWS(ctx, client, port); ok {
			return ws, nil
		}
		if !time.Now().Before(deadline) {
			return "", fmt.Errorf("调试端口 %d 在 %s 内没有可用的页面目标", port, timeout)
		}
		select {
		case <-ctx.Done():
			return "", fmt.Errorf("等待调试端口 %d 时被取消：%w", port, ctx.Err())
		case <-time.After(debuggerPollEvery):
		}
	}
}

func pageTargetWS(ctx context.Context, client *http.Client, port int) (string, bool) {
	endpoint := "http://127.0.0.1:" + strconv.Itoa(port) + "/json/list"
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return "", false
	}
	response, err := client.Do(request)
	if err != nil {
		return "", false
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		return "", false
	}
	var targets []struct {
		Type                 string `json:"type"`
		WebSocketDebuggerURL string `json:"webSocketDebuggerUrl"`
	}
	if err := json.NewDecoder(response.Body).Decode(&targets); err != nil {
		return "", false
	}
	for _, target := range targets {
		if target.Type == "page" && target.WebSocketDebuggerURL != "" {
			return target.WebSocketDebuggerURL, true
		}
	}
	return "", false
}
