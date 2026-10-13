package browser

import "strings"

// Verdict is what a fetched page turned out to be.
//
// The distinction between these four is the whole point: "blocked" and "captcha"
// are the site refusing us, while a normal page with no matching rows is the site
// answering. Collapsing them to a boolean is how "we were blocked" gets recorded
// as "this community has no listings".
type Verdict string

const (
	VerdictOK        Verdict = "ok"
	VerdictLoginWall Verdict = "login-wall"
	VerdictCaptcha   Verdict = "captcha"
	VerdictBlocked   Verdict = "blocked"
)

// loginWall markers, observed on clogin.ke.com / clogin.lianjia.com.
var loginWallTextMarkers = []string{"用户登录", "手机快捷登录", "我已阅读并同意"}

// captcha markers. "拖动滑块" shows up on both the login page's puzzle and the
// standalone challenge page.
var captchaTextMarkers = []string{"人机验证", "安全验证", "拖动滑块", "请完成下列验证"}

// blocked markers, observed on hip.lianjia.com/forbidden.
var blockedTextMarkers = []string{"访问已被拦截"}

// ClassifyPage decides what a page is.
//
// Order matters and is deliberate: login wall, then captcha, then blocked, then
// normal. A login wall routinely carries captcha wording (the BèiKè login page
// prints "拖动滑块完成拼图" before any slider exists), and reporting that as a
// captcha sends the employee to fight a challenge that is not on screen.
func ClassifyPage(facts PageFacts) Verdict {
	title := strings.TrimSpace(facts.Title)
	text := facts.Text
	href := facts.Href

	if title == "登录" || strings.Contains(href, "clogin.") || containsAny(text, loginWallTextMarkers) {
		return VerdictLoginWall
	}
	if strings.EqualFold(title, "CAPTCHA") || containsAny(text, captchaTextMarkers) {
		return VerdictCaptcha
	}
	if containsAny(text, blockedTextMarkers) {
		return VerdictBlocked
	}
	return VerdictOK
}

func containsAny(haystack string, needles []string) bool {
	for _, needle := range needles {
		if strings.Contains(haystack, needle) {
			return true
		}
	}
	return false
}
