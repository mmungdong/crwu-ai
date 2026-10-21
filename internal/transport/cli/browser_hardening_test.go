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
			case "Storage.getCookies":
				cookies := []map[string]any{}
				if withAuthCookie {
					cookies = append(cookies, map[string]any{
						"name": "lianjia_token", "domain": ".lianjia.com", "value": sentinelCookieValue,
					})
				}
				reply(map[string]any{"cookies": cookies})
			case "Network.getCookies":
				// 按 Chromium 的真实语义：不带 `urls` 只返回当前 URL 的 cookie。
				params, _ := request["params"].(map[string]any)
				if _, ok := params["urls"]; !ok {
					reply(map[string]any{"cookies": []any{}})
					return
				}
				cookies := []map[string]any{}
				if withAuthCookie {
					cookies = append(cookies, map[string]any{
						"name": "lianjia_token", "domain": ".lianjia.com", "value": sentinelCookieValue,
					})
				}
				reply(map[string]any{"cookies": cookies})
			case "Runtime.evaluate":
				reply(map[string]any{"result": map[string]any{
					"type": "string", "value": `{"href":"https://clogin.lianjia.com/login","title":"登录","text":"用户登录 手机快捷登录"}`,
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
	return func(ctx context.Context, _ string, _ string, _ []string, _ browser.AcquireOptions) (*browser.Browser, error) {
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

	if log.count("Storage.getCookies") == 0 {
		t.Fatal("login never read cookies; its success criterion is cookie presence")
	}
	// 按 URL 取 cookie 的调用在这里出现就是回归：员工登录的那个标签页未必是本站的页面，
	// 那种读法会把"已登录"看成"没有凭据"（2026-10-14 真机实测过的假阴性）。
	if n := log.count("Network.getCookies"); n != 0 {
		t.Fatalf("login used the URL-scoped cookie read %d time(s); presence must be read browser-wide", n)
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
		if url, _ := params["url"].(string); strings.Contains(url, "clogin.lianjia.com") {
			found = true
		}
	}
	if !found {
		t.Fatalf("login opened %v, want the site's loginUrl", opened)
	}
}

func TestBrowserProfileFlagRejectsRelativePath(t *testing.T) {
	// 相对路径跟着调用方的 cwd 走：这次落在仓库里，下次换个目录就是另一个空 profile，
	// 凭据库也就跟着漂。这条与 CRWU_BROWSER_PROFILE 同一条口径。
	deps := browserDeps(t, filepath.Join(t.TempDir(), "profile"), nil)
	code, _, stderr := runCLI(deps, "browser", "profile", "--profile", "relative/profile")
	if code == 0 {
		t.Fatal("--profile relative/profile was accepted; the credential directory must not follow the cwd")
	}
	if !strings.Contains(stderr, "绝对") {
		t.Fatalf("stderr = %q, want it to require an absolute path", stderr)
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

	// Only --verify-page reads a page; the default credential read sees a session
	// cookie here and reports authenticated.
	code, stdout, stderr := runCLI(deps, "browser", "status", "--sites", writeSitesFixture(t), "--verify-page")
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
	if len(envelope.Data.Sites) != 1 || envelope.Data.Sites[0].ID != "lianjia" {
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

// recoverCDP 起一个假 CDP：`probe` 决定探针看到什么，页面事实固定为一张正常业务页。
func recoverCDP(t *testing.T, log *cdpLog, probePayload string) string {
	t.Helper()
	return recoverCDPWithFacts(t, log, probePayload,
		`{"href":"https://bj.lianjia.com/ershoufang/1.html","title":"二手房","text":"在售 3室2厅"}`)
}

// recoverCDPWithFacts 与 recoverCDP 相同，但页面事实由调用方给出：靠**最终 URL** 区分的
// 挑战族（站点把人机验证页当回答）必须能构造出与目标页不一致的事实。
func recoverCDPWithFacts(t *testing.T, log *cdpLog, probePayload, factsPayload string) string {
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
			params, _ := request["params"].(map[string]any)
			expression, _ := params["expression"].(string)
			switch {
			case request["method"] == "Runtime.evaluate" && strings.Contains(expression, "geetest_slider_button"):
				reply(map[string]any{"result": map[string]any{"type": "string", "value": probePayload}})
			case request["method"] == "Runtime.evaluate" && strings.Contains(expression, "location.href"):
				reply(map[string]any{"result": map[string]any{"type": "string", "value": factsPayload}})
			case request["method"] == "Runtime.evaluate":
				reply(map[string]any{"result": map[string]any{"type": "number", "value": 200}})
			default:
				reply(map[string]any{})
			}
		}
	}))
	t.Cleanup(srv.Close)
	return "ws" + strings.TrimPrefix(srv.URL, "http")
}

func TestBrowserRecoverIsRegisteredInScheme(t *testing.T) {
	code, stdout, stderr := runCLI(envDependencies(func(string) string { return "" }), "scheme")
	if code != 0 {
		t.Fatalf("scheme exit = %d, stderr=%q", code, stderr)
	}
	if !strings.Contains(stdout, "browser recover") {
		t.Fatal("crwu scheme does not list browser recover; the documented contract and the binary disagree")
	}
}

func TestBrowserRecoverRequiresSiteURLAndAConfiguredSource(t *testing.T) {
	deps := browserDeps(t, filepath.Join(t.TempDir(), "profile"), nil)

	code, stdout, stderr := runCLI(deps, "browser", "recover", "--sites", writeSitesFixture(t))
	if code == 0 || !strings.Contains(stderr, "--site") {
		t.Fatalf("exit=%d stderr=%q, want a non-zero exit naming --site", code, stderr)
	}
	if strings.TrimSpace(stdout) != "" {
		t.Fatalf("stdout = %q, want nothing on a usage error", stdout)
	}

	code, _, stderr = runCLI(deps, "browser", "recover", "--sites", writeSitesFixture(t), "--site", "lianjia")
	if code == 0 || !strings.Contains(stderr, "--url") {
		t.Fatalf("exit=%d stderr=%q, want a non-zero exit naming --url", code, stderr)
	}

	code, _, stderr = runCLI(deps, "browser", "recover",
		"--sites", writeSitesFixture(t), "--site", "not-configured", "--url", "https://bj.lianjia.com/x.html")
	if code == 0 || !strings.Contains(stderr, "not-configured") {
		t.Fatalf("exit=%d stderr=%q, want the unknown site id named", code, stderr)
	}
}

func TestBrowserRecoverRejectsAnUnknownStrategy(t *testing.T) {
	deps := browserDeps(t, filepath.Join(t.TempDir(), "profile"), nil)
	code, _, stderr := runCLI(deps, "browser", "recover",
		"--sites", writeSitesFixture(t), "--site", "lianjia", "--url", "https://bj.lianjia.com/x.html", "--strategy", "--eval")
	if code == 0 {
		t.Fatal("recover accepted an arbitrary --strategy value; the strategy set must be closed")
	}
	if !strings.Contains(stderr, "恢复策略") {
		t.Fatalf("stderr = %q, want the rejection to name the strategy set", stderr)
	}
}

// 退出码不是判据：状态在 `data.state` 里。自动恢复没通过时既要如实报状态，也要让
// shell 调用方看到非零退出码。
func TestBrowserRecoverEmitsTheOutcomeEvenWhenNotRecovered(t *testing.T) {
	log := &cdpLog{}
	probe := `{"present":true,"family":"geetest-v3-dom","href":"https://bj.lianjia.com/ershoufang/1.html",` +
		`"title":"二手房","sliderButton":{"selector":".geetest_slider_button","box":[100,200,40,40],"hit":true},` +
		`"canvases":[],"bodyHas":{"slider":true,"successText":false,"failText":false}}`
	wsURL := recoverCDP(t, log, probe)
	deps := browserDeps(t, filepath.Join(t.TempDir(), "profile"), stubAcquire(t, wsURL, false))

	code, stdout, stderr := runCLI(deps, "browser", "recover",
		"--sites", writeSitesFixture(t), "--site", "lianjia", "--url", "https://bj.lianjia.com/ershoufang/1.html")

	if code == 0 {
		t.Fatalf("exit = 0, want non-zero for an unrecovered challenge (stderr=%q)", stderr)
	}
	var payload struct {
		OK   bool `json:"ok"`
		Data struct {
			State      string `json:"state"`
			ReasonCode string `json:"reasonCode"`
			Attempts   int    `json:"attempts"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(stdout), &payload); err != nil {
		t.Fatalf("stdout is not a JSON envelope (%v): %q", err, stdout)
	}
	if payload.OK {
		t.Fatal("envelope ok = true, want false when the challenge is still there")
	}
	if payload.Data.State != string(browser.RecoveryUnsupported) {
		t.Fatalf("state = %q, want %q", payload.Data.State, browser.RecoveryUnsupported)
	}
	if payload.Data.ReasonCode != "challenge-family-unsupported" {
		t.Fatalf("reasonCode = %q, want challenge-family-unsupported", payload.Data.ReasonCode)
	}
}

// 站点用自己的挑战页回答受保护页时（实测 2026-10-15：`bj.lianjia.com/...` →
// `hip.lianjia.com/captcha`），结论是 **waiting-user / challenge-page-waiting-user**：
// 员工在可见窗口里过一次验证就能用同一取数任务继续。它**不是** unsupported（那是"没有策略"），
// 更不是 recovered；而且这一族**不得**触发 v3 拖拽。
func TestBrowserRecoverReportsAChallengePageAsWaitingForTheHuman(t *testing.T) {
	log := &cdpLog{}
	probe := `{"present":false,"family":"","href":"https://hip.lianjia.com/captcha",` +
		`"title":"CAPTCHA","canvases":[],"bodyHas":{"slider":false,"successText":false,"failText":false}}`
	facts := `{"href":"https://hip.lianjia.com/captcha?location=x","title":"CAPTCHA","text":"人机验证 加载中"}`
	wsURL := recoverCDPWithFacts(t, log, probe, facts)
	deps := browserDeps(t, filepath.Join(t.TempDir(), "profile"), stubAcquire(t, wsURL, false))

	code, stdout, stderr := runCLI(deps, "browser", "recover",
		"--sites", writeSitesFixture(t), "--site", "lianjia", "--url", "https://bj.lianjia.com/ershoufang/1.html")

	if code == 0 {
		t.Fatalf("exit = 0 for a page that still needs a person (stderr=%q)", stderr)
	}
	var payload struct {
		OK   bool `json:"ok"`
		Data struct {
			State      string `json:"state"`
			ReasonCode string `json:"reasonCode"`
			BeforeKind string `json:"beforeKind"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(stdout), &payload); err != nil {
		t.Fatalf("stdout is not a JSON envelope (%v): %q", err, stdout)
	}
	if payload.OK {
		t.Fatal("envelope ok = true, want false while the challenge page is up")
	}
	if payload.Data.State != string(browser.RecoveryWaitingUser) {
		t.Fatalf("state = %q, want %q", payload.Data.State, browser.RecoveryWaitingUser)
	}
	if payload.Data.ReasonCode != browser.ReasonChallengePageWaitingUser {
		t.Fatalf("reasonCode = %q, want %q", payload.Data.ReasonCode, browser.ReasonChallengePageWaitingUser)
	}
	if payload.Data.BeforeKind != string(browser.ChallengeSiteChallengePage) {
		t.Fatalf("beforeKind = %q, want %q", payload.Data.BeforeKind, browser.ChallengeSiteChallengePage)
	}
	for _, params := range log.argsFor("Input.dispatchMouseEvent") {
		if params["type"] == "mousePressed" {
			t.Fatal("recover dragged the slider on a challenge page with no visible widget")
		}
	}
}

func TestBrowserRecoverSucceedsWhenThePageHasNoVisibleChallenge(t *testing.T) {
	log := &cdpLog{}
	probe := `{"present":false,"family":"","href":"https://bj.lianjia.com/ershoufang/1.html","title":"二手房",` +
		`"canvases":[],"bodyHas":{"slider":false,"successText":false,"failText":false}}`
	wsURL := recoverCDP(t, log, probe)
	deps := browserDeps(t, filepath.Join(t.TempDir(), "profile"), stubAcquire(t, wsURL, false))

	code, stdout, stderr := runCLI(deps, "browser", "recover",
		"--sites", writeSitesFixture(t), "--site", "lianjia", "--url", "https://bj.lianjia.com/ershoufang/1.html")
	if code != 0 {
		t.Fatalf("exit = %d, want 0 (stderr=%q)", code, stderr)
	}
	if !strings.Contains(stdout, `"state":"recovered"`) {
		t.Fatalf("stdout = %q, want state=recovered", stdout)
	}
	// 每次恢复都会先清一次可能卡住的左键，所以"有事件"不等于"拖了滑块"。
	for _, params := range log.argsFor("Input.dispatchMouseEvent") {
		if params["type"] == "mousePressed" {
			t.Fatal("recover replayed a drag on a page with nothing to solve")
		}
	}
}
