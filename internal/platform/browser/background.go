package browser

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/mmungdong/crwu-ai/internal/platform/scanlogin"
)

// ownedTargetFileName records the one CDP target this package created for a
// profile. It sits beside the debug-port file, never inside the profile: anything
// inside the profile is handed to the browser and becomes profile state.
const ownedTargetFileName = "owned-target.json"

// ownedTargetRecord binds a controlled target to the profile and port that own it,
// so a record left by another profile or an earlier browser is never reused.
type ownedTargetRecord struct {
	Profile  string `json:"profile"`
	Port     int    `json:"port"`
	TargetID string `json:"targetId"`
}

func ownedTargetFile(profileDir string) string {
	return filepath.Join(filepath.Dir(profileDir), ownedTargetFileName)
}

func (r ownedTargetRecord) matches(profileDir string, port int) bool {
	return r.TargetID != "" && r.Port == port && filepath.Clean(r.Profile) == filepath.Clean(profileDir)
}

// readOwnedTarget reads the record. A missing file is "absent"; an unreadable or
// malformed one is an error, because guessing instead could navigate or focus a
// tab the employee owns.
func readOwnedTarget(profileDir string) (ownedTargetRecord, bool, error) {
	path := ownedTargetFile(profileDir)
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return ownedTargetRecord{}, false, nil
	}
	if err != nil {
		return ownedTargetRecord{}, false, fmt.Errorf("读取自有目标记录失败（%s）：%w", path, err)
	}
	var record ownedTargetRecord
	if err := json.Unmarshal(raw, &record); err != nil {
		return ownedTargetRecord{}, false, fmt.Errorf("自有目标记录不是合法 JSON（%s）：%w", path, err)
	}
	return record, true, nil
}

func writeOwnedTarget(profileDir string, port int, targetID string) error {
	raw, err := json.Marshal(ownedTargetRecord{
		Profile: filepath.Clean(profileDir), Port: port, TargetID: targetID,
	})
	if err != nil {
		return fmt.Errorf("编码自有目标记录失败：%w", err)
	}
	if err := os.WriteFile(ownedTargetFile(profileDir), raw, 0o600); err != nil {
		return fmt.Errorf("写入自有目标记录失败：%w", err)
	}
	return nil
}

func removeOwnedTarget(profileDir string) {
	if strings.TrimSpace(profileDir) == "" {
		return
	}
	_ = os.Remove(ownedTargetFile(profileDir))
}

// browserWebSocketURL asks /json/version for the browser-level debugger websocket.
func browserWebSocketURL(ctx context.Context, client *http.Client, port int) (string, bool) {
	endpoint := "http://127.0.0.1:" + strconv.Itoa(port) + "/json/version"
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
	var payload struct {
		WebSocketDebuggerURL string `json:"webSocketDebuggerUrl"`
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		return "", false
	}
	if payload.WebSocketDebuggerURL == "" {
		return "", false
	}
	return payload.WebSocketDebuggerURL, true
}

// waitBrowserWebSocket waits for the browser-level websocket. A headed cold start
// with no startup window exposes no page target, so WaitForPageTarget would never
// succeed and the browser-level endpoint is the only way in.
func waitBrowserWebSocket(ctx context.Context, port int, timeout time.Duration) (string, error) {
	deadline := time.Now().Add(timeout)
	client := &http.Client{Timeout: time.Second}
	for {
		if ws, ok := browserWebSocketURL(ctx, client, port); ok {
			return ws, nil
		}
		if !time.Now().Before(deadline) {
			return "", fmt.Errorf("调试端口 %d 在 %s 内没有公开浏览器级 websocket", port, timeout)
		}
		select {
		case <-ctx.Done():
			return "", fmt.Errorf("等待调试端口 %d 的浏览器级 websocket 时被取消：%w", port, ctx.Err())
		case <-time.After(debuggerPollEvery):
		}
	}
}

// pageTargetByID finds the page target with this exact id in /json/list.
func pageTargetByID(ctx context.Context, client *http.Client, port int, targetID string) (string, bool) {
	if targetID == "" {
		return "", false
	}
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
		ID                   string `json:"id"`
		Type                 string `json:"type"`
		WebSocketDebuggerURL string `json:"webSocketDebuggerUrl"`
	}
	if err := json.NewDecoder(response.Body).Decode(&targets); err != nil {
		return "", false
	}
	for _, target := range targets {
		if target.Type == "page" && target.ID == targetID && target.WebSocketDebuggerURL != "" {
			return target.WebSocketDebuggerURL, true
		}
	}
	return "", false
}

func waitPageTargetByID(ctx context.Context, port int, targetID string, timeout time.Duration) (string, error) {
	deadline := time.Now().Add(timeout)
	client := &http.Client{Timeout: time.Second}
	for {
		if ws, ok := pageTargetByID(ctx, client, port, targetID); ok {
			return ws, nil
		}
		if !time.Now().Before(deadline) {
			return "", fmt.Errorf("没有找到自有页面目标 %s（调试端口 %d）", targetID, port)
		}
		select {
		case <-ctx.Done():
			return "", fmt.Errorf("等待自有页面目标 %s 时被取消：%w", targetID, ctx.Err())
		case <-time.After(debuggerPollEvery):
		}
	}
}

// dialBrowserClient connects to the browser-level debugger websocket.
func dialBrowserClient(ctx context.Context, port int, timeout time.Duration) (*Client, error) {
	wsURL, err := waitBrowserWebSocket(ctx, port, timeout)
	if err != nil {
		return nil, err
	}
	client, err := Dial(ctx, wsURL)
	if err != nil {
		return nil, fmt.Errorf("连接浏览器级调试端点失败：%w", err)
	}
	return client, nil
}

// createControlledTarget opens one unfocused, renderable window and returns its id.
// The window keeps a normal state: minimizing it makes Chromium stop producing
// frames, so Page.captureScreenshot would time out. It is created in the background
// so focus is not stolen, and a listed page is never reused: that page may be the
// employee's own tab.
func createControlledTarget(ctx context.Context, browserClient *Client, initialURL string) (string, error) {
	url := strings.TrimSpace(initialURL)
	if url == "" {
		url = "about:blank"
	}
	raw, err := browserClient.Call(ctx, "Target.createTarget", map[string]any{
		"url":         url,
		"newWindow":   true,
		"background":  true,
		"windowState": "normal",
	})
	if err != nil {
		return "", fmt.Errorf("Target.createTarget 失败：%w"+
			"（自有后台窗口没有创建成功；可改用 --background=false，或关闭占用该 profile 的窗口后重试）", err)
	}
	var payload struct {
		TargetID string `json:"targetId"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return "", fmt.Errorf("解析 Target.createTarget 响应失败：%w", err)
	}
	if payload.TargetID == "" {
		return "", errors.New("Target.createTarget 没有返回目标 id：无法确认自有窗口")
	}
	return payload.TargetID, nil
}

// openTargets opens requested pages as background tabs in the owned window. It is
// only used on a cold start: the CLI treats that session as owned, so it would
// otherwise never open the login or protected pages itself.
func openTargets(ctx context.Context, client *Client, urls []string) {
	for _, url := range urls {
		if strings.TrimSpace(url) == "" {
			continue
		}
		_, _ = client.Call(ctx, "Target.createTarget", map[string]any{
			"url":        url,
			"background": true,
		})
	}
}

func firstURL(urls []string) string {
	if len(urls) == 0 {
		return ""
	}
	return urls[0]
}

// FocusControlled restores and raises only the owned window.
//
// It is the single place a background session may affect the window, and it runs
// only for an explicit employee action (login / open). No other tab is read or
// focused, so an in-progress sign-in elsewhere is left alone.
func (b *Browser) FocusControlled(ctx context.Context) error {
	if b == nil || b.Client == nil {
		return errors.New("没有可用的浏览器连接：无法聚焦自有窗口")
	}
	if b.controlledTargetID == "" {
		return errors.New("当前会话没有自有目标：无法聚焦自有窗口")
	}
	raw, err := b.Client.Call(ctx, "Browser.getWindowForTarget", map[string]any{
		"targetId": b.controlledTargetID,
	})
	if err != nil {
		return fmt.Errorf("读取自有窗口失败：%w", err)
	}
	var payload struct {
		WindowID int `json:"windowId"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return fmt.Errorf("解析自有窗口失败：%w", err)
	}
	if payload.WindowID == 0 {
		return errors.New("自有窗口没有 windowId：无法恢复")
	}
	if _, err := b.Client.Call(ctx, "Browser.setWindowBounds", map[string]any{
		"windowId": payload.WindowID,
		"bounds":   map[string]any{"windowState": "normal"},
	}); err != nil {
		return fmt.Errorf("恢复自有窗口失败：%w", err)
	}
	if _, err := b.Client.Call(ctx, "Page.bringToFront", nil); err != nil {
		return fmt.Errorf("聚焦自有窗口失败：%w", err)
	}
	return nil
}

// acquireControlled creates or reuses one owned target for a background or
// foreground session. It never attaches the first listed page.
func acquireControlled(ctx context.Context, exe, profileDir string, urls []string, opts AcquireOptions) (*Browser, error) {
	if port, ok := RunningPort(profileDir); ok {
		browser, err := reuseOrCreateControlled(ctx, port, profileDir, opts)
		if err != nil {
			// The debugger is alive: launching a second instance would fight the
			// profile lock and hide the real failure.
			return nil, err
		}
		return browser, nil
	}
	return launchControlled(ctx, exe, profileDir, urls, opts)
}

// reuseOrCreateControlled reuses the recorded owned target when it still exists,
// and otherwise creates a fresh controlled target. A stale record is replaced; a
// malformed or unreadable one fails closed instead of picking an arbitrary page.
func reuseOrCreateControlled(ctx context.Context, port int, profileDir string, opts AcquireOptions) (*Browser, error) {
	keepAlive := opts.Background || opts.KeepAlive
	record, present, err := readOwnedTarget(profileDir)
	if err != nil {
		return nil, err
	}
	if present && record.matches(profileDir, port) {
		if wsURL, err := waitPageTargetByID(ctx, port, record.TargetID, attachTimeout); err == nil {
			client, err := Dial(ctx, wsURL)
			if err != nil {
				return nil, fmt.Errorf("连接自有页面目标失败：%w", err)
			}
			browser := &Browser{
				Port: port, Owned: false, Client: client, profileDir: profileDir,
				controlledTargetID: record.TargetID, keepAlive: keepAlive,
			}
			if err := focusControlledIfRequested(ctx, browser, opts.Foreground); err != nil {
				_ = browser.Release()
				return nil, err
			}
			return browser, nil
		}
	}

	browserClient, err := dialBrowserClient(ctx, port, attachTimeout)
	if err != nil {
		return nil, err
	}
	defer func() { _ = browserClient.Close() }()

	targetID, err := createControlledTarget(ctx, browserClient, "")
	if err != nil {
		return nil, err
	}
	pageWS, err := waitPageTargetByID(ctx, port, targetID, attachTimeout)
	if err != nil {
		return nil, err
	}
	client, err := Dial(ctx, pageWS)
	if err != nil {
		return nil, fmt.Errorf("连接自有页面目标失败：%w", err)
	}
	if err := writeOwnedTarget(profileDir, port, targetID); err != nil {
		_ = client.Close()
		return nil, err
	}
	browser := &Browser{
		Port: port, Owned: false, Client: client, profileDir: profileDir,
		controlledTargetID: targetID, keepAlive: keepAlive,
	}
	if err := focusControlledIfRequested(ctx, browser, opts.Foreground); err != nil {
		_ = browser.Release()
		return nil, err
	}
	return browser, nil
}

// launchControlled starts a browser this process owns and creates the controlled
// target over the browser-level websocket. A failure reaps only this process and
// the metadata this call wrote.
func launchControlled(ctx context.Context, exe, profileDir string, urls []string, opts AcquireOptions) (*Browser, error) {
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
	spec := LaunchSpec{
		ProfileDir: profileDir,
		Port:       port,
		// A controlled session is always headed: the sites behind these pages
		// fingerprint headless Chromium, and an employee action needs a real window.
		// Only an explicit Background suppresses the startup window. URLs are never
		// passed on the command line here: the owned target opens them itself.
		Background: opts.Background,
	}
	process, err := StartBrowser(exe, LaunchArgs(spec))
	if err != nil {
		return nil, err
	}

	browser, err := attachControlledCold(ctx, port, profileDir, urls, opts, process)
	if err != nil {
		stopProcess(process)
		_ = os.Remove(DebugPortFile(profileDir))
		removeOwnedTarget(profileDir)
		return nil, err
	}
	return browser, nil
}

func attachControlledCold(ctx context.Context, port int, profileDir string, urls []string, opts AcquireOptions, process *os.Process) (*Browser, error) {
	browserClient, err := dialBrowserClient(ctx, port, launchTimeout)
	if err != nil {
		return nil, err
	}
	defer func() { _ = browserClient.Close() }()

	targetID, err := createControlledTarget(ctx, browserClient, firstURL(urls))
	if err != nil {
		return nil, err
	}
	if len(urls) > 1 {
		openTargets(ctx, browserClient, urls[1:])
	}
	pageWS, err := waitPageTargetByID(ctx, port, targetID, launchTimeout)
	if err != nil {
		return nil, err
	}
	client, err := Dial(ctx, pageWS)
	if err != nil {
		return nil, fmt.Errorf("连接自有页面目标失败：%w", err)
	}
	if err := os.WriteFile(DebugPortFile(profileDir), []byte(strconv.Itoa(port)), 0o600); err != nil {
		_ = client.Close()
		return nil, fmt.Errorf("写入调试端口文件失败：%w", err)
	}
	if err := writeOwnedTarget(profileDir, port, targetID); err != nil {
		_ = client.Close()
		return nil, err
	}
	browser := &Browser{
		Port: port, Owned: true, Client: client, profileDir: profileDir,
		process: process, controlledTargetID: targetID,
		keepAlive: opts.Background || opts.KeepAlive,
	}
	if err := focusControlledIfRequested(ctx, browser, opts.Foreground); err != nil {
		_ = browser.Release()
		return nil, err
	}
	return browser, nil
}

func focusControlledIfRequested(ctx context.Context, browser *Browser, foreground bool) error {
	if !foreground {
		return nil
	}
	return browser.FocusControlled(ctx)
}
