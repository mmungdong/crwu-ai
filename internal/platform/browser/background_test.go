package browser

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// bgSession is the CDP session id the fake hands back for the owned target.
const bgSession = "session-controlled-1"

// bgCall is one recorded CDP command plus the connection it arrived on, so a test
// can prove which target a mutation touched.
type bgCall struct {
	target string
	method string
	params map[string]any
}

// bgDebugger is a Chromium-shaped fake for the owned-target lifecycle: the
// employee's own tab is always listed first, and the owned controlled tab appears
// only after Target.createTarget.
type bgDebugger struct {
	port int

	mu        sync.Mutex
	calls     []bgCall
	created   bool
	createErr bool
	active    map[string]int
}

func startBackgroundDebugger(t *testing.T, createFails bool) *bgDebugger {
	t.Helper()
	fake := &bgDebugger{createErr: createFails, active: map[string]int{}}
	upgrader := websocket.Upgrader{}
	mux := http.NewServeMux()
	srv := httptest.NewServer(mux)
	base := "ws" + strings.TrimPrefix(srv.URL, "http")

	mux.HandleFunc("/json/version", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{
			"Browser":              "Chromium/test",
			"webSocketDebuggerUrl": base + "/ws/browser",
		})
	})
	mux.HandleFunc("/json/list", func(w http.ResponseWriter, _ *http.Request) {
		fake.mu.Lock()
		created := fake.created
		fake.mu.Unlock()
		targets := []map[string]string{{
			"id":                   "employeePage",
			"type":                 "page",
			"url":                  "https://employee.example/login",
			"webSocketDebuggerUrl": base + "/ws/employeePage",
		}}
		if created {
			targets = append(targets, map[string]string{
				"id":                   "controlled-1",
				"type":                 "page",
				"url":                  "about:blank",
				"webSocketDebuggerUrl": base + "/ws/controlled-1",
			})
		}
		_ = json.NewEncoder(w).Encode(targets)
	})
	mux.HandleFunc("/ws/", func(w http.ResponseWriter, r *http.Request) {
		target := strings.TrimPrefix(r.URL.Path, "/ws/")
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		fake.enter(target)
		defer func() {
			fake.leave(target)
			_ = conn.Close()
		}()
		for {
			_, raw, err := conn.ReadMessage()
			if err != nil {
				return
			}
			var request struct {
				ID     int            `json:"id"`
				Method string         `json:"method"`
				Params map[string]any `json:"params"`
			}
			if json.Unmarshal(raw, &request) != nil {
				continue
			}
			fake.record(target, request.Method, request.Params)
			fake.respond(conn, request.ID, request.Method)
		}
	})
	t.Cleanup(srv.Close)

	parsed, err := url.Parse(srv.URL)
	if err != nil {
		t.Fatalf("parse fake debugger url: %v", err)
	}
	fake.port, err = strconv.Atoi(parsed.Port())
	if err != nil {
		t.Fatalf("parse fake debugger port: %v", err)
	}
	return fake
}

func (f *bgDebugger) record(target, method string, params map[string]any) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, bgCall{target: target, method: method, params: params})
}

func (f *bgDebugger) enter(target string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.active[target]++
}

func (f *bgDebugger) leave(target string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.active[target]--
	if f.active[target] <= 0 {
		delete(f.active, target)
	}
}

func (f *bgDebugger) createFailed() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.createErr
}

func (f *bgDebugger) markCreated() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.created = true
}

func (f *bgDebugger) respond(conn *websocket.Conn, id int, method string) {
	reply := func(result map[string]any) {
		_ = conn.WriteJSON(map[string]any{"id": id, "result": result})
	}
	switch method {
	case "Target.createTarget":
		if f.createFailed() {
			_ = conn.WriteJSON(map[string]any{"id": id, "error": map[string]any{
				"code": -32000, "message": "cannot create browser window",
			}})
			return
		}
		f.markCreated()
		reply(map[string]any{"targetId": "controlled-1"})
	case "Target.attachToTarget":
		reply(map[string]any{"sessionId": bgSession})
	case "Target.getTargets":
		reply(map[string]any{"targetInfos": f.targetInfos()})
	case "Browser.getWindowForTarget":
		reply(map[string]any{
			"windowId": 7,
			"bounds": map[string]any{
				"left": 0, "top": 0, "width": 1440, "height": 1000, "windowState": "minimized",
			},
		})
	default:
		reply(map[string]any{})
	}
}

func (f *bgDebugger) targetInfos() []map[string]any {
	f.mu.Lock()
	created := f.created
	f.mu.Unlock()
	infos := []map[string]any{
		{"targetId": "employeePage", "type": "page", "url": "https://employee.example/login"},
	}
	if created {
		infos = append(infos, map[string]any{"targetId": "controlled-1", "type": "page", "url": "about:blank"})
	}
	return infos
}

func (f *bgDebugger) callsForMethod(method string) []bgCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []bgCall
	for _, call := range f.calls {
		if call.method == method {
			out = append(out, call)
		}
	}
	return out
}

func (f *bgDebugger) hasMethodAnywhere(method string) bool {
	return len(f.callsForMethod(method)) > 0
}

func (f *bgDebugger) hasMethodOn(target, method string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, call := range f.calls {
		if call.method == method && effectiveTarget(call) == target {
			return true
		}
	}
	return false
}

// effectiveTarget folds an explicit targetId or the owned session id back onto the
// connection's target, so an assertion is about the browser object, not the socket.
func effectiveTarget(call bgCall) string {
	if id, _ := call.params["targetId"].(string); id != "" {
		return id
	}
	if sid, _ := call.params["sessionId"].(string); sid == bgSession {
		return "controlled-1"
	}
	return call.target
}

func (f *bgDebugger) controlledSelected() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.active["controlled-1"] > 0 {
		return true
	}
	for _, call := range f.calls {
		if call.method == "Target.attachToTarget" {
			if id, _ := call.params["targetId"].(string); id == "controlled-1" {
				return true
			}
		}
	}
	return false
}

func (f *bgDebugger) activeConnections() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	total := 0
	for _, n := range f.active {
		total += n
	}
	return total
}

func (f *bgDebugger) waitForNoConnections(timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for {
		if f.activeConnections() == 0 {
			return true
		}
		if !time.Now().Before(deadline) {
			return false
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func bgIntParam(value any) int {
	switch typed := value.(type) {
	case int:
		return typed
	case float64:
		return int(typed)
	default:
		return 0
	}
}

// bgAssertForeignUntouched proves acquisition never mutated the employee's own tab.
func bgAssertForeignUntouched(t *testing.T, fake *bgDebugger) {
	t.Helper()
	for _, method := range []string{
		"Page.navigate", "Page.bringToFront", "Browser.setWindowBounds",
		"Target.closeTarget", "Target.activateTarget",
	} {
		if fake.hasMethodOn("employeePage", method) {
			t.Fatalf("acquisition sent %s to the foreign employee page; another tab must never be mutated", method)
		}
	}
}

// A background acquire against a running debugger must select its own unfocused
// target instead of attaching the employee's first tab.
func TestBackgroundAcquireCreatesAnUnfocusedRenderableOwnedTarget(t *testing.T) {
	fake := startBackgroundDebugger(t, false)
	profileDir := seedPortFile(t, fake.port)

	browser, err := AcquireWithOptions(context.Background(), "/nonexistent/browser-must-not-launch", profileDir, nil,
		AcquireOptions{Background: true, KeepAlive: true})
	if err != nil {
		t.Fatalf("AcquireWithOptions(Background) error = %v, want nil while the debugger answers", err)
	}
	defer func() { _ = browser.Release() }()

	creates := fake.callsForMethod("Target.createTarget")
	if len(creates) != 1 {
		t.Fatalf("Target.createTarget called %d times, want exactly 1 owned target "+
			"(attaching the foreign first page is the bug)", len(creates))
	}
	params := creates[0].params
	if got, _ := params["url"].(string); got != "about:blank" {
		t.Fatalf("Target.createTarget url = %q, want about:blank", got)
	}
	if got, _ := params["newWindow"].(bool); !got {
		t.Fatalf("Target.createTarget newWindow = %v, want true so the target gets its own window", params["newWindow"])
	}
	if got, _ := params["background"].(bool); !got {
		t.Fatalf("Target.createTarget background = %v, want true so focus is not stolen", params["background"])
	}
	if state, _ := params["windowState"].(string); state != "normal" {
		t.Fatalf("background target must remain renderable without minimizing or focusing: %v", params)
	}
	if !fake.controlledSelected() {
		t.Fatal("AcquireWithOptions never attached the owned target controlled-1; the session stayed on the foreign page")
	}
	bgAssertForeignUntouched(t, fake)
}

// Release must disconnect only this session and keep the owned target and browser
// for the next call, which then reuses the recorded target.
func TestBackgroundReleaseKeepsTheOwnedTargetForReuse(t *testing.T) {
	fake := startBackgroundDebugger(t, false)
	profileDir := seedPortFile(t, fake.port)

	first, err := AcquireWithOptions(context.Background(), "/nonexistent/browser-must-not-launch", profileDir, nil,
		AcquireOptions{Background: true, KeepAlive: true})
	if err != nil {
		t.Fatalf("first AcquireWithOptions error = %v, want nil", err)
	}
	if got := len(fake.callsForMethod("Target.createTarget")); got != 1 {
		t.Fatalf("first acquire created %d owned targets, want 1", got)
	}
	if err := first.Release(); err != nil {
		t.Fatalf("Release() error = %v, want nil", err)
	}
	if fake.hasMethodAnywhere("Browser.close") {
		t.Fatal("Release() closed the owned browser; KeepAlive must preserve the instance")
	}
	if fake.hasMethodAnywhere("Target.closeTarget") {
		t.Fatal("Release() closed the owned target; KeepAlive must preserve it for reuse")
	}
	if !fake.waitForNoConnections(3 * time.Second) {
		t.Fatal("Release() left this session's debugger connection open; it must disconnect only itself")
	}

	second, err := AcquireWithOptions(context.Background(), "/nonexistent/browser-must-not-launch", profileDir, nil,
		AcquireOptions{Background: true, KeepAlive: true})
	if err != nil {
		t.Fatalf("second AcquireWithOptions error = %v, want nil", err)
	}
	defer func() { _ = second.Release() }()

	if got := len(fake.callsForMethod("Target.createTarget")); got != 1 {
		t.Fatalf("reacquire created %d owned targets total, want 1: the recorded target must be reused", got)
	}
	if !fake.controlledSelected() {
		t.Fatal("reacquire did not return to the owned target")
	}
	bgAssertForeignUntouched(t, fake)
}

func TestBackgroundAcquireDoesNotFocusTheOwnedWindow(t *testing.T) {
	fake := startBackgroundDebugger(t, false)
	profileDir := seedPortFile(t, fake.port)

	browser, err := AcquireWithOptions(context.Background(), "/nonexistent/browser-must-not-launch", profileDir, nil,
		AcquireOptions{Background: true, KeepAlive: true})
	if err != nil {
		t.Fatalf("AcquireWithOptions(Background) error = %v, want nil", err)
	}
	defer func() { _ = browser.Release() }()

	if fake.hasMethodAnywhere("Page.bringToFront") {
		t.Fatal("ordinary background acquire brought the window forward; only an explicit foreground acquire may focus")
	}
}

// A foreground acquire restores and focuses the owned target only, never the
// employee's foreign tab.
func TestForegroundAcquireRestoresAndFocusesOnlyTheOwnedTarget(t *testing.T) {
	fake := startBackgroundDebugger(t, false)
	profileDir := seedPortFile(t, fake.port)

	browser, err := AcquireWithOptions(context.Background(), "/nonexistent/browser-must-not-launch", profileDir, nil,
		AcquireOptions{Background: true, Foreground: true, KeepAlive: true})
	if err != nil {
		t.Fatalf("AcquireWithOptions(Foreground) error = %v, want nil", err)
	}
	defer func() { _ = browser.Release() }()

	if got := len(fake.callsForMethod("Target.createTarget")); got != 1 {
		t.Fatalf("foreground acquire created %d owned targets, want 1", got)
	}

	getWindow := fake.callsForMethod("Browser.getWindowForTarget")
	if len(getWindow) == 0 {
		t.Fatal("foreground acquire must read the owned window before restoring it")
	}
	for _, call := range getWindow {
		if id, ok := call.params["targetId"].(string); ok && id != "controlled-1" {
			t.Fatalf("Browser.getWindowForTarget targetId = %q, want controlled-1 only", id)
		}
	}
	if fake.hasMethodOn("employeePage", "Browser.getWindowForTarget") {
		t.Fatal("foreground acquire asked about the foreign page's window")
	}

	restores := fake.callsForMethod("Browser.setWindowBounds")
	if len(restores) == 0 {
		t.Fatal("foreground acquire must restore the owned window bounds")
	}
	if got := bgIntParam(restores[0].params["windowId"]); got != 7 {
		t.Fatalf("Browser.setWindowBounds windowId = %v, want the owned window 7", restores[0].params["windowId"])
	}
	bounds, _ := restores[0].params["bounds"].(map[string]any)
	if state, _ := bounds["windowState"].(string); state == "minimized" {
		t.Fatalf("foreground acquire left the owned window minimized: %v", bounds)
	}

	if !fake.hasMethodAnywhere("Page.bringToFront") {
		t.Fatal("foreground acquire must bring the owned target to the front")
	}
	bgAssertForeignUntouched(t, fake)
}

// A failed Target.createTarget must surface an actionable error instead of falling
// back to the foreign tab or relaunching a browser.
func TestBackgroundCreateTargetFailureIsActionableAndDoesNotRelaunch(t *testing.T) {
	fake := startBackgroundDebugger(t, true)
	profileDir := seedPortFile(t, fake.port)

	browser, err := AcquireWithOptions(context.Background(), "/nonexistent/browser-must-not-launch", profileDir, nil,
		AcquireOptions{Background: true, KeepAlive: true})
	if browser != nil {
		_ = browser.Release()
		t.Fatalf("AcquireWithOptions returned a session %+v alongside a create failure", browser)
	}
	if err == nil {
		t.Fatal("AcquireWithOptions = nil error when Target.createTarget failed; it must not fall back to the foreign tab")
	}
	message := err.Error()
	if !strings.Contains(message, "cannot create browser window") && !strings.Contains(message, "Target.createTarget") {
		t.Fatalf("error = %q, want it to name the failed target creation", message)
	}
	if strings.Contains(message, "启动浏览器失败") {
		t.Fatalf("create failure fell back to launching a browser: %q", message)
	}
	if got := len(fake.callsForMethod("Target.createTarget")); got != 1 {
		t.Fatalf("Target.createTarget attempted %d times, want exactly 1", got)
	}
	if fake.hasMethodAnywhere("Browser.close") {
		t.Fatal("a failed create closed the running browser")
	}
	bgAssertForeignUntouched(t, fake)
}
