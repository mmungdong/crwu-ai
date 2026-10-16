package browser

import (
	"bytes"
	"context"
	"image"
	"image/color"
	"image/png"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestAuthCookiePresentRequiresNameDomainAndValue(t *testing.T) {
	site := Site{ID: "lianjia", AuthCookie: "lianjia_token", AuthDomains: []string{".lianjia.com"}}
	cases := []struct {
		name    string
		cookies []Cookie
		want    bool
	}{
		{"all three match", []Cookie{{Name: "lianjia_token", Domain: ".lianjia.com", Value: "v"}}, true},
		{"name matches but domain does not", []Cookie{{Name: "lianjia_token", Domain: ".example.com", Value: "v"}}, false},
		{"domain matches but value is empty", []Cookie{{Name: "lianjia_token", Domain: ".lianjia.com", Value: ""}}, false},
		{"only a lookalike name", []Cookie{{Name: "lianjia_token_secure", Domain: ".lianjia.com", Value: "v"}}, false},
		{"no cookies at all", nil, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := AuthCookiePresent(tc.cookies, site); got != tc.want {
				t.Fatalf("AuthCookiePresent(%+v) = %v, want %v", tc.cookies, got, tc.want)
			}
		})
	}
}

func TestAuthCookiePresentWithoutDomainRestrictionAcceptsAnyDomain(t *testing.T) {
	site := Site{ID: "x", AuthCookie: "sess"}
	if !AuthCookiePresent([]Cookie{{Name: "sess", Domain: "whatever.example", Value: "v"}}, site) {
		t.Fatal("AuthCookiePresent() = false without AuthDomains, want any domain to count")
	}
}

func blankPNG(t *testing.T, width, height int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	for x := 0; x < width; x++ {
		for y := 0; y < height; y++ {
			img.Set(x, y, color.RGBA{R: 255, G: 255, B: 255, A: 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("encode blank png: %v", err)
	}
	return buf.Bytes()
}

func contentPNG(t *testing.T, width, height int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	// 上半部填充深色：非白占比 50%，远超阈值。
	for x := 0; x < width; x++ {
		for y := 0; y < height/2; y++ {
			img.Set(x, y, color.RGBA{R: 20, G: 20, B: 20, A: 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("encode content png: %v", err)
	}
	return buf.Bytes()
}

func TestVerifyScreenshotRejectsBlankImage(t *testing.T) {
	err := VerifyScreenshot(blankPNG(t, 1440, 1200))
	if err == nil {
		t.Fatal("VerifyScreenshot() = nil error for an all-white image")
	}
	if !strings.Contains(err.Error(), "空白") {
		t.Fatalf("VerifyScreenshot() error = %q, want it to say the image is blank", err.Error())
	}
}

func TestVerifyScreenshotRejectsTinyImage(t *testing.T) {
	err := VerifyScreenshot(contentPNG(t, 10, 10))
	if err == nil {
		t.Fatal("VerifyScreenshot() = nil error for a 10x10 image")
	}
	if !strings.Contains(err.Error(), "尺寸") {
		t.Fatalf("VerifyScreenshot() error = %q, want it to mention the size", err.Error())
	}
}

func TestVerifyScreenshotAcceptsAPageLikeImage(t *testing.T) {
	if err := VerifyScreenshot(contentPNG(t, 1440, 1200)); err != nil {
		t.Fatalf("VerifyScreenshot() error = %v, want nil for an image with content", err)
	}
}

func TestVerifyScreenshotRejectsNonPNG(t *testing.T) {
	err := VerifyScreenshot([]byte("this is not a png"))
	if err == nil {
		t.Fatal("VerifyScreenshot() = nil error for undecodable bytes")
	}
}

// TestAuthCookiePresentAcceptsDomainSpellingVariants pins the domain comparison.
//
// Chromium stores the same session cookie as `.lianjia.com` (domain cookie) or as
// `lianjia.com` / `bj.lianjia.com` (host-only), depending on how the site set it. Requiring
// byte equality with the configured `.lianjia.com` turns a signed-in employee into
// "没有登录凭据" — which is exactly the false negative reported on 2026-10-14.
// Suffix matching must stay on label boundaries, or `evil-lianjia.com` would count.
func TestAuthCookiePresentAcceptsDomainSpellingVariants(t *testing.T) {
	site := Site{ID: "lianjia", AuthCookie: "lianjia_token", AuthDomains: []string{".lianjia.com"}}
	cases := []struct {
		name   string
		domain string
		want   bool
	}{
		{"leading dot as configured", ".lianjia.com", true},
		{"no leading dot", "lianjia.com", true},
		{"uppercase", "LIANJIA.COM", true},
		{"subdomain cookie", "bj.lianjia.com", true},
		{"lookalike suffix must not match", "evil-lianjia.com", false},
		{"other site", ".example.com", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := AuthCookiePresent([]Cookie{{Name: "lianjia_token", Domain: tc.domain, Value: "v"}}, site)
			if got != tc.want {
				t.Fatalf("AuthCookiePresent(domain=%q) = %v, want %v", tc.domain, got, tc.want)
			}
		})
	}

	// The configured side must be normalized the same way.
	plain := Site{ID: "lianjia", AuthCookie: "lianjia_token", AuthDomains: []string{"lianjia.com"}}
	if !AuthCookiePresent([]Cookie{{Name: "lianjia_token", Domain: ".lianjia.com", Value: "v"}}, plain) {
		t.Fatal("config without a leading dot must still match a cookie that has one")
	}
}

// TestVerifySiteReportsChallengeAsItsOwnReason keeps the employee-facing reason
// honest: a page answered with a human-verification wall is not "not signed in",
// and telling someone to log in again sends them to fight the wrong problem.
func TestVerifySiteReportsChallengeAsItsOwnReason(t *testing.T) {
	ws := fakeCDP(t, func(conn *websocket.Conn, request map[string]any) {
		reply := func(result map[string]any) {
			_ = conn.WriteJSON(map[string]any{"id": request["id"], "result": result})
		}
		switch request["method"] {
		case "Storage.getCookies":
			reply(map[string]any{"cookies": []map[string]any{
				{"name": "lianjia_token", "domain": ".lianjia.com", "value": "v"},
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
	})

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	client, err := Dial(ctx, ws)
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer func() { _ = client.Close() }()

	state, reason := VerifySite(ctx, client, Site{
		ID: "lianjia", Label: "链家", ProtectedURL: "https://bj.lianjia.com/ershoufang/",
		AuthCookie: "lianjia_token", AuthDomains: []string{".lianjia.com"},
	})
	// 2026-10-14 口径（用户拍板）：凭据有效 + 页面要人机验证 = **已登录**；
	// 验证是页面访问问题，交给取数流程处理。这里仍然钉住"原因不说成未登录"。
	if state != LoginAuthenticated {
		t.Fatalf("state = %v, want authenticated (a valid credential plus a challenge is not a login failure)", state)
	}
	if !strings.Contains(reason, "人机验证") {
		t.Fatalf("reason = %q, want it to name 人机验证", reason)
	}
	if strings.Contains(reason, "先登录") || strings.Contains(reason, "重新登录") {
		t.Fatalf("reason = %q, must not send the employee to log in again", reason)
	}
}

// ── 凭据有效期：登录是"凭据有效"，人机验证是"页面访问" ──────────────────────
//
// 2026-10-14 的产品判断（用户口径）：受保护页要求人机验证时，员工**其实已经登录**，
// 凭据有效期可以作证（实测 `.lianjia.com` 的 lianjia_token 到期时间是登录后 24 小时）。
// 所以：
//   · 凭据有效 + 页面被人机验证/风控挡住 → `authenticated`（不是"无法检查"，更不是"未登录"）；
//     验证留给取数流程处理（那里有自动恢复 + waiting-user 断点）。
//   · 凭据**过期**或压根没有 → `unauthenticated`，这时才该让员工重新登录。
//   · 凭据在但页面是**登录墙** → `unauthenticated`：那是会话被服务端作废的形态。

func TestAuthCookieEvidenceReportsExpiry(t *testing.T) {
	site := Site{ID: "lianjia", AuthCookie: "lianjia_token", AuthDomains: []string{".lianjia.com"}}
	expires := time.Now().Add(24 * time.Hour).Unix()

	evidence := AuthCookieEvidence([]Cookie{
		{Name: "lianjia_token", Domain: ".lianjia.com", Value: "v", Expires: float64(expires)},
	}, site)
	if !evidence.Present || evidence.SessionCookie {
		t.Fatalf("evidence = %+v, want present and not a session cookie", evidence)
	}
	if evidence.ExpiresAt.Unix() != expires {
		t.Fatalf("expiresAt = %v, want %v", evidence.ExpiresAt, time.Unix(expires, 0))
	}

	// CDP 用 -1 表示"会话 cookie"：有效，但关掉浏览器就失效。
	session := AuthCookieEvidence([]Cookie{
		{Name: "lianjia_token", Domain: ".lianjia.com", Value: "v", Expires: -1},
	}, site)
	if !session.Present || !session.SessionCookie {
		t.Fatalf("evidence = %+v, want present session cookie", session)
	}

	// 过期就是过期：不能因为"名字对得上"放行。
	expired := AuthCookieEvidence([]Cookie{
		{Name: "lianjia_token", Domain: ".lianjia.com", Value: "v", Expires: float64(time.Now().Add(-time.Minute).Unix())},
	}, site)
	if expired.Present {
		t.Fatalf("evidence = %+v, want an expired cookie to be invalid", expired)
	}
	if !strings.Contains(expired.Reason, "过期") {
		t.Fatalf("reason = %q, want it to say the credential expired", expired.Reason)
	}
	if expired.ExpiredAt.IsZero() {
		t.Fatal("expiredAt is zero; a caller cannot say when the credential lapsed")
	}

	// 同一个名字在多域上出现时取**最晚**到期的那条（.lianjia.com 与 bj.lianjia.com 都可能存在）。
	best := AuthCookieEvidence([]Cookie{
		{Name: "lianjia_token", Domain: ".lianjia.com", Value: "v", Expires: float64(time.Now().Add(time.Hour).Unix())},
		{Name: "lianjia_token", Domain: "bj.lianjia.com", Value: "v", Expires: float64(expires)},
	}, site)
	if best.ExpiresAt.Unix() != expires {
		t.Fatalf("expiresAt = %v, want the latest expiry %v", best.ExpiresAt, time.Unix(expires, 0))
	}
}

// TestVerifySiteTreatsAChallengeAsPageAccessNotALoginProblem is the core of the
// 2026-10-14 judgement call: with a valid credential, a challenged protected page
// still means "signed in" — the challenge is the retrieval flow's business.
func TestVerifySiteTreatsAChallengeAsPageAccessNotALoginProblem(t *testing.T) {
	challengePage := "https://hip.lianjia.com/captcha?location=https%3A%2F%2Fbj.lianjia.com%2Fershoufang%2F"
	expires := time.Now().Add(20 * time.Hour)
	ws := fakeCDP(t, func(conn *websocket.Conn, request map[string]any) {
		reply := func(result map[string]any) {
			_ = conn.WriteJSON(map[string]any{"id": request["id"], "result": result})
		}
		switch request["method"] {
		case "Storage.getCookies":
			reply(map[string]any{"cookies": []map[string]any{
				{"name": "lianjia_token", "domain": ".lianjia.com", "value": "v", "expires": float64(expires.Unix())},
			}})
		case "Runtime.evaluate":
			reply(map[string]any{"result": map[string]any{
				"type":  "string",
				"value": `{"href":"` + challengePage + `","title":"CAPTCHA","text":"人机验证 加载中，请稍后..."}`,
			}})
		default:
			reply(map[string]any{})
		}
	})

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	client, err := Dial(ctx, ws)
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer func() { _ = client.Close() }()

	site := Site{
		ID: "lianjia", Label: "链家", ProtectedURL: "https://bj.lianjia.com/ershoufang/",
		AuthCookie: "lianjia_token", AuthDomains: []string{".lianjia.com"},
	}
	verdict := VerifySiteDetailed(ctx, client, site)
	if verdict.State != LoginAuthenticated {
		t.Fatalf("state = %s（%s）, want authenticated: a valid credential plus a challenge is not a login failure",
			verdict.State, verdict.Reason)
	}
	if verdict.Verdict != VerdictCaptcha {
		t.Fatalf("verdict = %s, want captcha (the page access fact is still recorded)", verdict.Verdict)
	}
	if verdict.ExpiresAt.Unix() != expires.Unix() {
		t.Fatalf("expiresAt = %v, want %v", verdict.ExpiresAt, expires)
	}
	if !strings.Contains(verdict.Reason, "人机验证") {
		t.Fatalf("reason = %q, want it to name the challenge", verdict.Reason)
	}
	if strings.Contains(verdict.Reason, "先登录") {
		t.Fatalf("reason = %q, must not send the employee to log in again", verdict.Reason)
	}
}

// TestVerifySiteRefusesAnExpiredCredentialEvenWhenThePageIsChallenged keeps the
// other half of the judgement: expiry is a login fact, and it must not be papered
// over by "the page was only asking for verification".
func TestVerifySiteRefusesAnExpiredCredentialEvenWhenThePageIsChallenged(t *testing.T) {
	ws := fakeCDP(t, func(conn *websocket.Conn, request map[string]any) {
		reply := func(result map[string]any) {
			_ = conn.WriteJSON(map[string]any{"id": request["id"], "result": result})
		}
		switch request["method"] {
		case "Storage.getCookies":
			reply(map[string]any{"cookies": []map[string]any{
				{"name": "lianjia_token", "domain": ".lianjia.com", "value": "v",
					"expires": float64(time.Now().Add(-2 * time.Hour).Unix())},
			}})
		case "Runtime.evaluate":
			reply(map[string]any{"result": map[string]any{
				"type": "string", "value": `{"href":"https://hip.lianjia.com/captcha?x=1","title":"CAPTCHA","text":"人机验证"}`,
			}})
		default:
			reply(map[string]any{})
		}
	})

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	client, err := Dial(ctx, ws)
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer func() { _ = client.Close() }()

	verdict := VerifySiteDetailed(ctx, client, Site{
		ID: "lianjia", ProtectedURL: "https://bj.lianjia.com/ershoufang/",
		AuthCookie: "lianjia_token", AuthDomains: []string{".lianjia.com"},
	})
	if verdict.State != LoginUnauthenticated {
		t.Fatalf("state = %s, want unauthenticated for an expired credential", verdict.State)
	}
	if !strings.Contains(verdict.Reason, "过期") {
		t.Fatalf("reason = %q, want it to name the expiry", verdict.Reason)
	}
}
