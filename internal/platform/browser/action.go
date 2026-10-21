package browser

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/netip"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// FailureKind classifies why a fetch or shot did not produce a usable artifact.
//
// One string per cause, because the causes need different responses from a person:
// sign in, solve a challenge, change network, wait, or fix a selector. A single
// "failed" collapses all of those into "the source had nothing", which is the one
// conclusion that is usually wrong.
type FailureKind string

const (
	FailureLogin       FailureKind = "login"
	FailureCaptcha     FailureKind = "captcha"
	FailureBlocked     FailureKind = "blocked"
	FailureRateLimited FailureKind = "rate-limited"
	FailureNotFound    FailureKind = "not-found"
	FailureServerError FailureKind = "server-error"
	FailureNetwork     FailureKind = "network"
	FailureUnknown     FailureKind = "unknown"
)

// FailureKindOf classifies one attempt.
//
// Precedence is navigation error, then page verdict, then status code. A failed
// navigation leaves the status at 0, and reporting that as a server error sends
// someone to investigate a site that is fine; a captcha page can answer 403, and
// reporting that as rate limiting hides that a human action is what is needed.
func FailureKindOf(verdict Verdict, status int, navErr error) FailureKind {
	if navErr != nil {
		return FailureNetwork
	}
	switch verdict {
	case VerdictLoginWall:
		return FailureLogin
	case VerdictCaptcha:
		return FailureCaptcha
	case VerdictBlocked:
		return FailureBlocked
	}
	switch {
	case status == 429 || status == 403:
		return FailureRateLimited
	case status == 401:
		return FailureLogin
	case status == 404 || status == 410:
		return FailureNotFound
	case status >= 500:
		return FailureServerError
	case status == 0:
		// 走到这里说明导航没报错、页面也判为正常，却拿不到状态码：
		// 说不清是哪一类，就不要猜。
		return FailureUnknown
	}
	return ""
}

// Options is one fetch or shot request.
type Options struct {
	URL string
	// Out is written only when the page classified as usable.
	Out string
	// Dump is written even when the page did not classify as usable, so a blocked
	// or challenged page can still be inspected instead of guessed at.
	Dump string
	// WaitMS is how long to let the page settle after navigation.
	WaitMS int
	// Scroll walks the page before reading it, so lazy content is materialised.
	Scroll bool
	// FullPage captures the whole rendered page instead of the viewport.
	FullPage bool
}

// Result is one fetch or shot outcome.
type Result struct {
	OK          bool
	FailureKind FailureKind
	Verdict     Verdict
	FinalURL    string
	Title       string
	File        string
	Digest      string
	Bytes       int
	Status      int
}

// DoFetch reads the rendered DOM of one page.
//
// A page that classifies as anything but normal is a *result*, not an error: the
// caller needs the classification to decide what to tell the employee, and the
// artifact is deliberately not written, because a login or challenge page saved
// as evidence is worse than no evidence.
func DoFetch(ctx context.Context, browser *Browser, opt Options) (Result, error) {
	return runAction(ctx, browser, opt, false)
}

// DoShot captures one full-page screenshot, under the same rules as DoFetch.
func DoShot(ctx context.Context, browser *Browser, opt Options) (Result, error) {
	return runAction(ctx, browser, opt, true)
}

func runAction(ctx context.Context, browser *Browser, opt Options, shot bool) (Result, error) {
	if browser == nil || browser.Client == nil {
		return Result{}, errors.New("浏览器会话不可用")
	}
	if strings.TrimSpace(opt.URL) == "" {
		return Result{}, errors.New("URL 为空")
	}
	// 浏览器以 --no-sandbox 运行，补偿控制之一就是「只加载允许的地址」。
	if err := requirePublicHTTPURL(opt.URL); err != nil {
		return Result{}, err
	}
	if strings.TrimSpace(opt.Out) == "" {
		return Result{}, errors.New("输出路径为空")
	}
	client := browser.Client

	if err := client.SetViewport(ctx, defaultViewportWidth, defaultViewportHeight); err != nil {
		return Result{}, fmt.Errorf("设置视口失败：%w", err)
	}
	// 全页截图会把模拟视口撑到整页高。无论后面走哪条返回路径都要还原，
	// 否则下一次动作会继承这个超大视口。
	defer restoreViewport(client)

	navErr := client.Navigate(ctx, opt.URL)
	if navErr == nil && opt.WaitMS > 0 {
		select {
		case <-ctx.Done():
			return Result{}, ctx.Err()
		case <-time.After(time.Duration(opt.WaitMS) * time.Millisecond):
		}
	}
	if navErr == nil && opt.Scroll {
		if err := client.ScrollAll(ctx); err != nil {
			return Result{}, fmt.Errorf("滚动页面失败：%w", err)
		}
	}

	facts, factsErr := client.Facts(ctx)
	verdict := ClassifyPage(facts)
	status := pageStatus(ctx, client)

	result := Result{
		Verdict: verdict, FinalURL: facts.Href, Title: facts.Title, Status: status,
	}

	kind := FailureKindOf(verdict, status, navErr)
	if kind == "" && factsErr != nil {
		// 读不出来不等于「这是一张正常页」：报成 OK 会写出一个我们根本没读懂的文件。
		kind = FailureUnknown
	}
	if kind != "" {
		result.FailureKind = kind
		result.OK = false
		if strings.TrimSpace(opt.Dump) != "" {
			// 排障用：即使没通过也要留下现场。
			if html, err := client.OuterHTML(ctx); err == nil && html != "" {
				_ = os.WriteFile(opt.Dump, []byte(html), 0o600)
			}
		}
		return result, nil
	}

	if shot {
		image, err := client.Screenshot(ctx, opt.FullPage)
		if err != nil {
			return result, fmt.Errorf("截图失败：%w", err)
		}
		if err := VerifyScreenshot(image); err != nil {
			result.FailureKind = FailureUnknown
			return result, fmt.Errorf("截图未通过校验：%w", err)
		}
		if err := os.WriteFile(opt.Out, image, 0o600); err != nil {
			return result, fmt.Errorf("写入截图失败：%w", err)
		}
		result.Bytes = len(image)
		result.Digest = digestOf(image)
	} else {
		html, err := client.OuterHTML(ctx)
		if err != nil {
			return result, fmt.Errorf("读取 DOM 失败：%w", err)
		}
		if err := os.WriteFile(opt.Out, []byte(html), 0o600); err != nil {
			return result, fmt.Errorf("写入页面失败：%w", err)
		}
		result.Bytes = len(html)
		result.Digest = digestOf([]byte(html))
	}

	result.File = opt.Out
	result.OK = true
	return result, nil
}

// restoreViewport resets the emulated viewport. It uses its own context because it
// runs from a defer, where the caller's context may already be cancelled — and a
// cancelled restore would be exactly the leak it exists to prevent.
func restoreViewport(client *Client) {
	ctx, cancel := context.WithTimeout(context.Background(), restoreTimeout)
	defer cancel()
	_ = client.SetViewport(ctx, defaultViewportWidth, defaultViewportHeight)
}

// restoreTimeout bounds the viewport restore.
const restoreTimeout = 2 * time.Second

// requirePublicHTTPURL refuses addresses the browser must not be pointed at.
//
// The browser runs without its own sandbox (see LaunchArgs), so "only load what we
// meant to load" is one of the compensating controls rather than a nicety. Rejecting
// non-HTTP schemes keeps local files out of an agent-readable artifact; rejecting
// loopback, private, and link-local hosts keeps the employee's own network from
// becoming reachable through a URL that arrived in page content.
//
// The check runs on the spelling Chromium resolves, not the one the caller supplied.
// Chromium canonicalises before it dials: it lowercases, drops the trailing root dot,
// and accepts IPv4 as 127.1, 0x7f.1, 0177.0.0.1, or 2130706433 — all of which
// net.ParseIP rejects, so judging the raw spelling let every one of them through to a
// browser with its sandbox off.
//
// Residual risk, deliberately out of scope here: the guard sees the first URL only,
// so a 302 to 127.0.0.1 is still followed, and a public name that resolves to a
// private address is still reachable. Closing those needs request interception at the
// CDP layer, not a host check.
func requirePublicHTTPURL(raw string) error {
	parsed, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("URL 不合法：%w", err)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return fmt.Errorf("只允许 http/https 地址：拒绝 %q", raw)
	}
	host := parsed.Hostname()
	if host == "" {
		return fmt.Errorf("URL 缺少主机名：%q", raw)
	}
	// Same normalisation Chromium applies before resolving: case-insensitive, and the
	// trailing dot of an absolute DNS name is not part of the identity.
	lower := strings.TrimSuffix(strings.ToLower(host), ".")
	if lower == "" {
		return fmt.Errorf("URL 缺少主机名：%q", raw)
	}
	if lower == "localhost" || strings.HasSuffix(lower, ".localhost") {
		return fmt.Errorf("拒绝本机地址：%s", host)
	}
	if addr, parseErr := netip.ParseAddr(lower); parseErr == nil {
		if !isPublicAddr(addr) {
			return fmt.Errorf("拒绝本机或内网地址：%s", host)
		}
		return nil
	}
	// Not a literal address. A single-label name is never a public site — that is how
	// `localhost.` and intranet hostnames arrive — and a name made only of numeric
	// labels is another IPv4 spelling the browser accepts.
	if !strings.Contains(lower, ".") {
		return fmt.Errorf("拒绝单标签主机名：%s（内网名不是公网站点）", host)
	}
	if looksNumeric(lower) {
		return fmt.Errorf("拒绝非标准写法的地址：%s", host)
	}
	return nil
}

// isPublicAddr reports whether an address may be dialled as a public web host.
//
// Unmap first: `::ffff:127.0.0.1` is loopback in IPv4 terms and netip's predicates
// answer for the mapped form's own family.
func isPublicAddr(addr netip.Addr) bool {
	addr = addr.Unmap()
	return !(addr.IsLoopback() || addr.IsPrivate() || addr.IsLinkLocalUnicast() ||
		addr.IsLinkLocalMulticast() || addr.IsUnspecified() || addr.IsMulticast())
}

// looksNumeric reports whether every dot-separated label is a decimal or 0x-prefixed
// number. Such a host is an IPv4 literal to the browser even when the parts do not
// fit the four-octet form (127.1, 0x7f.0.0.1, 1.2.3.4.5).
func looksNumeric(host string) bool {
	labels := strings.Split(host, ".")
	if len(labels) < 2 {
		return false
	}
	for _, label := range labels {
		if label == "" {
			return true
		}
		if strings.HasPrefix(label, "0x") || strings.HasPrefix(label, "0X") {
			if _, err := strconv.ParseUint(label[2:], 16, 32); err != nil {
				return false
			}
			continue
		}
		if _, err := strconv.ParseUint(label, 10, 32); err != nil {
			return false
		}
	}
	return true
}

// statusExpression reads the document's HTTP status from the Navigation Timing API.
// It is best-effort: the page verdict, not the status, is the authority, and a
// browser that does not expose this field simply yields 0.
const statusExpression = `String((performance.getEntriesByType("navigation")[0]||{}).responseStatus||0)`

func pageStatus(ctx context.Context, client *Client) int {
	raw, err := client.Call(ctx, "Runtime.evaluate", map[string]any{
		"expression": statusExpression, "returnByValue": true,
	})
	if err != nil {
		return 0
	}
	var payload struct {
		Result struct {
			Value json.RawMessage `json:"value"`
		} `json:"result"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return 0
	}
	// `returnByValue` hands back whatever type the expression produced, so accept
	// both a JSON string and a JSON number instead of assuming the coercion held.
	var asString string
	if err := json.Unmarshal(payload.Result.Value, &asString); err == nil {
		var status int
		if _, err := fmt.Sscanf(asString, "%d", &status); err == nil {
			return status
		}
		return 0
	}
	var asNumber float64
	if err := json.Unmarshal(payload.Result.Value, &asNumber); err == nil {
		return int(asNumber)
	}
	return 0
}

func digestOf(data []byte) string {
	sum := sha256.Sum256(data)
	return "sha256:" + hex.EncodeToString(sum[:])
}
