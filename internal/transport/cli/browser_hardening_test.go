package cli

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/gorilla/websocket"

	"github.com/mmungdong/crwu-ai/internal/platform/browser"
)

// cdpLog 记录假 CDP 收到的调用（方法名 + 参数），供断言「有没有发生某件事」。
type cdpLog struct {
	mu    sync.Mutex
	calls []string
	args  []map[string]any
}

func (l *cdpLog) note(request map[string]any) {
	l.mu.Lock()
	defer l.mu.Unlock()
	method, _ := request["method"].(string)
	params, _ := request["params"].(map[string]any)
	l.calls = append(l.calls, method)
	l.args = append(l.args, params)
}

func (l *cdpLog) count(method string) int {
	l.mu.Lock()
	defer l.mu.Unlock()
	n := 0
	for _, m := range l.calls {
		if m == method {
			n++
		}
	}
	return n
}

func (l *cdpLog) argsFor(method string) []map[string]any {
	l.mu.Lock()
	defer l.mu.Unlock()
	var out []map[string]any
	for i, m := range l.calls {
		if m == method {
			out = append(out, l.args[i])
		}
	}
	return out
}

// loggedCDP 起一个把调用记录下来的假 CDP，并按 cookies 决定是否回登录凭据。
func loggedCDP(t *testing.T, log *cdpLog, withAuthCookie bool) string {
	t.Helper()
	upgrader := websocket.Upgrader{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer func() { _ = conn.Close() }()
		for {
			_, raw, err := conn.ReadMessage()
			if err != nil {
				return
			}
			var request map[string]any
			if err := json.Unmarshal(raw, &request); err != nil {
				continue
			}
			log.note(request)
			reply := func(result map[string]any) {
				_ = conn.WriteJSON(map[string]any{"id": request["id"], "result": result})
			}
			switch request["method"] {
			case "Network.getCookies":
				cookies := []map[string]any{}
				if withAuthCookie {
					cookies = append(cookies, map[string]any{
						"name": "lianjia_token", "domain": ".ke.com", "value": sentinelCookieValue,
					})
				}
				reply(map[string]any{"cookies": cookies})
			case "Runtime.evaluate":
				reply(map[string]any{"result": map[string]any{
					"type": "string", "value": `{"href":"https://clogin.ke.com/login","title":"登录","text":"用户登录 手机快捷登录"}`,
				}})
			default:
				reply(map[string]any{})
			}
		}
	}))
	t.Cleanup(srv.Close)
	return "ws" + strings.TrimPrefix(srv.URL, "http")
}

func stubAcquire(t *testing.T, wsURL string, owned bool) browserAcquirer {
	t.Helper()
	return func(ctx context.Context, _ string, _ string, _ []string) (*browser.Browser, error) {
		client, err := browser.Dial(ctx, wsURL)
		if err != nil {
			return nil, err
		}
		return &browser.Browser{Port: 1, Owned: owned, Client: client}, nil
	}
}

// 登录循环绝不能导航：它绑定的是员工正在登录的那个标签页，
// 每 3 秒把它导航走会直接毁掉正在进行的登录（滑块/验证码都会被打断）。
func TestBrowserLoginPollsCookiesWithoutNavigating(t *testing.T) {
	// 关键用例是「凭据已经出现」：无凭据时 VerifySite 本来就不会导航，
	// 只有凭据出现后还去导航，才会把员工正在操作的标签页顶掉。
	log := &cdpLog{}
	wsURL := loggedCDP(t, log, true)
	deps := browserDeps(t, filepath.Join(t.TempDir(), "profile"), stubAcquire(t, wsURL, false))

	code, stdout, stderr := runCLI(deps, "browser", "login", "--sites", writeSitesFixture(t), "--timeout", "1ms")

	if log.count("Network.getCookies") == 0 {
		t.Fatal("login never read cookies; its success criterion is cookie presence")
	}
	if n := log.count("Page.navigate"); n != 0 {
		t.Fatalf("login navigated %d time(s); it must not touch the tab the employee is signing in on", n)
	}
	if code != 0 {
		t.Fatalf("exit = %d, want 0 once the auth cookie is present (stderr=%q)", code, stderr)
	}
	if !strings.Contains(stdout, `"ok":true`) {
		t.Fatalf("stdout = %q, want a successful envelope", stdout)
	}
}

// 附着到一个已在运行的浏览器时，登录页不会由启动分支打开 —— 必须补开，
// 否则员工面对的是一个没有登录入口的窗口。
func TestBrowserLoginOpensLoginTabsWhenAttaching(t *testing.T) {
	log := &cdpLog{}
	wsURL := loggedCDP(t, log, false)
	deps := browserDeps(t, filepath.Join(t.TempDir(), "profile"), stubAcquire(t, wsURL, false))

	_, _, _ = runCLI(deps, "browser", "login", "--sites", writeSitesFixture(t), "--timeout", "1ms")

	opened := log.argsFor("Target.createTarget")
	if len(opened) == 0 {
		t.Fatal("login attached to a running browser and never opened the login page")
	}
	found := false
	for _, params := range opened {
		if url, _ := params["url"].(string); strings.Contains(url, "clogin.ke.com") {
			found = true
		}
	}
	if !found {
		t.Fatalf("login opened %v, want the site's loginUrl", opened)
	}
}

func TestBrowserProfileReportsPermission(t *testing.T) {
	profileDir := filepath.Join(t.TempDir(), "profile")
	if err := browser.EnsureProfileDir(profileDir); err != nil {
		t.Fatalf("EnsureProfileDir() error = %v", err)
	}
	code, stdout, stderr := runCLI(browserDeps(t, profileDir, nil), "browser", "profile")
	if code != 0 {
		t.Fatalf("exit = %d, stderr=%q", code, stderr)
	}
	var envelope struct {
		OK   bool `json:"ok"`
		Data struct {
			ProfileDir string `json:"profileDir"`
			Exists     bool   `json:"exists"`
			Permission string `json:"permission"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(stdout), &envelope); err != nil {
		t.Fatalf("stdout is not the documented envelope (%v): %q", err, stdout)
	}
	if !envelope.OK {
		t.Fatalf("ok = false, want true: %q", stdout)
	}
	if envelope.Data.Permission != "0700" {
		t.Fatalf("permission = %q, want \"0700\" (the profile is the credential)", envelope.Data.Permission)
	}
}

func TestBrowserStatusUsesOkEnvelope(t *testing.T) {
	log := &cdpLog{}
	wsURL := loggedCDP(t, log, true)
	deps := browserDeps(t, filepath.Join(t.TempDir(), "profile"), stubAcquire(t, wsURL, false))

	code, stdout, stderr := runCLI(deps, "browser", "status", "--sites", writeSitesFixture(t))
	var envelope struct {
		OK   bool `json:"ok"`
		Data struct {
			Sites []struct {
				ID    string `json:"id"`
				State string `json:"state"`
			} `json:"sites"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(stdout), &envelope); err != nil {
		t.Fatalf("stdout is not the documented envelope (%v): %q", err, stdout)
	}
	if len(envelope.Data.Sites) != 1 || envelope.Data.Sites[0].ID != "ke" {
		t.Fatalf("data.sites = %+v, want the one configured site", envelope.Data.Sites)
	}
	// 页面是登录墙 → 未登录 → 退出码非 0，但 ok/data 仍然可读。
	if code == 0 {
		t.Fatalf("exit = 0 for a signed-out site (stderr=%q)", stderr)
	}
	if envelope.OK {
		t.Fatalf("ok = true for a signed-out site: %q", stdout)
	}
	if strings.Contains(stdout, sentinelCookieValue) {
		t.Fatal("a cookie value reached stdout")
	}
}
