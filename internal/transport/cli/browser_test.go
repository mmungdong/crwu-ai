package cli

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/mmungdong/crwu-ai/internal/platform/browser"
)

// errNoBrowserInTest 用于「拿不到浏览器」这条路径。
var errNoBrowserInTest = errors.New("no browser available in test")

// sentinelCookieValue 是一个绝不允许出现在任何输出里的值。
const sentinelCookieValue = "SENTINEL-COOKIE-VALUE-DO-NOT-LEAK"

const sitesFixture = `[{
	"id": "lianjia",
	"label": "链家",
	"loginUrl": "https://clogin.lianjia.com/login",
	"protectedUrl": "https://bj.lianjia.com/ershoufang/chaoyang/",
	"authCookie": "lianjia_token",
	"authDomains": [".lianjia.com"]
}]`

func writeSitesFixture(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "sites.json")
	if err := os.WriteFile(path, []byte(sitesFixture), 0o600); err != nil {
		t.Fatalf("write sites fixture: %v", err)
	}
	return path
}

// browserDeps 造一个只把浏览器获取替换成桩的依赖集合。
func browserDeps(t *testing.T, profileDir string, acquire browserAcquirer) Dependencies {
	t.Helper()
	deps := envDependencies(func(key string) string {
		if key == "CRWU_BROWSER_PROFILE" {
			return profileDir
		}
		return ""
	})
	browserAcquireOverride = acquire
	browserFocusOverride = nil
	t.Cleanup(func() {
		browserAcquireOverride = nil
		browserFocusOverride = nil
	})
	return deps
}

// fakeCDPForCLI 是一个最小假 CDP：回一条带哨兵值的 cookie，并把页面表现为登录墙。
func fakeCDPForCLI(t *testing.T) string {
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
			reply := func(result map[string]any) {
				_ = conn.WriteJSON(map[string]any{"id": request["id"], "result": result})
			}
			switch request["method"] {
			case "Storage.getCookies":
				// 浏览器级读：这是"这个浏览器里有没有会话"的唯一正确形状。
				reply(map[string]any{"cookies": []map[string]any{
					{"name": "lianjia_token", "domain": ".lianjia.com", "value": sentinelCookieValue},
				}})
			case "Network.getCookies":
				// 假 CDP 按 Chromium 的真实语义回答：`Network.getCookies` 是按**当前 URL**
				// 取 cookie 的，不带 `urls` 时只能看到当前页面的那几条（这里 about:blank → 空）。
				params, _ := request["params"].(map[string]any)
				if _, ok := params["urls"]; !ok {
					reply(map[string]any{"cookies": []any{}})
					return
				}
				reply(map[string]any{"cookies": []map[string]any{
					{"name": "lianjia_token", "domain": ".lianjia.com", "value": sentinelCookieValue},
				}})
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

func TestBrowserLoginRequiresSitesFlag(t *testing.T) {
	code, stdout, stderr := runCLI(browserDeps(t, t.TempDir(), nil), "browser", "login")
	if code == 0 {
		t.Fatalf("browser login exit = 0, want non-zero without --sites")
	}
	if !strings.Contains(stderr, "--sites") {
		t.Fatalf("stderr = %q, want it to name --sites", stderr)
	}
	if strings.TrimSpace(stdout) != "" {
		t.Fatalf("stdout = %q, want nothing on a usage error", stdout)
	}
}

func TestBrowserFetchRequiresURLAndOut(t *testing.T) {
	deps := browserDeps(t, t.TempDir(), nil)

	code, _, stderr := runCLI(deps, "browser", "fetch")
	if code == 0 || !strings.Contains(stderr, "--url") {
		t.Fatalf("exit=%d stderr=%q, want a non-zero exit naming --url", code, stderr)
	}

	code, _, stderr = runCLI(deps, "browser", "fetch", "--url", "https://example.invalid/")
	if code == 0 || !strings.Contains(stderr, "--out") {
		t.Fatalf("exit=%d stderr=%q, want a non-zero exit naming --out", code, stderr)
	}
}

func TestBrowserProfileEmitsJSON(t *testing.T) {
	profileDir := filepath.Join(t.TempDir(), "profile")
	code, stdout, stderr := runCLI(browserDeps(t, profileDir, nil), "browser", "profile")
	if code != 0 {
		t.Fatalf("browser profile exit = %d, stderr=%q", code, stderr)
	}
	var payload struct {
		OK   bool `json:"ok"`
		Data struct {
			ProfileDir string `json:"profileDir"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(stdout), &payload); err != nil {
		t.Fatalf("stdout is not JSON (%v): %q", err, stdout)
	}
	if !payload.OK {
		t.Fatalf("ok = false: %q", stdout)
	}
	if payload.Data.ProfileDir != profileDir {
		t.Fatalf("data.profileDir = %q, want %q", payload.Data.ProfileDir, profileDir)
	}
}

func TestBrowserStatusEmitsJSONAndNeverLeaksCookieValues(t *testing.T) {
	wsURL := fakeCDPForCLI(t)
	acquire := func(ctx context.Context, _ string, _ string, _ []string, _ browser.AcquireOptions) (*browser.Browser, error) {
		client, err := browser.Dial(ctx, wsURL)
		if err != nil {
			return nil, err
		}
		return &browser.Browser{Port: 1, Owned: false, Client: client}, nil
	}
	deps := browserDeps(t, filepath.Join(t.TempDir(), "profile"), acquire)

	code, stdout, stderr := runCLI(deps, "browser", "status", "--sites", writeSitesFixture(t), "--verify-page")
	if code == 0 {
		t.Fatalf("browser status exit = 0, want non-zero for a signed-out site (stderr=%q)", stderr)
	}
	var payload struct {
		Data struct {
			Sites []struct {
				ID    string `json:"id"`
				State string `json:"state"`
			} `json:"sites"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(stdout), &payload); err != nil {
		t.Fatalf("stdout is not JSON (%v): %q", err, stdout)
	}
	if len(payload.Data.Sites) != 1 || payload.Data.Sites[0].ID != "lianjia" {
		t.Fatalf("data.sites = %+v, want the one configured site", payload.Data.Sites)
	}
	if payload.Data.Sites[0].State != string(browser.LoginUnauthenticated) {
		t.Fatalf("state = %q, want %q (the fake page is a login wall)",
			payload.Data.Sites[0].State, browser.LoginUnauthenticated)
	}
	if strings.Contains(stdout, sentinelCookieValue) || strings.Contains(stderr, sentinelCookieValue) {
		t.Fatal("a cookie value reached the output; cookie values must never leave the process")
	}
}

func TestBrowserStatusReportsUnknownWhenNoBrowserIsAvailable(t *testing.T) {
	acquire := func(context.Context, string, string, []string, browser.AcquireOptions) (*browser.Browser, error) {
		return nil, errNoBrowserInTest
	}
	deps := browserDeps(t, filepath.Join(t.TempDir(), "profile"), acquire)

	code, stdout, _ := runCLI(deps, "browser", "status", "--sites", writeSitesFixture(t))
	if code == 0 {
		t.Fatal("browser status exit = 0, want non-zero when no browser is available")
	}
	var payload struct {
		Data struct {
			Sites []struct {
				State string `json:"state"`
			} `json:"sites"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(stdout), &payload); err != nil {
		t.Fatalf("stdout is not JSON (%v): %q", err, stdout)
	}
	if len(payload.Data.Sites) != 1 || payload.Data.Sites[0].State != string(browser.LoginUnknown) {
		t.Fatalf("data.sites = %+v, want a single site in state %q", payload.Data.Sites, browser.LoginUnknown)
	}
}

func TestBrowserSchemeIsJSONOnly(t *testing.T) {
	code, stdout, stderr := runCLI(browserDeps(t, t.TempDir(), nil), "scheme", "browser")
	if code != 0 {
		t.Fatalf("scheme browser exit = %d, stderr=%q", code, stderr)
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(stdout), &payload); err != nil {
		t.Fatalf("scheme stdout is not JSON (%v): %q", err, stdout)
	}
}

// twoSiteSitesFixture is two independent sources (链家 + 房天下); it pins "every
// selected site has to pass on its own".
const twoSiteSitesFixture = `[
	{"id": "lianjia", "label": "链家", "loginUrl": "https://clogin.lianjia.com/login?service=x",
	 "protectedUrl": "https://bj.lianjia.com/ershoufang/", "authCookie": "lianjia_token", "authDomains": [".lianjia.com"]},
	{"id": "fang", "label": "房天下", "loginUrl": "https://passport.fang.com/login",
	 "protectedUrl": "https://bj.fang.com/ershoufang/", "authCookie": "fang_token", "authDomains": [".fang.com"]}
]`

// TestBrowserStatusReadsCredentialsWithoutNavigating is the end-to-end replay of the
// 2026-10-14 false negative, and it pins the shape of the default status: read the
// stored credentials, nothing else.
//
// After the employee signs in, both sites' credentials are in the profile (measured
// on a real machine: one on `.lianjia.com` and one on `.fang.com`). The old code read
// them with `Network.getCookies` (no urls) and the attached tab was `about:blank` →
// zero cookies → both sites reported `unauthenticated`, telling a signed-in employee
// there was no credential.
//
// The fake CDP answers with Chromium's real semantics (URL-scoped vs browser-wide),
// so any regression to per-URL cookie reads fails here instead of on an employee's
// machine. It also pins "a credential read loads no page": no navigation, no new tab,
// and therefore a headless launch.
func TestBrowserStatusReadsCredentialsWithoutNavigating(t *testing.T) {
	log := &cdpLog{}
	wsURL := signedInCDP(t, log)
	var opts browser.AcquireOptions
	acquire := func(ctx context.Context, _ string, _ string, _ []string, got browser.AcquireOptions) (*browser.Browser, error) {
		opts = got
		client, err := browser.Dial(ctx, wsURL)
		if err != nil {
			return nil, err
		}
		return &browser.Browser{Port: 1, Owned: false, Client: client}, nil
	}
	deps := browserDeps(t, filepath.Join(t.TempDir(), "profile"), acquire)

	path := filepath.Join(t.TempDir(), "sites.json")
	if err := os.WriteFile(path, []byte(twoSiteSitesFixture), 0o600); err != nil {
		t.Fatalf("write sites fixture: %v", err)
	}

	code, stdout, stderr := runCLI(deps, "browser", "status", "--sites", path)
	if code != 0 {
		t.Fatalf("browser status exit = %d for a signed-in profile, want 0 (stderr=%q stdout=%q)", code, stderr, stdout)
	}
	var payload struct {
		Data struct {
			Sites []struct {
				ID        string `json:"id"`
				State     string `json:"state"`
				Verdict   string `json:"verdict"`
				ExpiresAt string `json:"expiresAt"`
			} `json:"sites"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(stdout), &payload); err != nil {
		t.Fatalf("stdout is not JSON (%v): %q", err, stdout)
	}
	if len(payload.Data.Sites) != 2 {
		t.Fatalf("data.sites = %+v, want both configured sites", payload.Data.Sites)
	}
	for _, site := range payload.Data.Sites {
		if site.State != string(browser.LoginAuthenticated) {
			t.Fatalf("site %s state = %q, want %q", site.ID, site.State, browser.LoginAuthenticated)
		}
		if site.ExpiresAt == "" {
			t.Fatalf("site %s has no expiresAt; the panel needs the credential's expiry", site.ID)
		}
		if site.Verdict != "" {
			t.Fatalf("site %s verdict = %q, want empty without --verify-page", site.ID, site.Verdict)
		}
	}
	if strings.Contains(stdout, sentinelCookieValue) {
		t.Fatal("a cookie value reached the output")
	}

	// A credential read: no page navigation and no new tab.
	if n := log.count("Page.navigate"); n != 0 {
		t.Fatalf("status navigated %d time(s) without --verify-page; a credential read must not load a page", n)
	}
	if n := log.count("Target.createTarget"); n != 0 {
		t.Fatalf("status opened %d tab(s) without --verify-page; a credential read passes no URL at launch", n)
	}
	// With no running instance this path must launch headless: read the credential, open no window.
	if !opts.Headless {
		t.Fatal("status did not ask for a headless instance; a credential read must not open a window")
	}
	argv := browser.LaunchArgs(browser.LaunchSpec{ProfileDir: "p", Port: 1, Headless: opts.Headless})
	if !strings.Contains(strings.Join(argv, " "), "--headless=new") {
		t.Fatalf("a fresh status instance would launch without --headless=new: %v", argv)
	}
}

// TestBrowserStatusKeepsAnAttachedBrowserAlive pins the release semantics: a session
// this process merely attached to belongs to whoever started it — usually the
// employee looking at the login window — so status must not close it.
func TestBrowserStatusKeepsAnAttachedBrowserAlive(t *testing.T) {
	wsURL := signedInCDP(t, &cdpLog{})
	var session *browser.Browser
	acquire := func(ctx context.Context, _ string, _ string, _ []string, _ browser.AcquireOptions) (*browser.Browser, error) {
		client, err := browser.Dial(ctx, wsURL)
		if err != nil {
			return nil, err
		}
		session = &browser.Browser{Port: 1, Owned: false, Client: client}
		return session, nil
	}
	deps := browserDeps(t, filepath.Join(t.TempDir(), "profile"), acquire)

	code, _, stderr := runCLI(deps, "browser", "status", "--sites", writeSitesFixture(t))
	if code != 0 {
		t.Fatalf("browser status exit = %d, want 0 (stderr=%q)", code, stderr)
	}
	// Release() closes the client and nils it, so a live client that still answers is
	// direct evidence that the attached browser was left alone.
	if session == nil || session.Client == nil {
		t.Fatal("status released an attached browser; only an instance this process started may be terminated")
	}
	if _, err := session.Client.Call(context.Background(), "Storage.getCookies", nil); err != nil {
		t.Fatalf("the attached session was closed after status (%v)", err)
	}
}

// TestBrowserStatusReportsACredentialExpiry pins the human-readable expiry: the panel
// says "登录有效到 …" and the employee can see how long the session still lasts.
func TestBrowserStatusReportsACredentialExpiry(t *testing.T) {
	expires := time.Unix(time.Now().Add(20*time.Hour).Unix(), 0)
	deps := browserDeps(t, filepath.Join(t.TempDir(), "profile"),
		stubAcquire(t, challengeCDP(t, &cdpLog{}, float64(expires.Unix())), false))

	code, stdout, stderr := runCLI(deps, "browser", "status", "--sites", writeSitesFixture(t))
	if code != 0 {
		t.Fatalf("browser status exit = %d for a valid credential (stderr=%q)", code, stderr)
	}
	var payload struct {
		Data struct {
			Sites []struct {
				State         string `json:"state"`
				Reason        string `json:"reason"`
				Verdict       string `json:"verdict"`
				ExpiresAt     string `json:"expiresAt"`
				SessionCookie bool   `json:"sessionCookie"`
			} `json:"sites"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(stdout), &payload); err != nil {
		t.Fatalf("stdout is not JSON (%v): %q", err, stdout)
	}
	if len(payload.Data.Sites) != 1 {
		t.Fatalf("data.sites = %+v, want one site", payload.Data.Sites)
	}
	got := payload.Data.Sites[0]
	if got.State != string(browser.LoginAuthenticated) {
		t.Fatalf("state = %q, want %q", got.State, browser.LoginAuthenticated)
	}
	if got.SessionCookie {
		t.Fatal("sessionCookie = true for a cookie that carries an expiry")
	}
	if _, err := time.Parse(time.RFC3339, got.ExpiresAt); err != nil {
		t.Fatalf("expiresAt = %q, want RFC3339 (%v)", got.ExpiresAt, err)
	}
	if want := "已登录（到期 " + expires.Local().Format("2006-01-02 15:04") + "）"; got.Reason != want {
		t.Fatalf("reason = %q, want %q", got.Reason, want)
	}
	// No --verify-page: the page is not read, so there is no verdict.
	if got.Verdict != "" {
		t.Fatalf("verdict = %q, want empty in cookie-only mode", got.Verdict)
	}
}

// TestBrowserStatusReportsAnExpiredCredential keeps the other half: a credential that
// is present but lapsed is unauthenticated, and the reason names when it lapsed so
// the employee can tell "expired" from "never signed in".
func TestBrowserStatusReportsAnExpiredCredential(t *testing.T) {
	expiredAt := time.Unix(time.Now().Add(-time.Hour).Unix(), 0)
	deps := browserDeps(t, filepath.Join(t.TempDir(), "profile"),
		stubAcquire(t, challengeCDP(t, &cdpLog{}, float64(expiredAt.Unix())), false))

	code, stdout, _ := runCLI(deps, "browser", "status", "--sites", writeSitesFixture(t))
	if code == 0 {
		t.Fatal("browser status exit = 0, want non-zero for an expired credential")
	}
	var payload struct {
		Data struct {
			Sites []struct {
				State     string `json:"state"`
				Reason    string `json:"reason"`
				ExpiresAt string `json:"expiresAt"`
			} `json:"sites"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(stdout), &payload); err != nil {
		t.Fatalf("stdout is not JSON (%v): %q", err, stdout)
	}
	if len(payload.Data.Sites) != 1 {
		t.Fatalf("data.sites = %+v, want one site", payload.Data.Sites)
	}
	got := payload.Data.Sites[0]
	if got.State != string(browser.LoginUnauthenticated) {
		t.Fatalf("state = %q, want %q for an expired credential", got.State, browser.LoginUnauthenticated)
	}
	if got.ExpiresAt != "" {
		t.Fatalf("expiresAt = %q, want empty for a credential that is no longer valid", got.ExpiresAt)
	}
	if want := "登录凭据已过期（" + expiredAt.Local().Format("2006-01-02 15:04") + "）：请重新登录该来源"; got.Reason != want {
		t.Fatalf("reason = %q, want %q", got.Reason, want)
	}
}

// TestBrowserStatusReportsUnknownWhenCookiesCannotBeRead: a failed read is not
// "signed out", and reporting it as such makes employees re-sign-in to a session
// that was never broken.
func TestBrowserStatusReportsUnknownWhenCookiesCannotBeRead(t *testing.T) {
	deps := browserDeps(t, filepath.Join(t.TempDir(), "profile"), stubAcquire(t, unreadableCookiesCDP(t), false))

	code, stdout, _ := runCLI(deps, "browser", "status", "--sites", writeSitesFixture(t))
	if code == 0 {
		t.Fatal("browser status exit = 0, want non-zero when the credential cannot be read")
	}
	var payload struct {
		Data struct {
			Sites []struct {
				State string `json:"state"`
			} `json:"sites"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(stdout), &payload); err != nil {
		t.Fatalf("stdout is not JSON (%v): %q", err, stdout)
	}
	if len(payload.Data.Sites) != 1 || payload.Data.Sites[0].State != string(browser.LoginUnknown) {
		t.Fatalf("data.sites = %+v, want a single site in state %q", payload.Data.Sites, browser.LoginUnknown)
	}
}

// signedInCDP 模拟一个**已登录**的 Chromium：凭据只在浏览器级读里可见，
// 两个站点的受保护页都返回正常的房源列表页。
func signedInCDP(t *testing.T, log *cdpLog) string {
	t.Helper()
	expires := float64(time.Now().Add(20 * time.Hour).Unix())
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
				reply(map[string]any{"cookies": []map[string]any{
					{"name": "lianjia_token", "domain": ".lianjia.com", "value": sentinelCookieValue, "expires": expires},
					{"name": "fang_token", "domain": ".fang.com", "value": sentinelCookieValue, "expires": expires},
				}})
			case "Network.getCookies":
				// 附着在 about:blank：按 URL 读只会得到空列表。
				reply(map[string]any{"cookies": []any{}})
			case "Page.navigate":
				reply(map[string]any{"frameId": "f1"})
			case "Runtime.evaluate":
				reply(map[string]any{"result": map[string]any{
					"type": "string",
					"value": `{"href":"https://bj.lianjia.com/ershoufang/chaoyang/","title":"北京朝阳二手房",` +
						`"text":"在售 3室2厅 89.28平米 998万 太阳公元"}`,
				}})
			default:
				reply(map[string]any{})
			}
		}
	}))
	t.Cleanup(srv.Close)
	return "ws" + strings.TrimPrefix(srv.URL, "http")
}

// TestBrowserStatusVerifyPageReportsThePageVerdict pins the flag's job: with
// `--verify-page` the protected page is read and the structural answer to "why is
// this site not usable" is reported, without turning a challenge into a login
// failure. The plugin acts on the verdict (bounded recovery, ask the employee to
// verify) rather than telling someone who just signed in to sign in again.
func TestBrowserStatusVerifyPageReportsThePageVerdict(t *testing.T) {
	log := &cdpLog{}
	wsURL := challengeCDP(t, log, float64(time.Now().Add(20*time.Hour).Unix()))
	acquire := func(ctx context.Context, _ string, _ string, _ []string, opts browser.AcquireOptions) (*browser.Browser, error) {
		if !opts.Background || !opts.KeepAlive || opts.Foreground || opts.Headless {
			t.Errorf("page verification must use the preserved, unfocused owned target: %+v", opts)
		}
		client, err := browser.Dial(ctx, wsURL)
		if err != nil {
			return nil, err
		}
		return &browser.Browser{Port: 1, Owned: false, Client: client}, nil
	}
	deps := browserDeps(t, filepath.Join(t.TempDir(), "profile"), acquire)

	// A valid credential passes the check; exit 0 is "may enter the workface", not "page readable".
	code, stdout, stderr := runCLI(deps, "browser", "status", "--sites", writeSitesFixture(t), "--verify-page")
	if code != 0 {
		t.Fatalf("browser status exit = %d for a valid credential (stderr=%q)", code, stderr)
	}
	var payload struct {
		Data struct {
			Sites []struct {
				State         string `json:"state"`
				Verdict       string `json:"verdict"`
				ProtectedURL  string `json:"protectedUrl"`
				ExpiresAt     string `json:"expiresAt"`
				SessionCookie bool   `json:"sessionCookie"`
			} `json:"sites"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(stdout), &payload); err != nil {
		t.Fatalf("stdout is not JSON (%v): %q", err, stdout)
	}
	if len(payload.Data.Sites) != 1 {
		t.Fatalf("data.sites = %+v, want one site", payload.Data.Sites)
	}
	got := payload.Data.Sites[0]
	if got.State != string(browser.LoginAuthenticated) {
		t.Fatalf("state = %q, want %q: a valid credential plus a challenge is not a login failure",
			got.State, browser.LoginAuthenticated)
	}
	if got.Verdict != string(browser.VerdictCaptcha) {
		t.Fatalf("verdict = %q, want %q (the page access fact must still be reported)", got.Verdict, browser.VerdictCaptcha)
	}
	// The employee has to clear the verification in the visible window: what is
	// reported is the **public** protected page, not a credential.
	if got.ProtectedURL != "https://bj.lianjia.com/ershoufang/chaoyang/" {
		t.Fatalf("protectedUrl = %q, want the configured protected page", got.ProtectedURL)
	}
	if got.ExpiresAt == "" {
		t.Fatal("expiresAt is empty: the panel needs the credential's expiry to explain itself")
	}
	if _, err := time.Parse(time.RFC3339, got.ExpiresAt); err != nil {
		t.Fatalf("expiresAt = %q, want RFC3339 (%v)", got.ExpiresAt, err)
	}
	// This is exactly what --verify-page buys: the protected page is really read.
	if log.count("Page.navigate") == 0 {
		t.Fatal("--verify-page never navigated to the protected page; the verdict has no source")
	}
	if strings.Contains(stdout, sentinelCookieValue) {
		t.Fatal("a cookie value reached the output")
	}
}

// challengeCDP is the real shape of "credential present, but the protected page is
// behind a human-verification wall". `expires` is the credential's CDP expiry
// (epoch seconds); the case decides whether that is still valid or already past.
func challengeCDP(t *testing.T, log *cdpLog, expires float64) string {
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
				reply(map[string]any{"cookies": []map[string]any{
					{"name": "lianjia_token", "domain": ".lianjia.com", "value": sentinelCookieValue, "expires": expires},
				}})
			case "Runtime.evaluate":
				reply(map[string]any{"result": map[string]any{
					"type": "string",
					"value": `{"href":"https://hip.lianjia.com/captcha?location=https%3A%2F%2Fbj.lianjia.com%2Fershoufang%2F",` +
						`"title":"CAPTCHA","text":"人机验证 加载中，请稍后..."}`,
				}})
			default:
				reply(map[string]any{})
			}
		}
	}))
	t.Cleanup(srv.Close)
	return "ws" + strings.TrimPrefix(srv.URL, "http")
}

// unreadableCookiesCDP answers on the connection but errors on
// `Storage.getCookies`: the shape of "the credential cannot be read", which must be
// reported as unknown rather than unauthenticated.
func unreadableCookiesCDP(t *testing.T) string {
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
			if request["method"] == "Storage.getCookies" {
				_ = conn.WriteJSON(map[string]any{"id": request["id"],
					"error": map[string]any{"code": -32000, "message": "storage unavailable"}})
				continue
			}
			_ = conn.WriteJSON(map[string]any{"id": request["id"], "result": map[string]any{}})
		}
	}))
	t.Cleanup(srv.Close)
	return "ws" + strings.TrimPrefix(srv.URL, "http")
}

func TestBrowserOpenRequiresSitesFlag(t *testing.T) {
	code, stdout, stderr := runCLI(browserDeps(t, t.TempDir(), nil), "browser", "open")
	if code == 0 {
		t.Fatalf("browser open exit = 0, want non-zero without --sites")
	}
	if !strings.Contains(stderr, "--sites") {
		t.Fatalf("stderr = %q, want it to name --sites", stderr)
	}
	if strings.TrimSpace(stdout) != "" {
		t.Fatalf("stdout = %q, want nothing on a usage error", stdout)
	}
}

func TestBrowserOpenRejectsUnknownSite(t *testing.T) {
	code, _, stderr := runCLI(browserDeps(t, filepath.Join(t.TempDir(), "profile"), nil),
		"browser", "open", "--sites", writeSitesFixture(t), "--site", "nope")
	if code == 0 {
		t.Fatal("browser open exit = 0, want non-zero for an unknown --site id")
	}
	if !strings.Contains(stderr, "nope") {
		t.Fatalf("stderr = %q, want it to name the unknown site id", stderr)
	}
}

const openProtectedURL = "https://bj.lianjia.com/ershoufang/chaoyang/"

// TestBrowserOpenOpensTheProtectedPageAndKeepsTheWindow pins why the command
// exists: the employee is signed in but the protected page demands human
// verification, so the panel can only re-open that page in the same profile. It
// must return immediately with the window left on screen.
func TestBrowserOpenOpensTheProtectedPageAndKeepsTheWindow(t *testing.T) {
	log := &cdpLog{}
	wsURL := loggedCDP(t, log, true)
	var session *browser.Browser
	acquire := func(ctx context.Context, _ string, _ string, _ []string, _ browser.AcquireOptions) (*browser.Browser, error) {
		client, err := browser.Dial(ctx, wsURL)
		if err != nil {
			return nil, err
		}
		session = &browser.Browser{Port: 1, Owned: false, Client: client}
		return session, nil
	}
	deps := browserDeps(t, filepath.Join(t.TempDir(), "profile"), acquire)

	code, stdout, stderr := runCLI(deps, "browser", "open", "--sites", writeSitesFixture(t), "--site", "lianjia")
	if code != 0 {
		t.Fatalf("browser open exit = %d, want 0 (stderr=%q)", code, stderr)
	}
	var payload struct {
		OK   bool `json:"ok"`
		Data struct {
			SiteID        string   `json:"siteId"`
			Opened        bool     `json:"opened"`
			ProtectedURLs []string `json:"protectedUrls"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(stdout), &payload); err != nil {
		t.Fatalf("stdout is not JSON (%v): %q", err, stdout)
	}
	if !payload.OK || !payload.Data.Opened {
		t.Fatalf("ok/opened = %v/%v, want both true: %q", payload.OK, payload.Data.Opened, stdout)
	}
	if payload.Data.SiteID != "lianjia" {
		t.Fatalf("data.siteId = %q, want the single --site id", payload.Data.SiteID)
	}
	if len(payload.Data.ProtectedURLs) != 1 || payload.Data.ProtectedURLs[0] != openProtectedURL {
		t.Fatalf("data.protectedUrls = %v, want [%s]", payload.Data.ProtectedURLs, openProtectedURL)
	}

	// An attached (non-owned) session has no tab opened by the startup branch, so
	// the protected page must be opened explicitly.
	opened := false
	for _, params := range log.argsFor("Target.createTarget") {
		if url, _ := params["url"].(string); url == openProtectedURL {
			opened = true
		}
	}
	if !opened {
		t.Fatalf("Target.createTarget calls = %+v, want one for %s", log.argsFor("Target.createTarget"), openProtectedURL)
	}

	// The fake has no release counter, but Release() closes the client and nils it,
	// so a live client that still answers is direct evidence that the session was
	// left open for the employee.
	if session == nil || session.Client == nil {
		t.Fatal("open released the session; the verification window must stay open for the employee")
	}
	if _, err := session.Client.Call(context.Background(), "Storage.getCookies", nil); err != nil {
		t.Fatalf("the session was closed after open (%v); the window must stay open", err)
	}
}

// Every selected site is opened, and siteId stays empty because the panel only
// ever passes one --site.
func TestBrowserOpenOpensEverySelectedSite(t *testing.T) {
	log := &cdpLog{}
	wsURL := loggedCDP(t, log, true)
	deps := browserDeps(t, filepath.Join(t.TempDir(), "profile"), stubAcquire(t, wsURL, false))

	path := filepath.Join(t.TempDir(), "sites.json")
	if err := os.WriteFile(path, []byte(twoSiteSitesFixture), 0o600); err != nil {
		t.Fatalf("write sites fixture: %v", err)
	}

	code, stdout, stderr := runCLI(deps, "browser", "open", "--sites", path, "--site", "lianjia", "--site", "fang")
	if code != 0 {
		t.Fatalf("browser open exit = %d, want 0 (stderr=%q)", code, stderr)
	}
	var payload struct {
		Data struct {
			SiteID        string   `json:"siteId"`
			ProtectedURLs []string `json:"protectedUrls"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(stdout), &payload); err != nil {
		t.Fatalf("stdout is not JSON (%v): %q", err, stdout)
	}
	if payload.Data.SiteID != "" {
		t.Fatalf("data.siteId = %q, want empty for more than one --site", payload.Data.SiteID)
	}
	want := map[string]bool{"https://bj.lianjia.com/ershoufang/": false, "https://bj.fang.com/ershoufang/": false}
	if len(payload.Data.ProtectedURLs) != len(want) {
		t.Fatalf("data.protectedUrls = %v, want both selected sites", payload.Data.ProtectedURLs)
	}
	for _, url := range payload.Data.ProtectedURLs {
		if _, ok := want[url]; !ok {
			t.Fatalf("data.protectedUrls = %v, want exactly %v", payload.Data.ProtectedURLs, want)
		}
		want[url] = true
	}
	for url, seen := range want {
		if !seen {
			t.Fatalf("data.protectedUrls = %v, missing %s", payload.Data.ProtectedURLs, url)
		}
	}
}

// TestBrowserFetchAcceptsBackgroundFlag pins the background request contract for
// ordinary fetch/shot: the CLI accepts --background=true|false with a default of
// true, so an ordinary action leaves the owned window in the background while an
// explicit --background=false shows that same owned window. Login/open stay
// explicit visible actions and must not grow a default-true background flag.
func TestBrowserFetchAcceptsBackgroundFlag(t *testing.T) {
	deps := browserDeps(t, t.TempDir(), nil)
	root := newBrowserCommand(deps, map[string][]schemeExample{})

	for _, name := range []string{"fetch", "shot"} {
		cmd, _, err := root.Find([]string{name})
		if err != nil || cmd == nil || cmd.Name() != name {
			t.Fatalf("browser %s subcommand not found: %v", name, err)
		}
		flag := cmd.Flags().Lookup("background")
		if flag == nil {
			flag = cmd.InheritedFlags().Lookup("background")
		}
		if flag == nil {
			t.Fatalf("browser %s must accept --background; flag lookup returned nil", name)
		}
		if flag.DefValue != "true" {
			t.Fatalf("browser %s --background default = %q, want \"true\"", name, flag.DefValue)
		}
	}

	for _, name := range []string{"login", "open"} {
		cmd, _, err := root.Find([]string{name})
		if err != nil || cmd == nil || cmd.Name() != name {
			t.Fatalf("browser %s subcommand not found: %v", name, err)
		}
		flag := cmd.Flags().Lookup("background")
		if flag == nil {
			flag = cmd.InheritedFlags().Lookup("background")
		}
		if flag != nil && flag.DefValue == "true" {
			t.Fatalf("browser %s must not default to a background launch (human verification stays visible)", name)
		}
	}
}

// TestBrowserFetchPassesBackgroundOptions pins the wire from the flag to the
// acquisition options: the default leaves the owned window in the background, and
// the explicit fallback shows that same owned window for this action.
func TestBrowserFetchPassesBackgroundOptions(t *testing.T) {
	cases := []struct {
		name           string
		extraArgs      []string
		wantBackground bool
		wantKeepAlive  bool
	}{
		{"default reuses the background window", nil, true, true},
		{"explicit false shows only the owned window", []string{"--background=false"}, false, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			wsURL := fakeCDPForCLI(t)
			var got browser.AcquireOptions
			acquire := func(ctx context.Context, _ string, _ string, _ []string, opts browser.AcquireOptions) (*browser.Browser, error) {
				got = opts
				client, err := browser.Dial(ctx, wsURL)
				if err != nil {
					return nil, err
				}
				return &browser.Browser{Port: 1, Owned: false, Client: client}, nil
			}
			deps := browserDeps(t, filepath.Join(t.TempDir(), "profile"), acquire)

			args := []string{"browser", "fetch", "--url", "https://bj.lianjia.com/ershoufang/1.html",
				"--out", filepath.Join(t.TempDir(), "page.html"), "--wait-ms", "0"}
			args = append(args, tc.extraArgs...)
			_, _, _ = runCLI(deps, args...)

			if got.Background != tc.wantBackground || got.KeepAlive != tc.wantKeepAlive || got.Foreground != !tc.wantBackground {
				t.Fatalf("AcquireOptions = {Background:%v KeepAlive:%v}, want {%v %v}",
					got.Background, got.KeepAlive, tc.wantBackground, tc.wantKeepAlive)
			}
		})
	}
}

// TestBrowserFetchFocusesOnlyOnManualVerification pins the one page shape that may
// bring a window forward: a human challenge on the owned target. A normal page must
// not steal focus.
func TestBrowserFetchFocusesOnlyOnManualVerification(t *testing.T) {
	cases := []struct {
		name      string
		wsURL     func(t *testing.T) string
		wantFocus bool
	}{
		{"normal page does not focus", func(t *testing.T) string { return signedInCDP(t, &cdpLog{}) }, false},
		{"captcha page focuses the owned target", func(t *testing.T) string {
			return challengeCDP(t, &cdpLog{}, float64(time.Now().Add(time.Hour).Unix()))
		}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			deps := browserDeps(t, filepath.Join(t.TempDir(), "profile"), stubAcquire(t, tc.wsURL(t), false))
			focusCalls := 0
			browserFocusOverride = func(context.Context, *browser.Browser) error {
				focusCalls++
				return nil
			}
			_, _, _ = runCLI(deps, "browser", "fetch",
				"--url", "https://bj.lianjia.com/ershoufang/1.html",
				"--out", filepath.Join(t.TempDir(), "page.html"), "--wait-ms", "0")
			if (focusCalls > 0) != tc.wantFocus {
				t.Fatalf("focus calls = %d, want focus = %v", focusCalls, tc.wantFocus)
			}
		})
	}
}

// TestBrowserLoginAndOpenUseTheOwnedForegroundWindow pins that both explicit human
// actions ask for the owned target to be brought forward, rather than attaching an
// arbitrary foreign tab.
func TestBrowserLoginAndOpenUseTheOwnedForegroundWindow(t *testing.T) {
	cases := []struct {
		name string
		args func(sites string) []string
	}{
		{"login", func(sites string) []string {
			return []string{"browser", "login", "--sites", sites, "--site", "lianjia", "--timeout", "1ms"}
		}},
		{"open", func(sites string) []string {
			return []string{"browser", "open", "--sites", sites, "--site", "lianjia"}
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			wsURL := loggedCDP(t, &cdpLog{}, true)
			var got browser.AcquireOptions
			acquire := func(ctx context.Context, _ string, _ string, _ []string, opts browser.AcquireOptions) (*browser.Browser, error) {
				got = opts
				client, err := browser.Dial(ctx, wsURL)
				if err != nil {
					return nil, err
				}
				return &browser.Browser{Port: 1, Owned: false, Client: client}, nil
			}
			deps := browserDeps(t, filepath.Join(t.TempDir(), "profile"), acquire)
			_, _, _ = runCLI(deps, tc.args(writeSitesFixture(t))...)
			if !got.Foreground {
				t.Fatalf("AcquireOptions = %+v, want Foreground=true so the owned window is shown", got)
			}
		})
	}
}

// TestBrowserRecoverUsesTheOwnedBackgroundTarget pins that recovery runs against
// the owned target the challenge was found on, and keeps it for the next call.
func TestBrowserRecoverUsesTheOwnedBackgroundTarget(t *testing.T) {
	probe := `{"present":false,"family":"","href":"https://bj.lianjia.com/ershoufang/1.html","title":"二手房",` +
		`"canvases":[],"bodyHas":{"slider":false,"successText":false,"failText":false}}`
	wsURL := recoverCDP(t, &cdpLog{}, probe)
	var got browser.AcquireOptions
	acquire := func(ctx context.Context, _ string, _ string, _ []string, opts browser.AcquireOptions) (*browser.Browser, error) {
		got = opts
		client, err := browser.Dial(ctx, wsURL)
		if err != nil {
			return nil, err
		}
		return &browser.Browser{Port: 1, Owned: false, Client: client}, nil
	}
	deps := browserDeps(t, filepath.Join(t.TempDir(), "profile"), acquire)
	_, _, _ = runCLI(deps, "browser", "recover",
		"--sites", writeSitesFixture(t), "--site", "lianjia",
		"--url", "https://bj.lianjia.com/ershoufang/1.html")
	if !got.Background || !got.KeepAlive {
		t.Fatalf("AcquireOptions = %+v, want the owned background target preserved", got)
	}
}

// TestBrowserSchemeDocumentsTheBackgroundContract pins the machine-readable
// catalog: the fetch/shot description names the background window and the examples
// show the explicit --background=false fallback.
func TestBrowserSchemeDocumentsTheBackgroundContract(t *testing.T) {
	code, stdout, stderr := runCLI(envDependencies(func(string) string { return "" }), "scheme", "browser")
	if code != 0 {
		t.Fatalf("scheme browser exit = %d, stderr=%q", code, stderr)
	}
	var doc struct {
		Commands []struct {
			Name        string `json:"name"`
			Description string `json:"description"`
			Examples    []struct {
				Description string `json:"description"`
				Command     string `json:"command"`
			} `json:"examples"`
		} `json:"commands"`
	}
	if err := json.Unmarshal([]byte(stdout), &doc); err != nil {
		t.Fatalf("scheme browser is not JSON (%v): %q", err, stdout)
	}
	for _, name := range []string{"browser fetch", "browser shot"} {
		found := false
		for _, command := range doc.Commands {
			if command.Name != name {
				continue
			}
			found = true
			if !strings.Contains(strings.ToLower(command.Description), "background") {
				t.Fatalf("%s description = %q, want it to name the background window", name, command.Description)
			}
			hasFallback := false
			for _, example := range command.Examples {
				if strings.Contains(example.Command, "--background=false") {
					hasFallback = true
				}
			}
			if !hasFallback {
				t.Fatalf("%s examples = %+v, want the explicit --background=false fallback", name, command.Examples)
			}
		}
		if !found {
			t.Fatalf("scheme browser is missing %s", name)
		}
	}
}
