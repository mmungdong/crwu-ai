package browser

import (
	"bytes"
	"context"
	"fmt"
	"image/png"
	"strings"
	"time"
)

// LoginState answers "can we fetch from this site right now".
//
// `LoginUnknown` is not a synonym for "signed out": it means we could not tell
// (network down, egress outside the country, a captcha in the way). Reporting that
// as "signed out" makes employees re-sign-in to an account that was never broken.
type LoginState string

const (
	LoginAuthenticated   LoginState = "authenticated"
	LoginUnauthenticated LoginState = "unauthenticated"
	LoginUnknown         LoginState = "unknown"
)

// AuthCookiePresent reports whether a usable session cookie is visible.
//
// All three of name, domain, and a non-empty value must hold. A cookie that is
// present but empty is what a cleared or half-written session looks like, and
// counting it as "signed in" is how a run starts against a dead session.
//
// The domain comparison is normalized (leading dot optional, case-insensitive)
// and matches on label boundaries. Chromium stores the same session cookie as
// `.lianjia.com` or as `lianjia.com` / `bj.lianjia.com` depending on how the site set it, so byte
// equality with the configured `.lianjia.com` reports a signed-in employee as
// "没有登录凭据" (observed 2026-10-14). The boundary dot keeps `evil-lianjia.com` out.
func AuthCookiePresent(cookies []Cookie, site Site) bool {
	return AuthCookieEvidence(cookies, site).Present
}

// CookieEvidence is what the credential check found.
//
// `Present` is the login fact: a cookie with a non-empty value that is **not
// expired**. `ExpiresAt` is zero for session cookies (`SessionCookie` true).
type CookieEvidence struct {
	Present       bool
	ExpiresAt     time.Time
	SessionCookie bool
	// ExpiredAt is the latest expiry seen on a matching cookie that is already
	// expired. It is set only when Present is false, and it lets a caller report
	// *when* the credential lapsed instead of a bare "expired".
	ExpiredAt time.Time
	/** 人话原因；仅在不通过时有值。 */
	Reason string
}

// AuthCookieEvidence reports the site's credential and when it expires.
//
// Expiry has to be part of this check, not a separate one: "cookie exists" alone
// lets an expired session look signed in, and "page was readable" alone turns an
// anti-bot challenge into a login failure. Both mistakes were observed in the field
// (2026-10-14) — the first as a run starting against a dead session, the second as
// "I already signed in and the check still fails".
//
// When the same cookie name exists on several domains (`.lianjia.com` and `bj.lianjia.com`
// both appear in practice) the **latest** expiry wins; a session cookie only counts
// when no expiring one matches.
func AuthCookieEvidence(cookies []Cookie, site Site) CookieEvidence {
	now := time.Now()
	var best CookieEvidence
	var expiredAt time.Time
	for _, cookie := range cookies {
		if cookie.Name != site.AuthCookie || cookie.Value == "" {
			continue
		}
		if len(site.AuthDomains) > 0 && !domainMatchesAny(cookie.Domain, site.AuthDomains) {
			continue
		}
		switch {
		// -1 = session cookie; 0 = the caller did not carry an expiry (hand-built
		// inputs, and any CDP variant that omits it). Neither means "expired in
		// 1970": only a **positive** expiry in the past does.
		case cookie.Expires <= 0:
			if !best.Present {
				best = CookieEvidence{Present: true, SessionCookie: true}
			}
		default:
			at := time.Unix(int64(cookie.Expires), 0)
			if !at.After(now) {
				if at.After(expiredAt) {
					expiredAt = at
				}
				continue
			}
			if !best.Present || best.SessionCookie || at.After(best.ExpiresAt) {
				best = CookieEvidence{Present: true, ExpiresAt: at}
			}
		}
	}
	if best.Present {
		return best
	}
	if !expiredAt.IsZero() {
		return CookieEvidence{
			ExpiredAt: expiredAt,
			Reason:    fmt.Sprintf("%s 的登录凭据已过期：请重新登录该来源", site.ID),
		}
	}
	return CookieEvidence{Reason: fmt.Sprintf("%s 没有登录凭据：请先登录该来源", site.ID)}
}

// domainMatchesAny reports whether a cookie domain matches any configured domain.
func domainMatchesAny(cookieDomain string, configured []string) bool {
	for _, domain := range configured {
		if sameCookieDomain(cookieDomain, domain) {
			return true
		}
	}
	return false
}

// sameCookieDomain compares a cookie's domain against a configured one.
func sameCookieDomain(cookieDomain, configured string) bool {
	left := normalizeCookieDomain(cookieDomain)
	right := normalizeCookieDomain(configured)
	if left == "" || right == "" {
		return false
	}
	// Either side may be the more specific one: the cookie can be set on a
	// subdomain while the config names the site, or the other way round.
	return left == right || strings.HasSuffix(left, "."+right) || strings.HasSuffix(right, "."+left)
}

// normalizeCookieDomain lower-cases and drops surrounding dots.
func normalizeCookieDomain(value string) string {
	return strings.Trim(strings.ToLower(strings.TrimSpace(value)), ".")
}

// VerifySite decides the site's session state.
//
// It is the thin wrapper over VerifySiteVerdict for callers that only need the
// state; the verdict is what the caller needs when it has to act on *why* the site
// is not usable (a challenge is not a login problem).
func VerifySite(ctx context.Context, client *Client, site Site) (LoginState, string) {
	state, reason, _ := VerifySiteVerdict(ctx, client, site)
	return state, reason
}

// VerifySiteVerdict decides the site's session state and reports the page verdict.
//
// Two stages on purpose. The cookie check is cheap and rejects the clearly signed
// out case without touching the network. The navigation is the authority: a cookie
// can be present and expired, and only loading a page that requires a session shows
// which it is.
//
// The returned reason is written for an employee and never contains a cookie value.
// The verdict is empty when no page was read (no cookie, or navigation failed).
func VerifySiteVerdict(ctx context.Context, client *Client, site Site) (LoginState, string, Verdict) {
	result := VerifySiteDetailed(ctx, client, site)
	return result.State, result.Reason, result.Verdict
}

// SiteVerdict is everything the check learned about one site.
//
// The three facts are deliberately separate because they answer different questions:
//
//   - `State`   — is the employee signed in? (credential present, unexpired, not revoked)
//   - `Verdict` — what did the protected page turn out to be? (ok / login-wall / captcha / blocked)
//   - `ExpiresAt` / `SessionCookie` — until when is the credential good?
//
// Collapsing them is what produced the two field failures of 2026-10-14: an expired
// cookie read as signed-in, and an anti-bot challenge read as "not signed in".
type SiteVerdict struct {
	State         LoginState
	Reason        string
	Verdict       Verdict
	ExpiresAt     time.Time
	SessionCookie bool
}

// VerifySiteDetailed decides the site's session state.
//
// The model, after the 2026-10-14 field reports:
//
//  1. No credential, or an expired one → `unauthenticated`: that is a login problem
//     and the employee has to sign in (again).
//  2. Credential valid, page shows a **login wall** → `unauthenticated`: the site is
//     treating this session as signed out, which is what a revoked session looks like.
//  3. Credential valid, page asks for **human verification** (or risk-control blocks
//     it) → `authenticated`. The employee *is* signed in; the challenge is a page
//     access problem, and the retrieval flow already handles it (bounded automatic
//     recovery, then a waiting-user checkpoint). Reporting `unknown` here blocked the
//     whole workface for people who had just signed in successfully.
//  4. Credential valid, page readable → `authenticated`.
//  5. Credential valid but the page could not be read at all → `unknown`.
//
// The reason is written for an employee and never contains a cookie value.
func VerifySiteDetailed(ctx context.Context, client *Client, site Site) SiteVerdict {
	cookies, err := client.Cookies(ctx)
	if err != nil {
		return SiteVerdict{
			State:  LoginUnknown,
			Reason: fmt.Sprintf("无法读取 %s 的登录凭据：%v", site.ID, err),
		}
	}
	evidence := AuthCookieEvidence(cookies, site)
	if !evidence.Present {
		return SiteVerdict{State: LoginUnauthenticated, Reason: evidence.Reason}
	}

	validity := credentialValidityText(evidence)
	if err := client.Navigate(ctx, site.ProtectedURL); err != nil {
		return SiteVerdict{
			State: LoginUnknown, ExpiresAt: evidence.ExpiresAt, SessionCookie: evidence.SessionCookie,
			Reason: fmt.Sprintf("%s 的登录凭据有效（%s），但无法打开受保护页面：%v", site.ID, validity, err),
		}
	}
	facts, err := client.Facts(ctx)
	if err != nil {
		return SiteVerdict{
			State: LoginUnknown, ExpiresAt: evidence.ExpiresAt, SessionCookie: evidence.SessionCookie,
			Reason: fmt.Sprintf("%s 的登录凭据有效（%s），但无法读取受保护页面的状态：%v", site.ID, validity, err),
		}
	}

	verdict := ClassifyPage(facts)
	base := SiteVerdict{
		Verdict: verdict, ExpiresAt: evidence.ExpiresAt, SessionCookie: evidence.SessionCookie,
	}
	switch verdict {
	case VerdictOK:
		base.State = LoginAuthenticated
		return base
	case VerdictLoginWall:
		// 会话被服务端作废时就是这一形态：凭据还在，但站点不再认它。
		base.State = LoginUnauthenticated
		base.Reason = fmt.Sprintf("%s 的登录凭据仍在（%s），但站点已不认这个会话（登录墙）：请重新登录该来源",
			site.ID, validity)
		return base
	case VerdictCaptcha, VerdictBlocked:
		// 员工其实已经登录：人机验证 / 风控是**页面访问**问题，交给取数流程处理。
		base.State = LoginAuthenticated
		what := "要求人机验证"
		if verdict == VerdictBlocked {
			what = "被站点风控拦截"
		}
		base.Reason = fmt.Sprintf(
			"%s 已登录（%s）；受保护页当前%s —— 这是页面访问问题、不是未登录。"+
				"取数时会自动尝试恢复，必要时请在那个可见窗口里完成验证（页面：%s）",
			site.ID, validity, what, facts.Href)
		return base
	default:
		base.State = LoginUnknown
		base.Reason = fmt.Sprintf("%s 的登录凭据有效（%s），但页面无法判定（%s）：可能被风控或网络异常",
			site.ID, validity, verdict)
		return base
	}
}

// credentialValidityText renders "到期 2026-10-15 16:54" / "会话 cookie" for humans.
func credentialValidityText(evidence CookieEvidence) string {
	if evidence.SessionCookie || evidence.ExpiresAt.IsZero() {
		return "会话 cookie，关掉浏览器即失效"
	}
	// 带上时区：面板读的是 UTC RFC3339，人看的是本地时间，两边不能靠猜。
	return "到期 " + evidence.ExpiresAt.Local().Format("2006-01-02 15:04 MST")
}

// Screenshot acceptance thresholds.
const (
	// minScreenshotSide rejects thumbnails and error-page fragments.
	minScreenshotSide = 200
	// sampleStride samples every Nth pixel along a row; a page-sized image has
	// millions of pixels and the ratio does not need all of them.
	sampleStride = 4
	// nonWhiteFloor is the minimum fraction of non-near-white pixels a real page
	// has. A captcha or error placeholder is almost entirely white.
	nonWhiteFloor = 0.03
	// nearWhiteCutoff is the per-channel value above which a pixel counts as white.
	nearWhiteCutoff = 235
)

// VerifyScreenshot rejects an image that is not a usable page capture.
//
// This exists because the failure it catches is silent and severe: when a batch of
// captures trips a risk check, the file written is the challenge page, and nothing
// downstream can tell it from a listing. Measured on a real hit, that image was 38KB
// with 0.9% non-white pixels.
func VerifyScreenshot(data []byte) error {
	image, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		return fmt.Errorf("截图不是合法的 PNG：%w", err)
	}
	bounds := image.Bounds()
	if bounds.Dx() < minScreenshotSide || bounds.Dy() < minScreenshotSide {
		return fmt.Errorf("截图尺寸异常（%dx%d，要求每边至少 %d）：这不是一个页面",
			bounds.Dx(), bounds.Dy(), minScreenshotSide)
	}

	sampled, nonWhite := 0, 0
	for y := bounds.Min.Y; y < bounds.Max.Y; y++ {
		for x := bounds.Min.X; x < bounds.Max.X; x += sampleStride {
			r, g, b, _ := image.At(x, y).RGBA()
			sampled++
			if int(r>>8) < nearWhiteCutoff || int(g>>8) < nearWhiteCutoff || int(b>>8) < nearWhiteCutoff {
				nonWhite++
			}
		}
	}
	if sampled == 0 {
		return fmt.Errorf("截图没有可采样的像素（%dx%d）", bounds.Dx(), bounds.Dy())
	}
	ratio := float64(nonWhite) / float64(sampled)
	if ratio < nonWhiteFloor {
		return fmt.Errorf("截图看起来是空白页（非白像素占比 %.1f%%，低于 %.0f%%）：可能是验证页或错误页",
			ratio*100, nonWhiteFloor*100)
	}
	return nil
}
