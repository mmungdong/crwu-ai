package browser

import "testing"

func TestClassifyPageSeparatesBlockedFromMissingData(t *testing.T) {
	cases := []struct {
		name  string
		facts PageFacts
		want  Verdict
	}{
		{"login wall by title", PageFacts{Href: "https://clogin.ke.com/login", Title: "登录"}, VerdictLoginWall},
		{"login wall by text", PageFacts{Href: "https://x/", Title: "x", Text: "用户登录 手机快捷登录"}, VerdictLoginWall},
		{"login wall by redirect host", PageFacts{Href: "https://clogin.lianjia.com/login?service=x", Title: "登录"}, VerdictLoginWall},
		{"captcha by title", PageFacts{Title: "CAPTCHA"}, VerdictCaptcha},
		{"captcha by text", PageFacts{Title: "x", Text: "人机验证 点击按钮开始验证"}, VerdictCaptcha},
		{"captcha by slider text", PageFacts{Title: "x", Text: "请完成下列验证后继续：拖动滑块验证"}, VerdictCaptcha},
		{"blocked", PageFacts{Title: "x", Text: "访问已被拦截 拦截 ID"}, VerdictBlocked},
		{"normal page", PageFacts{Href: "https://bj.ke.com/ershoufang/chaoyang/", Title: "二手房", Text: "在售"}, VerdictOK},
		{"empty page is still ok", PageFacts{}, VerdictOK},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := ClassifyPage(tc.facts); got != tc.want {
				t.Fatalf("ClassifyPage(%+v) = %q, want %q", tc.facts, got, tc.want)
			}
		})
	}
}

// 被登录墙挡住时页面往往同时带着验证码痕迹（实测贝壳登录页含「拖动滑块完成拼图」）。
// 判成验证码会把员工指去点一个还没出现的滑块，所以登录墙必须先判。
func TestClassifyPagePrefersLoginWallOverCaptchaOnTheSamePage(t *testing.T) {
	facts := PageFacts{
		Href:  "https://clogin.ke.com/login?service=x",
		Title: "登录",
		Text:  "用户登录 手机快捷登录 拖动滑块完成拼图 关闭验证 刷新验证",
	}
	if got := ClassifyPage(facts); got != VerdictLoginWall {
		t.Fatalf("ClassifyPage() = %q, want %q when both markers are present", got, VerdictLoginWall)
	}
}
