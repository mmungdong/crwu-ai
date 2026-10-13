package browser

import (
	"bytes"
	"context"
	"fmt"
	"image/png"
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
func AuthCookiePresent(cookies []Cookie, site Site) bool {
	for _, cookie := range cookies {
		if cookie.Name != site.AuthCookie || cookie.Value == "" {
			continue
		}
		if len(site.AuthDomains) == 0 {
			return true
		}
		for _, domain := range site.AuthDomains {
			if cookie.Domain == domain {
				return true
			}
		}
	}
	return false
}

// VerifySite decides the site's session state.
//
// Two stages on purpose. The cookie check is cheap and rejects the clearly signed
// out case without touching the network. The navigation is the authority: a cookie
// can be present and expired, and only loading a page that requires a session shows
// which it is.
//
// The returned reason is written for an employee and never contains a cookie value.
func VerifySite(ctx context.Context, client *Client, site Site) (LoginState, string) {
	cookies, err := client.Cookies(ctx)
	if err != nil {
		return LoginUnknown, fmt.Sprintf("无法读取 %s 的登录凭据：%v", site.ID, err)
	}
	if !AuthCookiePresent(cookies, site) {
		return LoginUnauthenticated, fmt.Sprintf("%s 没有登录凭据：请先登录该来源", site.ID)
	}

	if err := client.Navigate(ctx, site.ProtectedURL); err != nil {
		return LoginUnknown, fmt.Sprintf("无法打开 %s 的受保护页面：%v", site.ID, err)
	}
	facts, err := client.Facts(ctx)
	if err != nil {
		return LoginUnknown, fmt.Sprintf("无法读取 %s 的页面状态：%v", site.ID, err)
	}

	switch ClassifyPage(facts) {
	case VerdictOK:
		return LoginAuthenticated, ""
	case VerdictLoginWall:
		return LoginUnauthenticated, fmt.Sprintf("%s 仍被登录墙挡住：请重新登录该来源", site.ID)
	default:
		return LoginUnknown, fmt.Sprintf("%s 的页面无法判定登录状态（%s）：可能被风控或网络异常",
			site.ID, ClassifyPage(facts))
	}
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
