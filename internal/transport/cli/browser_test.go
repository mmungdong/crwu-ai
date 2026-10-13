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

	"github.com/gorilla/websocket"

	"github.com/mmungdong/crwu-ai/internal/platform/browser"
)

// errNoBrowserInTest 用于「拿不到浏览器」这条路径。
var errNoBrowserInTest = errors.New("no browser available in test")

// sentinelCookieValue 是一个绝不允许出现在任何输出里的值。
const sentinelCookieValue = "SENTINEL-COOKIE-VALUE-DO-NOT-LEAK"

const sitesFixture = `[{
	"id": "ke",
	"label": "贝壳",
	"loginUrl": "https://clogin.ke.com/login",
	"protectedUrl": "https://bj.ke.com/ershoufang/chaoyang/",
	"authCookie": "lianjia_token",
	"authDomains": [".ke.com"]
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
	t.Cleanup(func() { browserAcquireOverride = nil })
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
			case "Network.getCookies":
				reply(map[string]any{"cookies": []map[string]any{
					{"name": "lianjia_token", "domain": ".ke.com", "value": sentinelCookieValue},
				}})
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
	acquire := func(ctx context.Context, _ string, _ string, _ []string) (*browser.Browser, error) {
		client, err := browser.Dial(ctx, wsURL)
		if err != nil {
			return nil, err
		}
		return &browser.Browser{Port: 1, Owned: false, Client: client}, nil
	}
	deps := browserDeps(t, filepath.Join(t.TempDir(), "profile"), acquire)

	code, stdout, stderr := runCLI(deps, "browser", "status", "--sites", writeSitesFixture(t))
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
	if len(payload.Data.Sites) != 1 || payload.Data.Sites[0].ID != "ke" {
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
	acquire := func(context.Context, string, string, []string) (*browser.Browser, error) {
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
