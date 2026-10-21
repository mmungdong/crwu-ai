package browser

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/mmungdong/crwu-ai/internal/platform/scanlogin"
)

// debugPortFileName is the prefix of the per-profile debug-port record. It sits
// beside the profile, not inside it: the profile directory is handed whole to the
// browser, and anything placed there becomes profile state.
const debugPortFileName = "debug-port"

// debugPortRecord binds a debugger port to the profile that owns it.
//
// The file used to hold a bare port number and to be shared by every profile under
// one parent: `~/.crwu/browser/profile` and `~/.crwu/browser/profile-test` read the
// same bytes, so the second profile attached to the first profile's browser — its
// cookies and its tabs. The owner is part of the record now, and so is the name.
type debugPortRecord struct {
	Profile string `json:"profile"`
	Port    int    `json:"port"`
}

// normalizeProfileDir is the identity used for owner comparison: absolute when the
// caller's path can be made absolute, cleaned, and case-folded on Windows, where the
// same directory can arrive with a different case on each call.
func normalizeProfileDir(dir string) string {
	cleaned := filepath.Clean(strings.TrimSpace(dir))
	if abs, err := filepath.Abs(cleaned); err == nil {
		cleaned = abs
	}
	if runtime.GOOS == "windows" {
		return strings.ToLower(cleaned)
	}
	return cleaned
}

// devToolsActivePortName is Chromium's own discovery file. It is read as a second
// source because our own file can be missing (deleted by an earlier run, cleaned by
// the employee) while the browser is still running.
const devToolsActivePortName = "DevToolsActivePort"

// singletonLockName is the browser's profile lock; its target carries the pid of the
// instance that owns the profile. That pid is the third discovery source: it lets us
// read the owner's command line and recover the debug port we lost track of.
const singletonLockName = "SingletonLock"

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
//
// The name carries a digest of the profile path so two profiles under one parent
// directory keep separate records instead of overwriting each other.
func DebugPortFile(profileDir string) string {
	clean := filepath.Clean(strings.TrimSpace(profileDir))
	sum := sha256.Sum256([]byte(normalizeProfileDir(clean)))
	return filepath.Join(filepath.Dir(clean), debugPortFileName+"-"+hex.EncodeToString(sum[:4]))
}

func writeDebugPort(profileDir string, port int) error {
	raw, err := json.Marshal(debugPortRecord{Profile: normalizeProfileDir(profileDir), Port: port})
	if err != nil {
		return fmt.Errorf("编码调试端口记录失败：%w", err)
	}
	if err := os.WriteFile(DebugPortFile(profileDir), raw, 0o600); err != nil {
		return fmt.Errorf("写入调试端口文件失败：%w", err)
	}
	return nil
}

// RunningPort reports a live debugger port for this profile.
//
// Three sources, in order, because "the browser stays open" is the normal state of
// this feature (the login window must stay open for the employee) while every
// command releases only *its own* connection:
//
//  1. our own `debug-port` file (written when we launched the instance);
//  2. Chromium's `DevToolsActivePort` inside the profile;
//  3. the pid in `SingletonLock`, whose command line carries the port.
//
// The third one is what makes this robust: an earlier command deleted the file (or
// the employee cleaned it up) while the browser is still running, and without a
// fallback the next command cannot see it — it launches a second instance, Chromium
// hands the request to the running one, the new port never opens, and the call dies
// after a 20s timeout. Observed exactly that on a real machine (2026-10-14): a
// signed-in employee, an open window, and "无法获得浏览器会话" on every check.
//
// "A port was recorded" is never enough on its own: the process may have died and
// left the file behind, so every candidate must actually answer.
func RunningPort(profileDir string) (int, bool) {
	for _, candidate := range []int{
		portFromFile(DebugPortFile(profileDir), profileDir),
		portFromDevToolsActivePort(profileDir),
		portFromProfileLock(profileDir),
	} {
		if candidate > 0 && debuggerAlive(candidate) {
			return candidate, true
		}
	}
	return 0, false
}

// portFromFile reads this profile's recorded port.
//
// A record that does not name exactly this profile is not a candidate: it belongs to
// a sibling profile, or it is the legacy bare number, which carries no owner at all
// and therefore cannot be shown to belong here. A browser still running under a
// legacy record is found through DevToolsActivePort or SingletonLock instead.
func portFromFile(path string, profileDir string) int {
	raw, err := os.ReadFile(path)
	if err != nil {
		return 0
	}
	var record debugPortRecord
	if err := json.Unmarshal(raw, &record); err != nil {
		return 0
	}
	if record.Profile == "" || record.Profile != normalizeProfileDir(profileDir) {
		return 0
	}
	if record.Port <= 0 || record.Port > 65535 {
		return 0
	}
	return record.Port
}

// portFromDevToolsActivePort reads Chromium's own discovery file (port on line 1).
func portFromDevToolsActivePort(profileDir string) int {
	raw, err := os.ReadFile(filepath.Join(profileDir, devToolsActivePortName))
	if err != nil {
		return 0
	}
	line := strings.TrimSpace(strings.SplitN(string(raw), "\n", 2)[0])
	port, err := strconv.Atoi(line)
	if err != nil || port <= 0 || port > 65535 {
		return 0
	}
	return port
}

// portFromProfileLock asks the process that holds the profile lock for its port.
func portFromProfileLock(profileDir string) int {
	pid := profileLockPid(profileDir)
	if pid <= 0 {
		return 0
	}
	command, err := processCommandLine(pid)
	if err != nil {
		return 0
	}
	port, _ := portFromCommandLine(command)
	return port
}

// profileLockPid reads the pid out of the browser's profile lock.
//
// Chromium writes `<host>-<pid>` (a symlink on macOS/Linux, a file on Windows).
// An unreadable or stale lock simply means "no candidate".
func profileLockPid(profileDir string) int {
	path := filepath.Join(profileDir, singletonLockName)
	raw, err := os.Readlink(path)
	if err != nil {
		content, readErr := os.ReadFile(path)
		if readErr != nil {
			return 0
		}
		raw = string(content)
	}
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 0
	}
	index := strings.LastIndex(raw, "-")
	if index < 0 || index == len(raw)-1 {
		return 0
	}
	pid, err := strconv.Atoi(raw[index+1:])
	if err != nil || pid <= 0 {
		return 0
	}
	return pid
}

// portFromCommandLine extracts `--remote-debugging-port=<n>` from a command line.
func portFromCommandLine(command string) (int, bool) {
	const flag = "--remote-debugging-port="
	index := strings.Index(command, flag)
	if index < 0 {
		return 0, false
	}
	rest := command[index+len(flag):]
	end := strings.IndexAny(rest, " \t\n\r\"")
	if end >= 0 {
		rest = rest[:end]
	}
	port, err := strconv.Atoi(strings.Trim(rest, "\"'"))
	if err != nil || port <= 0 || port > 65535 {
		return 0, false
	}
	return port, true
}

// launchTimeoutError explains a cold start that never opened its debugger port.
//
// The bare "调试端口 N 没有可用的页面目标" that used to be reported here is
// unactionable: in practice the cause is almost always "the profile is already held
// by a browser we could not see", and the fix is to close that window or retry.
func launchTimeoutError(profileDir string, port int) error {
	base := fmt.Sprintf("调试端口 %d 在 %s 内没有可用的页面目标", port, launchTimeout)
	pid := profileLockPid(profileDir)
	if pid <= 0 {
		return errors.New(base)
	}
	return fmt.Errorf("%s：已经有一个浏览器在用这个 profile（pid %d）。"+
		"它可能正开着登录窗口（调试端口没公开）：请稍后重试；若一直失败，请先关掉那个窗口再重试", base, pid)
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
	// controlledTargetID is the owned page target this session selected or created.
	// It is empty for a legacy first-page session.
	controlledTargetID string
	// keepAlive preserves the browser, process, port and target on Release so the
	// next command can reuse the same owned window.
	keepAlive bool
	mu        sync.Mutex
	released  bool
}

// Release closes the connection and, only for an instance this process started,
// terminates the browser.
//
// It is idempotent because callers release from both a success path and a deferred
// error path, and it never kills a browser it attached to: that browser belongs to
// whoever started it, usually the employee looking at the window. A background or
// keep-alive session is preserved whole — closing only this connection — so the
// next command reuses the same owned window.
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

	// 自有后台/keep-alive 实例只断开本次连接：窗口、端口和自有目标要留给下一条命令。
	// 其余自有实例先请求优雅关闭再动手杀。登录态就存在 profile 的 cookie 库里，
	// 而浏览器是批量刷盘的：SIGKILL 会让员工刚刚完成的登录根本没落盘，
	// 下一次 status 就报未登录 —— 那正是这个功能存在的理由。
	if b.Owned && b.process != nil && b.Client != nil && !b.keepAlive {
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
	// 端口文件是**下一条命令发现这个浏览器**的线索。只有端口确实没人应答时才清掉它：
	// 浏览器由员工留着（登录窗口），我们释放的只是自己这一条连接。
	if b.profileDir != "" && !debuggerAlive(b.Port) {
		_ = os.Remove(DebugPortFile(b.profileDir))
		removeOwnedTarget(b.profileDir)
	}
	return firstErr
}

// AcquireOptions are the acquisition choices that are not part of the target.
type AcquireOptions struct {
	// Headless launches a windowless instance. Only a credential read (no page
	// load) may ask for it; an attached browser is never relaunched either way.
	Headless bool
	// Background launches an unfocused, renderable headed instance with no startup
	// window and reuses one owned target across calls.
	Background bool
	// Foreground restores only this session's own window before an explicit
	// employee action (login / open). Ordinary background acquisition never does.
	Foreground bool
	// KeepAlive releases only this connection and preserves the owned instance,
	// its port and its target record for the next call.
	KeepAlive bool
}

// Acquire returns a browser session, reusing a running debugger when there is one.
//
// Attaching first is not an optimisation. The login session lives in the profile,
// and starting a second instance against the same profile makes the browser hand
// the request to the instance that is already running — which was not started with
// a debugging port, so the new port never opens and the call hangs.
func Acquire(ctx context.Context, exe, profileDir string, urls []string) (*Browser, error) {
	return AcquireWithOptions(ctx, exe, profileDir, urls, AcquireOptions{})
}

// AcquireWithOptions is Acquire with explicit launch options.
//
// A background or foreground session never adopts the first listed page. It
// reuses the recorded owned target or creates a fresh one, so a live debugger is
// handled without touching the employee's own tab. Default credential and attach
// callers keep the legacy first-page behavior.
func AcquireWithOptions(ctx context.Context, exe, profileDir string, urls []string, opts AcquireOptions) (*Browser, error) {
	if strings.TrimSpace(profileDir) == "" {
		return nil, errors.New("profile 目录为空")
	}

	// A background or foreground session owns one target and never adopts the
	// employee's first page; only the legacy credential/attach callers still do.
	if opts.Background || opts.Foreground {
		return acquireControlled(ctx, exe, profileDir, urls, opts)
	}

	if port, ok := RunningPort(profileDir); ok {
		if browser, err := attach(ctx, port, profileDir); err == nil {
			browser.keepAlive = opts.KeepAlive
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
	spec := LaunchSpec{ProfileDir: profileDir, Port: port, URLs: urls, Headless: opts.Headless, Background: opts.Background}
	process, err := StartBrowser(exe, LaunchArgs(spec))
	if err != nil {
		return nil, err
	}

	wsURL, err := WaitForPageTarget(ctx, port, launchTimeout)
	if err != nil {
		stopProcess(process)
		return nil, launchTimeoutError(profileDir, port)
	}
	client, err := Dial(ctx, wsURL)
	if err != nil {
		stopProcess(process)
		return nil, err
	}
	if err := writeDebugPort(profileDir, port); err != nil {
		_ = client.Close()
		stopProcess(process)
		return nil, err
	}

	return &Browser{
		Port: port, Owned: true, Client: client, profileDir: profileDir,
		process: process, keepAlive: opts.KeepAlive,
	}, nil
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
