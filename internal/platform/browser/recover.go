package browser

import (
	"context"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/rand"
	"net/url"
	"strings"
	"time"
)

// geetestProbeScript is the fixed probe. It is embedded rather than read from disk
// so the capability travels with the binary: a Skill installed on an employee's
// machine never has to point at a source-repository path.
//
//go:embed challenges/geetest_v3_probe.js
var geetestProbeScript string

// RecoveryStrategy is one bounded way to get back to the page we were reading.
type RecoveryStrategy string

const (
	// StrategyAuto tries the fixed script first, then a bounded cooldown.
	StrategyAuto RecoveryStrategy = "auto"
	// StrategyCooldownRenavigate waits, then re-enters the original URL. This is the
	// only strategy the archive contains execution evidence for (event 849 recorded
	// a first attempt with no visible challenge after a 120s wait).
	StrategyCooldownRenavigate RecoveryStrategy = "cooldown-renavigate"
	// StrategyGeetestV3Canvas solves a visible Geetest v3 canvas challenge: read the
	// canvases, compute the notch offset, replay a pointer drag, read the page back.
	//
	// ⚠️ This strategy is a **candidate**, not a verified one. The archive proves the
	// script was written (event 375) but contains no run in which the slider was
	// solved and verified; the only recorded recovery is the cooldown path. Nothing
	// may report this strategy as "verified" until an independent real-page
	// acceptance records a recovery.
	StrategyGeetestV3Canvas RecoveryStrategy = "geetest-v3-canvas"
)

// RecoveryStrategies is the closed set the CLI accepts.
var RecoveryStrategies = []RecoveryStrategy{StrategyAuto, StrategyCooldownRenavigate, StrategyGeetestV3Canvas}

// ParseRecoveryStrategy narrows a caller-supplied strategy name.
func ParseRecoveryStrategy(raw string) (RecoveryStrategy, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return StrategyAuto, nil
	}
	for _, candidate := range RecoveryStrategies {
		if string(candidate) == value {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("未知的恢复策略：%q（可用：auto、cooldown-renavigate、geetest-v3-canvas）", raw)
}

// RecoveryState is the terminal state of one recovery run.
type RecoveryState string

const (
	RecoveryRecovered   RecoveryState = "recovered"
	RecoveryWaitingUser RecoveryState = "waiting-user"
	RecoveryUnsupported RecoveryState = "unsupported"
	RecoveryCancelled   RecoveryState = "cancelled"
	RecoveryUnavailable RecoveryState = "unavailable"
	RecoveryFailed      RecoveryState = "failed"
)

// ChallengeFamily is what the probe found on screen.
//
// The families exist because the responses differ: a slider wants the fixed script, a
// login wall wants the employee's sign-in, a rate limit wants waiting, and hidden
// captcha markup wants nothing at all.
type ChallengeFamily string

const (
	ChallengeNone            ChallengeFamily = "none"
	ChallengeGeetestV3Canvas ChallengeFamily = "geetest-v3-canvas"
	ChallengeGeetestV3DOM    ChallengeFamily = "geetest-v3-dom"
	ChallengeLoginWall       ChallengeFamily = "login-wall"
	ChallengeBlocked         ChallengeFamily = "blocked"
	ChallengeUnreachable     ChallengeFamily = "unreachable"
	// ChallengeSiteChallengePage is the site's own human-verification page: the
	// protected URL was redirected to it (observed 2026-10-15: `bj.lianjia.com/...`
	// → `hip.lianjia.com/captcha`, title `CAPTCHA`) and it carries no widget the
	// fixed script can drive. A person clears it in the visible window; the same
	// retrieval task continues afterwards.
	ChallengeSiteChallengePage ChallengeFamily = "site-challenge-page"
)

// Recovery reason codes. They are part of the CLI contract: a caller has to tell
// "wait for the human" from "we have no strategy for this" without reading prose.
const (
	// ReasonChallengePageWaitingUser: the site answered the protected page with its
	// own verification page. Solvable by a person, not by us.
	ReasonChallengePageWaitingUser = "challenge-page-waiting-user"
	// ReasonChallengeFamilyUnsupported: a visible challenge whose shape no fixed
	// strategy covers.
	ReasonChallengeFamilyUnsupported = "challenge-family-unsupported"
)

// challengePathMarkers are path segments only a site's verification route uses.
// Matching happens on the URL path, never on Chinese page copy: business pages keep
// captcha wording in their HTML indefinitely (observed 2026-10-14).
var challengePathMarkers = []string{"captcha", "verify", "verification", "challenge"}

// challengeTitleMarkers are the words a verification page puts in its own title.
var challengeTitleMarkers = []string{"captcha", "verify", "verification", "challenge"}

// IsChallengePage reports whether the page at finalURL is the site's own
// human-verification page.
//
// It reads structure — the URL path and the document title — because page copy
// cannot decide this: a normal listing page carries "人机验证" in its markup, and
// treating that as a challenge sends the employee to fight a widget that is not on
// screen.
func IsChallengePage(finalURL, title string) bool {
	parsed, err := url.Parse(strings.TrimSpace(finalURL))
	if err == nil {
		for _, segment := range strings.Split(strings.ToLower(parsed.Path), "/") {
			for _, marker := range challengePathMarkers {
				if segment == marker || strings.HasPrefix(segment, marker+".") {
					return true
				}
			}
		}
	}
	lowerTitle := strings.ToLower(strings.TrimSpace(title))
	for _, marker := range challengeTitleMarkers {
		if strings.Contains(lowerTitle, marker) {
			return true
		}
	}
	return false
}

// Recovery budget caps. They are enforced here, not trusted from argv: a caller that
// asks for a hundred attempts gets two. The requirement is "at most 2 automatic
// attempts inside a 120s window", and a bound that the caller can widen is not a
// bound.
const (
	RecoveryMaxAttempts     = 2
	RecoveryMaxWindow       = 120 * time.Second
	RecoveryMaxScriptCall   = 30 * time.Second
	RecoveryProbeSettle     = 2600 * time.Millisecond
	RecoveryDefaultCoolDown = 30 * time.Second
	RecoveryMaxCoolDown     = 120 * time.Second
)

// ChallengeBox is one on-screen control the probe found.
type ChallengeBox struct {
	Selector string `json:"selector"`
	Box      [4]int `json:"box"`
	Hit      bool   `json:"hit"`
}

// ChallengeCanvas is one visible canvas, with its intrinsic size and PNG bytes.
type ChallengeCanvas struct {
	Selector  string `json:"selector"`
	ClassName string `json:"className"`
	Box       [4]int `json:"box"`
	Intrinsic struct {
		W int `json:"w"`
		H int `json:"h"`
	} `json:"intrinsic"`
	Tainted bool   `json:"tainted"`
	PNG     string `json:"png"`
}

// ChallengeProbe mirrors the embedded script's payload.
type ChallengeProbe struct {
	Present        bool              `json:"present"`
	Family         string            `json:"family"`
	Tainted        bool              `json:"tainted"`
	InIframe       bool              `json:"inIframe"`
	Href           string            `json:"href"`
	Title          string            `json:"title"`
	Overlay        *ChallengeBox     `json:"overlay"`
	SliderButton   *ChallengeBox     `json:"sliderButton"`
	Track          *ChallengeBox     `json:"track"`
	Canvases       []ChallengeCanvas `json:"canvases"`
	SuccessVisible bool              `json:"successVisible"`
	FailVisible    bool              `json:"failVisible"`
	BodyHas        struct {
		Slider      bool `json:"slider"`
		SuccessText bool `json:"successText"`
		FailText    bool `json:"failText"`
	} `json:"bodyHas"`
	Error string `json:"error"`
}

// PageValidation is the page-level evidence that a recovery actually worked. The
// caller adds listing-level checks on top of it.
type PageValidation struct {
	FinalURL         string   `json:"finalUrl"`
	Title            string   `json:"title"`
	HostMatches      bool     `json:"hostMatches"`
	Readable         bool     `json:"readable"`
	ChallengeVisible bool     `json:"challengeVisible"`
	LoginWall        bool     `json:"loginWall"`
	Blocked          bool     `json:"blocked"`
	OverlaySelectors []string `json:"overlaySelectors"`
	Reason           string   `json:"reason"`
}

// RecoveryRequest is one bounded recovery of one retrieval task.
type RecoveryRequest struct {
	// URL is the page the original retrieval was reading. Recovery always returns to it.
	URL string
	// Strategy is the caller's choice; StrategyAuto is the default.
	Strategy RecoveryStrategy
	// ProviderID and RetrievalTaskID are echoed back so the caller can match the
	// outcome to the task it was reading. They are opaque here.
	ProviderID      string
	RetrievalTaskID string
	// RecoveryID makes a retry of the same task idempotent at the caller's level.
	RecoveryID string
	// Bounds. Zero values take the documented defaults; every value is clamped to the
	// hard caps above.
	MaxAttempts   int
	Window        time.Duration
	ScriptTimeout time.Duration
	// Cooldown is how long the caller is willing to wait before re-entering the URL.
	// A cooldown longer than the remaining window is not truncated: the outcome
	// carries NextEligibleAt instead, so the site is not hammered.
	Cooldown time.Duration
	// cooldownExplicit says the caller stated a cooldown on purpose — including zero.
	// It exists so "the coordinator owns the cooldown schedule" can be expressed as
	// an explicit 0 instead of being overridden by a strategy default.
	cooldownExplicit bool
	// settle is how long to let the page react after a drag or a re-navigation
	// before reading it back. Unexported: it exists so tests do not spend seconds
	// waiting, and production always takes the measured default.
	settle time.Duration
}

// SetCooldownExplicit marks the cooldown as caller-decided.
//
// Without it, `--cooldown-ms 0` would be indistinguishable from "the flag was not
// given", and `cooldown-renavigate` would silently impose its own default wait —
// which is exactly the behaviour the Host coordinator must be able to switch off.
func (r *RecoveryRequest) SetCooldownExplicit(explicit bool) {
	r.cooldownExplicit = explicit
}

// RecoveryOutcome is what the caller records and shows.
type RecoveryOutcome struct {
	RecoveryID      string          `json:"recoveryId"`
	RetrievalTaskID string          `json:"retrievalTaskId"`
	ProviderID      string          `json:"providerId"`
	StrategyID      string          `json:"strategyId"`
	StrategyVersion string          `json:"strategyVersion"`
	Attempts        int             `json:"attempts"`
	BeforeKind      ChallengeFamily `json:"beforeKind"`
	AfterKind       ChallengeFamily `json:"afterKind"`
	State           RecoveryState   `json:"state"`
	ReasonCode      string          `json:"reasonCode"`
	NextEligibleAt  string          `json:"nextEligibleAt"`
	PageValidation  PageValidation  `json:"pageValidation"`
	Strategies      []string        `json:"strategies"`
	Notes           []string        `json:"notes"`
}

// RecoveryStrategyVersion is bumped whenever the fixed script or the drag heuristic
// changes, so a recorded recovery can be attributed to a specific behaviour.
const RecoveryStrategyVersion = "1"

// ProbeChallenge runs the embedded probe and classifies what is on screen.
func ProbeChallenge(ctx context.Context, client *Client) (ChallengeProbe, error) {
	if client == nil {
		return ChallengeProbe{}, errors.New("浏览器会话不可用")
	}
	raw, err := client.Call(ctx, "Runtime.evaluate", map[string]any{
		"expression": geetestProbeScript, "returnByValue": true,
	})
	if err != nil {
		return ChallengeProbe{}, err
	}
	var payload struct {
		Result struct {
			Value string `json:"value"`
		} `json:"result"`
		ExceptionDetails *struct {
			Text string `json:"text"`
		} `json:"exceptionDetails"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return ChallengeProbe{}, fmt.Errorf("解析挑战探针响应失败：%w", err)
	}
	if payload.ExceptionDetails != nil {
		return ChallengeProbe{}, fmt.Errorf("挑战探针在页面里报错：%s", payload.ExceptionDetails.Text)
	}
	var probe ChallengeProbe
	if err := json.Unmarshal([]byte(payload.Result.Value), &probe); err != nil {
		return ChallengeProbe{}, fmt.Errorf("挑战探针的返回值不是合法 JSON：%w", err)
	}
	return probe, nil
}

// ChallengeFamilyOf reads the family out of a probe plus the page verdict.
//
// The page verdict participates because a login wall routinely carries slider
// wording: the widget's markup is present but the real blocker is "you are not signed
// in", and running the slider script there solves nothing.
func ChallengeFamilyOf(probe ChallengeProbe, verdict Verdict) ChallengeFamily {
	if probe.Present {
		if probe.Family == string(ChallengeGeetestV3Canvas) {
			return ChallengeGeetestV3Canvas
		}
		return ChallengeGeetestV3DOM
	}
	switch verdict {
	case VerdictLoginWall:
		return ChallengeLoginWall
	case VerdictCaptcha:
		// The wording says captcha but nothing is visible: this is the archived
		// false-positive shape (event 414–415). Report it as no challenge so the
		// caller does not fight a widget that is not there.
		return ChallengeNone
	case VerdictBlocked:
		return ChallengeBlocked
	}
	return ChallengeNone
}

// ChallengeFamilyOfPage is ChallengeFamilyOf plus the URL facts.
//
// A site can refuse the protected page by pointing the tab at its own verification
// page instead of rendering a widget there. That page has nothing for the fixed
// script to drive, and it is not "no challenge" either: it is the site asking for a
// person. Telling those apart needs the final URL, which is why this is a separate
// function — the widget-only verdict keeps its original meaning.
func ChallengeFamilyOfPage(probe ChallengeProbe, facts PageFacts, verdict Verdict, target string) ChallengeFamily {
	if probe.Present {
		return ChallengeFamilyOf(probe, verdict)
	}
	// A sign-out is not a challenge page: the login wall owns that answer, and the
	// employee has to sign in rather than clear a puzzle.
	if verdict == VerdictLoginWall {
		return ChallengeLoginWall
	}
	if IsChallengePage(facts.Href, facts.Title) {
		return ChallengeSiteChallengePage
	}
	return ChallengeFamilyOf(probe, verdict)
}

// recoveredPage reports whether a page read back is the original page again with
// nothing left for a person to do.
//
// All three facts are required and each one has a field failure behind it: a page on
// another host is not the page we asked for (observed 2026-10-14 as an attached Edge
// new-tab page reported as "recovered"), an unreadable document is not evidence, and
// a visible challenge means the work is not done. `challengeVisible === false` on
// its own is never enough.
func recoveredPage(family ChallengeFamily, validation PageValidation) bool {
	return family == ChallengeNone &&
		validation.HostMatches &&
		validation.Readable &&
		!validation.ChallengeVisible
}

// siteChallengePageReason names where the site sent the tab, in the employee's words.
func siteChallengePageReason(target, finalURL string) string {
	where := "站点把原页面换成了它自己的人机验证页"
	original, originalErr := url.Parse(target)
	final, finalErr := url.Parse(finalURL)
	if originalErr == nil && finalErr == nil && !strings.EqualFold(original.Hostname(), final.Hostname()) {
		where = fmt.Sprintf("站点把原页面重定向到了它自己的人机验证页（%s → %s）",
			original.Hostname(), final.Hostname())
	}
	return where + "：那一页没有可驱动的验证控件，请在可见窗口完成验证后用同一取数任务继续"
}

// DetectChallenge answers "is there something on screen a human would have to
// touch?" without attempting anything. The valuation transport uses it to decide
// whether to invoke recovery at all.
func DetectChallenge(ctx context.Context, client *Client) (ChallengeFamily, ChallengeProbe, error) {
	probe, err := ProbeChallenge(ctx, client)
	if err != nil {
		return ChallengeUnreachable, ChallengeProbe{}, err
	}
	facts, factsErr := client.Facts(ctx)
	verdict := VerdictOK
	if factsErr != nil {
		verdict = VerdictBlocked
	} else {
		verdict = ClassifyPage(facts)
	}
	return ChallengeFamilyOf(probe, verdict), probe, nil
}

// Recover runs one bounded recovery.
//
// It returns an outcome for every path a caller has to distinguish — including
// "unsupported" and "waiting-user" — and an error only when the browser session
// itself is unusable. That asymmetry is deliberate: "the site showed a challenge we
// cannot solve" is a business fact the caller must record, not an exception.
func Recover(ctx context.Context, session *Browser, req RecoveryRequest) (RecoveryOutcome, error) {
	if session == nil || session.Client == nil {
		return RecoveryOutcome{}, errors.New("浏览器会话不可用")
	}
	target := strings.TrimSpace(req.URL)
	if target == "" {
		return RecoveryOutcome{}, errors.New("缺少 --url：恢复必须回到原页面")
	}
	if err := requirePublicHTTPURL(target); err != nil {
		return RecoveryOutcome{}, err
	}
	strategy, err := ParseRecoveryStrategy(string(req.Strategy))
	if err != nil {
		return RecoveryOutcome{}, err
	}
	maxAttempts := clampInt(req.MaxAttempts, 1, RecoveryMaxAttempts, RecoveryMaxAttempts)
	window := clampDuration(req.Window, time.Second, RecoveryMaxWindow, RecoveryMaxWindow)
	scriptTimeout := clampDuration(req.ScriptTimeout, time.Second, RecoveryMaxScriptCall, RecoveryMaxScriptCall)
	// A cooldown is opt-in. The caller (the Host coordinator) owns the cooldown
	// schedule, so an unspecified cooldown means "do not wait in this process" —
	// except for the strategy whose whole point is waiting.
	coolDown := time.Duration(0)
	switch {
	case req.Cooldown > 0:
		coolDown = req.Cooldown
		if coolDown > RecoveryMaxCoolDown {
			coolDown = RecoveryMaxCoolDown
		}
	case req.cooldownExplicit:
		// 调用方明确说"冷却由我自己管"：这里一次都不等。
		coolDown = 0
	case strategy == StrategyCooldownRenavigate:
		coolDown = RecoveryDefaultCoolDown
	}
	settle := req.settle
	if settle <= 0 {
		settle = RecoveryProbeSettle
	}

	client := session.Client
	outcome := RecoveryOutcome{
		RecoveryID:      req.RecoveryID,
		RetrievalTaskID: req.RetrievalTaskID,
		ProviderID:      req.ProviderID,
		StrategyID:      string(strategy),
		StrategyVersion: RecoveryStrategyVersion,
		State:           RecoveryFailed,
		ReasonCode:      "",
		Strategies:      []string{},
	}
	deadline := time.Now().Add(window)

	// A previous run may have died mid-drag. Clearing the pressed state before doing
	// anything else is what keeps a stuck left button from turning the next
	// navigation into a text selection.
	releasePointer(context.WithoutCancel(ctx), client, 0, 0)

	for attempt := 1; attempt <= maxAttempts; attempt++ {
		if ctxErr := ctx.Err(); ctxErr != nil {
			outcome.State = RecoveryCancelled
			outcome.ReasonCode = "cancelled"
			outcome.PageValidation.Reason = "调用方取消了恢复"
			return outcome, nil
		}
		if !time.Now().Before(deadline) {
			outcome.ReasonCode = "window-exhausted"
			break
		}
		outcome.Attempts = attempt

		// **先回到原 URL**（设计稿 §8.4 的第一步）。没有这一步，读到的就是附着标签页
		// 碰巧显示的那一页 —— 真机实测过：附着目标是 Edge 的新标签页（`ntp.msn.cn`），
		// 于是"某个别的页面上没有挑战"被当成了恢复成功。
		if err := client.Navigate(ctx, target); err != nil {
			outcome.State = RecoveryUnavailable
			outcome.ReasonCode = "target-unreachable"
			outcome.PageValidation.Reason = fmt.Sprintf("无法回到原页面（%s）：%v", target, err)
			return outcome, nil
		}

		probeCtx, cancel := context.WithTimeout(ctx, scriptTimeout)
		probe, probeErr := ProbeChallenge(probeCtx, client)
		cancel()
		if probeErr != nil {
			outcome.State = RecoveryUnavailable
			outcome.ReasonCode = "probe-unavailable"
			outcome.PageValidation.Reason = "无法读取页面挑战状态：" + probeErr.Error()
			return outcome, nil
		}
		facts, factsErr := client.Facts(ctx)
		verdict := VerdictOK
		if factsErr != nil {
			verdict = VerdictBlocked
		} else {
			verdict = ClassifyPage(facts)
		}
		family := ChallengeFamilyOfPage(probe, facts, verdict, target)
		if attempt == 1 {
			outcome.BeforeKind = family
		}
		validation := pageValidationOf(probe, facts, target, verdict)
		outcome.PageValidation = validation

		switch family {
		case ChallengeNone:
			if recoveredPage(family, validation) {
				return finishRecovered(outcome, validation, "no-visible-challenge"), nil
			}
			// "没有可见挑战"只有在**确实回到了原站点的那一页**时才等于恢复成功。
			// 最终 URL 不在原站点上说明我们读的根本不是那一页（新标签页、被带去别处、
			// 或站点把我们重定向走了）：这时报 recovered 就是最典型的假成功。
			outcome.State = RecoveryWaitingUser
			outcome.ReasonCode = "not-original-page"
			validation.Reason = fmt.Sprintf(
				"读到的页面不在原站点（%s）：这不能当作恢复成功，请在当前浏览器打开原页面后继续同一任务",
				validation.FinalURL)
			outcome.PageValidation = validation
			return outcome, nil
		case ChallengeSiteChallengePage:
			// 实测形态（2026-10-15）：`bj.lianjia.com/ershoufang/` → `hip.lianjia.com/captcha`
			// （标题 CAPTCHA），那一页上没有固定脚本能驱动的控件。自动化到此为止 —— 但这不是
			// "做不了"：员工在那个可见窗口里过一次验证，同一个取数任务就能继续。
			// 所以是 waiting-user（可继续），不是 unsupported（死路）。
			outcome.State = RecoveryWaitingUser
			outcome.ReasonCode = ReasonChallengePageWaitingUser
			validation.Reason = siteChallengePageReason(target, validation.FinalURL)
			outcome.PageValidation = validation
			return outcome, nil
		case ChallengeLoginWall:
			// A real sign-out is not a challenge: solving a slider here would be
			// substituting for the employee's login.
			outcome.State = RecoveryWaitingUser
			outcome.ReasonCode = "login-required"
			validation.Reason = "页面要求登录：请在当前浏览器完成登录后继续同一任务"
			outcome.PageValidation = validation
			return outcome, nil
		case ChallengeBlocked:
			outcome.State = RecoveryWaitingUser
			outcome.ReasonCode = "site-blocked"
			validation.Reason = "站点返回了访问拦截：这不是滑块挑战，请稍后重试或改用人工作业"
			outcome.PageValidation = validation
			return outcome, nil
		case ChallengeGeetestV3DOM:
			outcome.State = RecoveryUnsupported
			outcome.ReasonCode = ReasonChallengeFamilyUnsupported
			validation.Reason = "检测到可见挑战，但它不是已适配的极验 v3 canvas 形态：请人工在当前浏览器完成验证"
			outcome.PageValidation = validation
			return outcome, nil
		case ChallengeGeetestV3Canvas:
			// 唯一会走到下面拖拽逻辑的分支：**看得见**的、已适配的挑战。
			// `challengeVisible === false` 的页面在上面的分支就已经返回，永远不会到这里 ——
			// 看不见的东西没有可拖的控件，盲拖正是这个包拒绝做的猜测。
		default:
			outcome.State = RecoveryWaitingUser
			outcome.ReasonCode = "challenge-unknown"
			validation.Reason = "页面形态无法归入任何已知挑战族：不会对它重放拖拽，请人工确认"
			outcome.PageValidation = validation
			return outcome, nil
		}

		// Remaining window decides whether a cooldown fits. A cooldown that does not
		// fit is reported, never truncated into a burst against the site.
		remaining := time.Until(deadline)
		wantCooldown := coolDown > 0 &&
			(strategy == StrategyCooldownRenavigate || (strategy == StrategyAuto && attempt > 1))
		if wantCooldown {
			if coolDown > remaining {
				outcome.State = RecoveryWaitingUser
				outcome.ReasonCode = "cooldown-exceeds-window"
				outcome.NextEligibleAt = time.Now().Add(coolDown).UTC().Format(time.RFC3339)
				validation.Reason = "站点要求冷却，剩余窗口不足以等待：已记录下次可尝试时间"
				outcome.PageValidation = validation
				return outcome, nil
			}
			select {
			case <-ctx.Done():
				outcome.State = RecoveryCancelled
				outcome.ReasonCode = "cancelled"
				return outcome, nil
			case <-time.After(coolDown):
			}
		}

		if strategy == StrategyCooldownRenavigate || (strategy == StrategyAuto && attempt > 1) {
			outcome.Strategies = appendUnique(outcome.Strategies, string(StrategyCooldownRenavigate))
			if err := client.Navigate(ctx, target); err != nil {
				outcome.Notes = append(outcome.Notes, "重新进入原页面失败："+err.Error())
				continue
			}
			if err := waitWithin(ctx, deadline, settle); err != nil {
				break
			}
			continue
		}

		outcome.Strategies = appendUnique(outcome.Strategies, string(StrategyGeetestV3Canvas))
		solveErr := solveGeetestV3Canvas(ctx, client, probe, scriptTimeout)
		if solveErr != nil {
			if errors.Is(solveErr, errChallengeUnsupported) {
				// The family matched but our fixed script could not read the widget
				// (no canvas, tainted canvas, no replayable origin). That is a
				// different fact from "this shape has no strategy at all".
				outcome.State = RecoveryUnsupported
				outcome.ReasonCode = "challenge-not-solvable"
				validation.Reason = solveErr.Error()
				outcome.PageValidation = validation
				return outcome, nil
			}
			outcome.Notes = append(outcome.Notes, "固定脚本未能完成一次拖拽："+solveErr.Error())
			// The script's exit status is not the verdict; the page is. Fall through to
			// the re-read below.
		}
		if err := waitWithin(ctx, deadline, settle); err != nil {
			break
		}
	}

	// Budget spent. Re-read once so the recorded page facts are the ones the employee
	// will see, then hand back to the person.
	finalProbe, probeErr := ProbeChallenge(context.WithoutCancel(ctx), client)
	validation := outcome.PageValidation
	if probeErr == nil {
		facts, factsErr := client.Facts(context.WithoutCancel(ctx))
		verdict := VerdictBlocked
		if factsErr == nil {
			verdict = ClassifyPage(facts)
		}
		family := ChallengeFamilyOfPage(finalProbe, facts, verdict, target)
		validation = pageValidationOf(finalProbe, facts, target, verdict)
		outcome.AfterKind = family
		// The same three facts are required here as inside the loop. Checking only
		// "no visible challenge" once reported a recovery from a page we never got
		// back to, and from a page whose facts could not be read at all.
		if recoveredPage(family, validation) {
			return finishRecovered(outcome, validation, "recovered-after-budget"), nil
		}
	} else {
		outcome.AfterKind = ChallengeUnreachable
	}
	outcome.State = RecoveryWaitingUser
	if outcome.ReasonCode == "" {
		outcome.ReasonCode = "budget-exhausted"
	}
	if outcome.AfterKind == ChallengeSiteChallengePage {
		validation.Reason = siteChallengePageReason(target, validation.FinalURL)
	} else {
		validation.Reason = "自动恢复未通过：请在当前浏览器完成网页验证后继续同一任务"
	}
	outcome.PageValidation = validation
	if coolDown > 0 {
		outcome.NextEligibleAt = time.Now().Add(coolDown).UTC().Format(time.RFC3339)
	}
	return outcome, nil
}

func finishRecovered(outcome RecoveryOutcome, validation PageValidation, reason string) RecoveryOutcome {
	outcome.State = RecoveryRecovered
	outcome.ReasonCode = reason
	validation.ChallengeVisible = false
	if validation.Reason == "" {
		validation.Reason = "页面已无可见挑战"
	}
	outcome.PageValidation = validation
	return outcome
}

var errChallengeUnsupported = errors.New("challenge not solvable by the fixed script")

// solveGeetestV3Canvas runs the fixed solver for one visible canvas challenge.
func solveGeetestV3Canvas(ctx context.Context, client *Client, probe ChallengeProbe, scriptTimeout time.Duration) error {
	button := probe.SliderButton
	if button == nil {
		button = probe.Track
	}
	if button == nil {
		return fmt.Errorf("%w：没有找到滑块控件", errChallengeUnsupported)
	}
	if probe.Tainted {
		return fmt.Errorf("%w：挑战画布被跨域图片污染，读不到像素", errChallengeUnsupported)
	}
	if probe.InIframe {
		return fmt.Errorf("%w：挑战在跨域 iframe 内，固定脚本无法读取", errChallengeUnsupported)
	}

	full := canvasMatching(probe.Canvases, "fullbg")
	gap := canvasMatching(probe.Canvases, "canvas_bg")
	slice := canvasMatching(probe.Canvases, "slice")
	if gap == nil && slice == nil {
		return fmt.Errorf("%w：没有可用的挑战画布", errChallengeUnsupported)
	}

	fullPNG, err := decodeDataURL(full)
	if err != nil && full != nil {
		return err
	}
	gapPNG, err := decodeDataURL(gap)
	if err != nil && gap != nil {
		return err
	}
	slicePNG, err := decodeDataURL(slice)
	if err != nil && slice != nil {
		return err
	}

	// Pass 1: the full background against the notched background.
	intrinsicOffset := -1
	if fullPNG != nil && gapPNG != nil {
		if offset, diffErr := GapOffsetByDiff(fullPNG, gapPNG); diffErr == nil {
			intrinsicOffset = offset
		}
	}
	// Pass 2: template-match the piece inside the background.
	if intrinsicOffset < 0 && gapPNG != nil && slicePNG != nil {
		if offset, tmplErr := GapOffsetByTemplate(gapPNG, slicePNG); tmplErr == nil {
			intrinsicOffset = offset
		}
	}
	if intrinsicOffset < 0 {
		return fmt.Errorf("%w：在画布上定位不到缺口", errChallengeUnsupported)
	}

	// The piece's own resting position is subtracted instead of a magic bias
	// constant. The archived solver used `bias = -6`, which is a property of one
	// widget rendering on one machine, not a rule.
	rest := 0
	if slice != nil {
		if restX, restErr := intrinsicLeft(slicePNG); restErr == nil {
			rest = restX
		}
	}
	delta := intrinsicOffset - rest
	if delta <= 0 {
		// The notch is at or left of the piece: nothing to drag. The page may have
		// already moved on, so let the caller re-read it rather than dragging backwards.
		return nil
	}

	intrinsicWidth := 0
	cssWidth := 0.0
	if gap != nil {
		intrinsicWidth = gap.Intrinsic.W
		cssWidth = float64(gap.Box[2])
	} else if full != nil {
		intrinsicWidth = full.Intrinsic.W
		cssWidth = float64(full.Box[2])
	}
	dragPixels, convErr := CSSOffset(delta, intrinsicWidth, cssWidth)
	if convErr != nil {
		return fmt.Errorf("%w：%s", errChallengeUnsupported, convErr.Error())
	}
	if dragPixels <= 0 || dragPixels > 4*intrinsicWidth {
		return fmt.Errorf("%w：算出的拖拽距离不合理（%d px）", errChallengeUnsupported, dragPixels)
	}

	startX := float64(button.Box[0]) + float64(button.Box[2])/2
	startY := float64(button.Box[1]) + float64(button.Box[3])/2
	if startX <= 0 || startY <= 0 {
		return fmt.Errorf("%w：滑块控件的位置不可用", errChallengeUnsupported)
	}
	return dragSlider(ctx, client, startX, startY, dragPixels)
}

// dragSlider replays a pointer drag.
//
// The trajectory is the archived heuristic (fast ease-out approach, a small
// overshoot, a correction back to the target, per-step jitter). It is a heuristic:
// the challenge is scored server-side, so this either passes or it does not, and the
// caller decides by re-reading the page. Every exit path releases the button with a
// fresh context, because a cancelled cancellation would leave the mouse pressed.
func dragSlider(ctx context.Context, client *Client, startX, startY float64, distance int) error {
	defer func() {
		releasePointer(context.WithoutCancel(ctx), client, startX+float64(distance), startY)
	}()

	overshoot := math.Min(14, math.Max(4, float64(distance)*0.03))
	total := float64(distance) + overshoot
	steps := int(math.Max(24, total/9))
	if steps > 240 {
		steps = 240
	}

	if _, err := client.Call(ctx, "Input.dispatchMouseEvent", map[string]any{
		"type": "mouseMoved", "x": startX, "y": startY,
	}); err != nil {
		return err
	}
	if err := sleepCtx(ctx, 120*time.Millisecond); err != nil {
		return err
	}
	if _, err := client.Call(ctx, "Input.dispatchMouseEvent", map[string]any{
		"type": "mousePressed", "x": startX, "y": startY, "button": "left", "buttons": 1, "clickCount": 1,
	}); err != nil {
		return err
	}
	if err := sleepCtx(ctx, 90*time.Millisecond); err != nil {
		return err
	}

	for step := 1; step <= steps; step++ {
		t := float64(step) / float64(steps)
		eased := 1 - math.Pow(1-t, 3)
		x := total*eased + (rand.Float64()-0.5)*1.6
		y := (rand.Float64() - 0.5) * 1.4
		if _, err := client.Call(ctx, "Input.dispatchMouseEvent", map[string]any{
			"type": "mouseMoved", "x": startX + x, "y": startY + y, "button": "left", "buttons": 1,
		}); err != nil {
			return err
		}
		pause := 6 + rand.Float64()*14
		if t > 0.92 {
			pause += 40
		}
		if err := sleepCtx(ctx, time.Duration(pause)*time.Millisecond); err != nil {
			return err
		}
	}

	// Correction pass back onto the exact target.
	for step := 1; step <= 4; step++ {
		x := total - overshoot*float64(step)/4
		y := (rand.Float64() - 0.5) * 1.2
		if _, err := client.Call(ctx, "Input.dispatchMouseEvent", map[string]any{
			"type": "mouseMoved", "x": startX + x, "y": startY + y, "button": "left", "buttons": 1,
		}); err != nil {
			return err
		}
		if err := sleepCtx(ctx, 18*time.Millisecond); err != nil {
			return err
		}
	}

	if err := sleepCtx(ctx, 160*time.Millisecond); err != nil {
		return err
	}
	_, err := client.Call(ctx, "Input.dispatchMouseEvent", map[string]any{
		"type": "mouseReleased", "x": startX + float64(distance), "y": startY,
		"button": "left", "buttons": 0, "clickCount": 1,
	})
	return err
}

// releasePointer clears a possibly-pressed left button and any self-built state.
func releasePointer(ctx context.Context, client *Client, x, y float64) {
	releaseCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	_, _ = client.Call(releaseCtx, "Input.dispatchMouseEvent", map[string]any{
		"type": "mouseReleased", "x": x, "y": y, "button": "left", "buttons": 0, "clickCount": 1,
	})
}

func pageValidationOf(probe ChallengeProbe, facts PageFacts, target string, verdict Verdict) PageValidation {
	original, _ := url.Parse(target)
	final, _ := url.Parse(facts.Href)
	validation := PageValidation{
		FinalURL:    facts.Href,
		Title:       facts.Title,
		Readable:    facts.Href != "",
		LoginWall:   verdict == VerdictLoginWall,
		Blocked:     verdict == VerdictBlocked,
		HostMatches: original != nil && final != nil && strings.EqualFold(original.Hostname(), final.Hostname()),
	}
	validation.ChallengeVisible = probe.Present
	for _, selector := range []*ChallengeBox{probe.Overlay, probe.SliderButton, probe.Track} {
		if selector != nil && selector.Selector != "" {
			validation.OverlaySelectors = appendUnique(validation.OverlaySelectors, selector.Selector)
		}
	}
	if !validation.HostMatches {
		validation.Reason = "最终 URL 已经不在原站点上：恢复不能把调用方带到别的站点"
	}
	return validation
}

func canvasMatching(canvases []ChallengeCanvas, needle string) *ChallengeCanvas {
	for i := range canvases {
		if strings.Contains(strings.ToLower(canvases[i].ClassName), needle) {
			return &canvases[i]
		}
	}
	return nil
}

func intrinsicLeft(png []byte) (int, error) {
	img, err := decodePNG(png)
	if err != nil {
		return 0, err
	}
	bounds := img.Bounds()
	for x := 0; x < bounds.Dx(); x++ {
		for y := 0; y < bounds.Dy(); y++ {
			if img.NRGBAAt(x, y).A > sliceAlphaThreshold {
				return x, nil
			}
		}
	}
	return 0, ErrNoGap
}

// decodeDataURL strips the `data:image/png;base64,` prefix.
func decodeDataURL(canvas *ChallengeCanvas) ([]byte, error) {
	if canvas == nil || canvas.PNG == "" {
		return nil, nil
	}
	comma := strings.Index(canvas.PNG, ",")
	if comma < 0 {
		return nil, errors.New("画布数据不是 data URL")
	}
	decoded, err := base64.StdEncoding.DecodeString(canvas.PNG[comma+1:])
	if err != nil {
		return nil, fmt.Errorf("解码画布图像失败：%w", err)
	}
	return decoded, nil
}

func sleepCtx(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return nil
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(d):
		return nil
	}
}

// waitWithin sleeps but never past the deadline.
func waitWithin(ctx context.Context, deadline time.Time, d time.Duration) error {
	remaining := time.Until(deadline)
	if remaining <= 0 {
		return errors.New("恢复窗口已用完")
	}
	if d > remaining {
		d = remaining
	}
	return sleepCtx(ctx, d)
}

func appendUnique(list []string, value string) []string {
	for _, item := range list {
		if item == value {
			return list
		}
	}
	return append(list, value)
}

func clampInt(value, low, high, fallback int) int {
	if value == 0 {
		return fallback
	}
	if value < low {
		return low
	}
	if value > high {
		return high
	}
	return value
}

func clampDuration(value, low, high, fallback time.Duration) time.Duration {
	if value == 0 {
		return fallback
	}
	if value < low {
		return low
	}
	if value > high {
		return high
	}
	return value
}
