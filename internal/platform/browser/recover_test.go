package browser

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// This file covers "detect a visible challenge, then try the fixed script" without a
// real site. The properties under test are the ones that decide whether an employee
// is sent to fight a widget that is not on screen, or is told "the site had nothing"
// when it actually refused us:
//
//   - hidden captcha markup must NOT trigger a recovery attempt;
//   - a visible canvas challenge must trigger the fixed script;
//   - the script's own success signal must NOT be the verdict (the page is re-read);
//   - a real sign-out is a login problem, not a slider problem;
//   - the attempt budget cannot be widened by the caller;
//   - a cancelled call still clears the pressed mouse button.

// recoverFake is a fake CDP endpoint that answers the probe, the page facts, and
// swallows everything else.
type recoverFake struct {
	rec        *recorder
	probes     []string
	facts      []string
	probeCalls int
	factsCalls int
	exception  string
}

func (f *recoverFake) handle(conn *websocket.Conn, request map[string]any) {
	f.rec.note(request)
	method, _ := request["method"].(string)
	params, _ := request["params"].(map[string]any)
	expression, _ := params["expression"].(string)
	reply := func(result map[string]any) {
		_ = conn.WriteJSON(map[string]any{"id": request["id"], "result": result})
	}
	switch {
	case method == "Runtime.evaluate" && strings.Contains(expression, "geetest_slider_button"):
		if f.exception != "" {
			reply(map[string]any{"exceptionDetails": map[string]any{"text": f.exception}})
			return
		}
		payload := f.probes[min(f.probeCalls, len(f.probes)-1)]
		f.probeCalls++
		reply(map[string]any{"result": map[string]any{"type": "string", "value": payload}})
	case method == "Runtime.evaluate" && strings.Contains(expression, "location.href"):
		payload := f.facts[min(f.factsCalls, len(f.facts)-1)]
		f.factsCalls++
		reply(map[string]any{"result": map[string]any{"type": "string", "value": payload}})
	case method == "Runtime.evaluate":
		reply(map[string]any{"result": map[string]any{"type": "number", "value": 200}})
	default:
		reply(map[string]any{})
	}
}

func recoverBrowser(t *testing.T, fake *recoverFake) *Browser {
	t.Helper()
	url := fakeCDP(t, fake.handle)
	client, err := Dial(context.Background(), url)
	if err != nil {
		t.Fatalf("Dial() error = %v, want nil", err)
	}
	t.Cleanup(func() { _ = client.Close() })
	return &Browser{Client: client}
}

const recoverTarget = "https://bj.lianjia.com/ershoufang/101139646125.html"

func factsJSON(t *testing.T, href, title, text string) string {
	t.Helper()
	raw, err := json.Marshal(PageFacts{Href: href, Title: title, Text: text})
	if err != nil {
		t.Fatalf("marshal facts: %v", err)
	}
	return string(raw)
}

func marshalProbe(t *testing.T, probe ChallengeProbe) string {
	t.Helper()
	raw, err := json.Marshal(probe)
	if err != nil {
		t.Fatalf("marshal probe: %v", err)
	}
	return string(raw)
}

// canvasProbe builds a visible Geetest v3 canvas challenge with real PNG payloads.
func canvasProbe(t *testing.T, top, left int) ChallengeProbe {
	t.Helper()
	full, gap, slice := notchFixture(t, 260, 120, 140, 20, 30, 40)
	probe := ChallengeProbe{Present: true, Family: "geetest-v3-canvas", Href: recoverTarget, Title: "二手房"}
	probe.SliderButton = &ChallengeBox{Selector: ".geetest_slider_button", Box: [4]int{left + 200, top, 40, 40}, Hit: true}
	probe.Track = &ChallengeBox{Selector: ".geetest_slider", Box: [4]int{left + 100, top, 200, 40}, Hit: true}
	probe.Overlay = &ChallengeBox{Selector: ".geetest_panel", Box: [4]int{left, top, 300, 200}, Hit: true}
	probe.BodyHas.Slider = true
	probe.Canvases = []ChallengeCanvas{
		canvas("geetest_canvas_fullbg", [4]int{left, top, 260, 120}, 260, 120, full),
		canvas("geetest_canvas_bg", [4]int{left, top, 260, 120}, 260, 120, gap),
		canvas("geetest_canvas_slice", [4]int{left, top, 260, 120}, 260, 120, slice),
	}
	return probe
}

func canvas(className string, box [4]int, w, h int, png []byte) ChallengeCanvas {
	item := ChallengeCanvas{Selector: "canvas", ClassName: className, Box: box}
	item.Intrinsic.W = w
	item.Intrinsic.H = h
	item.PNG = "data:image/png;base64," + base64.StdEncoding.EncodeToString(png)
	return item
}

func TestRecoverTreatsAPlainPageAsAlreadyRecoveredWithoutDragging(t *testing.T) {
	fake := &recoverFake{
		rec:    &recorder{},
		probes: []string{marshalProbe(t, ChallengeProbe{Present: false, Href: recoverTarget, Title: "二手房"})},
		facts:  []string{factsJSON(t, recoverTarget, "二手房", "在售 3室2厅 1100万")},
	}
	outcome, err := Recover(context.Background(), recoverBrowser(t, fake), RecoveryRequest{
		URL: recoverTarget, ProviderID: "lianjia", RetrievalTaskID: "task-1", settle: testSettle,
	})
	if err != nil {
		t.Fatalf("Recover() error = %v, want nil", err)
	}
	if outcome.State != RecoveryRecovered || outcome.ReasonCode != "no-visible-challenge" {
		t.Fatalf("outcome = %s/%s, want recovered/no-visible-challenge", outcome.State, outcome.ReasonCode)
	}
	if dragged(fake.rec) {
		t.Fatal("recover dragged the slider on a page with no visible challenge")
	}
	if !outcome.PageValidation.HostMatches || outcome.PageValidation.ChallengeVisible {
		t.Fatalf("pageValidation = %+v, want host match and no visible challenge", outcome.PageValidation)
	}
}

func TestRecoverIgnoresHiddenCaptchaMarkup(t *testing.T) {
	// The archived false positive (event 414–415): the business page is readable but
	// the HTML still carries captcha wording. Nothing visible means nothing to solve.
	fake := &recoverFake{
		rec:    &recorder{},
		probes: []string{marshalProbe(t, ChallengeProbe{Present: false, Href: recoverTarget, Title: "二手房"})},
		facts:  []string{factsJSON(t, recoverTarget, "二手房", "人机验证 在售 3室2厅 1100万")},
	}
	outcome, err := Recover(context.Background(), recoverBrowser(t, fake), RecoveryRequest{URL: recoverTarget, settle: testSettle})
	if err != nil {
		t.Fatalf("Recover() error = %v, want nil", err)
	}
	if outcome.State != RecoveryRecovered {
		t.Fatalf("state = %s, want recovered: hidden captcha wording is not a visible challenge", outcome.State)
	}
	if dragged(fake.rec) {
		t.Fatal("recover dragged the slider because the page text mentioned a captcha")
	}
}

func TestRecoverSolvesAVisibleCanvasChallengeAndReadsThePageBack(t *testing.T) {
	fake := &recoverFake{
		rec: &recorder{},
		probes: []string{
			marshalProbe(t, canvasProbe(t, 200, 100)),
			marshalProbe(t, ChallengeProbe{Present: false, Href: recoverTarget, Title: "二手房"}),
		},
		facts: []string{factsJSON(t, recoverTarget, "二手房", "在售 3室2厅 1100万")},
	}
	outcome, err := Recover(context.Background(), recoverBrowser(t, fake), RecoveryRequest{
		URL: recoverTarget, ProviderID: "lianjia", RetrievalTaskID: "task-9", settle: testSettle,
	})
	if err != nil {
		t.Fatalf("Recover() error = %v, want nil", err)
	}
	if outcome.State != RecoveryRecovered {
		t.Fatalf("state = %s (%s), want recovered", outcome.State, outcome.ReasonCode)
	}
	if outcome.BeforeKind != ChallengeGeetestV3Canvas {
		t.Fatalf("beforeKind = %s, want geetest-v3-canvas", outcome.BeforeKind)
	}
	if !dragged(fake.rec) {
		t.Fatal("recover reported success without ever touching the slider")
	}
	if !hasCall(t, fake.rec, "mousePressed") || !hasCall(t, fake.rec, "mouseReleased") {
		t.Fatal("recover did not replay a full press/drag/release cycle")
	}
	if got := lastMouseReleaseButtons(t, fake.rec); got != float64(0) {
		t.Fatalf("final mouseReleased buttons = %v, want 0 (pointer state must be cleared)", got)
	}
	if len(outcome.Strategies) == 0 || outcome.Strategies[0] != string(StrategyGeetestV3Canvas) {
		t.Fatalf("strategies = %v, want the canvas strategy recorded", outcome.Strategies)
	}
}

func TestRecoverDoesNotTrustTheScriptWhenTheChallengeIsStillVisible(t *testing.T) {
	// The archived solver could exit 0 while still on the challenge page. The verdict
	// is the page, read back after the drag.
	fake := &recoverFake{
		rec:    &recorder{},
		probes: []string{marshalProbe(t, canvasProbe(t, 200, 100))},
		facts:  []string{factsJSON(t, recoverTarget, "二手房", "在售 3室2厅 1100万")},
	}
	outcome, err := Recover(context.Background(), recoverBrowser(t, fake), RecoveryRequest{URL: recoverTarget, settle: testSettle})
	if err != nil {
		t.Fatalf("Recover() error = %v, want nil", err)
	}
	if outcome.State != RecoveryWaitingUser {
		t.Fatalf("state = %s, want waiting-user: the challenge was still on screen", outcome.State)
	}
	if outcome.Attempts != RecoveryMaxAttempts {
		t.Fatalf("attempts = %d, want %d", outcome.Attempts, RecoveryMaxAttempts)
	}
	if !dragged(fake.rec) {
		t.Fatal("no drag was attempted at all")
	}
}

func TestRecoverClampsTheAttemptBudgetFromTheCaller(t *testing.T) {
	fake := &recoverFake{
		rec:    &recorder{},
		probes: []string{marshalProbe(t, canvasProbe(t, 200, 100))},
		facts:  []string{factsJSON(t, recoverTarget, "二手房", "在售 3室2厅 1100万")},
	}
	outcome, err := Recover(context.Background(), recoverBrowser(t, fake), RecoveryRequest{
		URL: recoverTarget, MaxAttempts: 99, settle: testSettle,
	})
	if err != nil {
		t.Fatalf("Recover() error = %v, want nil", err)
	}
	if outcome.Attempts > RecoveryMaxAttempts {
		t.Fatalf("attempts = %d, want at most %d: the caller cannot widen the budget",
			outcome.Attempts, RecoveryMaxAttempts)
	}
}

func TestRecoverReportsAnUnsupportedChallengeFamily(t *testing.T) {
	probe := ChallengeProbe{Present: true, Family: "geetest-v3-dom", Href: recoverTarget, Title: "x"}
	probe.SliderButton = &ChallengeBox{Selector: ".geetest_slider_button", Box: [4]int{100, 200, 40, 40}, Hit: true}
	fake := &recoverFake{
		rec:    &recorder{},
		probes: []string{marshalProbe(t, probe)},
		facts:  []string{factsJSON(t, recoverTarget, "二手房", "拖动滑块")},
	}
	outcome, err := Recover(context.Background(), recoverBrowser(t, fake), RecoveryRequest{URL: recoverTarget, settle: testSettle})
	if err != nil {
		t.Fatalf("Recover() error = %v, want nil", err)
	}
	if outcome.State != RecoveryUnsupported || outcome.ReasonCode != "challenge-family-unsupported" {
		t.Fatalf("outcome = %s/%s, want unsupported/challenge-family-unsupported", outcome.State, outcome.ReasonCode)
	}
	if dragged(fake.rec) {
		t.Fatal("an unadapted challenge family must not be dragged at")
	}
}

func TestRecoverAsksForSignInInsteadOfSolvingASlider(t *testing.T) {
	fake := &recoverFake{
		rec:    &recorder{},
		probes: []string{marshalProbe(t, ChallengeProbe{Present: false, Href: "https://clogin.lianjia.com/login", Title: "登录"})},
		facts:  []string{factsJSON(t, "https://clogin.lianjia.com/login", "登录", "用户登录 手机快捷登录")},
	}
	outcome, err := Recover(context.Background(), recoverBrowser(t, fake), RecoveryRequest{URL: recoverTarget, settle: testSettle})
	if err != nil {
		t.Fatalf("Recover() error = %v, want nil", err)
	}
	if outcome.State != RecoveryWaitingUser || outcome.ReasonCode != "login-required" {
		t.Fatalf("outcome = %s/%s, want waiting-user/login-required", outcome.State, outcome.ReasonCode)
	}
	if dragged(fake.rec) {
		t.Fatal("a sign-out must not be answered with a slider drag")
	}
}

func TestRecoverRejectsATaintedCanvas(t *testing.T) {
	probe := canvasProbe(t, 200, 100)
	probe.Tainted = true
	fake := &recoverFake{
		rec:    &recorder{},
		probes: []string{marshalProbe(t, probe)},
		facts:  []string{factsJSON(t, recoverTarget, "二手房", "拖动滑块")},
	}
	outcome, err := Recover(context.Background(), recoverBrowser(t, fake), RecoveryRequest{URL: recoverTarget, settle: testSettle})
	if err != nil {
		t.Fatalf("Recover() error = %v, want nil", err)
	}
	if outcome.State != RecoveryUnsupported {
		t.Fatalf("state = %s, want unsupported for a tainted canvas", outcome.State)
	}
	if dragged(fake.rec) {
		t.Fatal("a tainted canvas has no readable pixels; nothing may be dragged")
	}
}

func TestRecoverRefusesAnOutOfRangeControlOrigin(t *testing.T) {
	probe := canvasProbe(t, 200, 100)
	probe.SliderButton = &ChallengeBox{Selector: ".geetest_slider_button", Box: [4]int{-200, -100, 40, 40}, Hit: false}
	fake := &recoverFake{
		rec:    &recorder{},
		probes: []string{marshalProbe(t, probe)},
		facts:  []string{factsJSON(t, recoverTarget, "二手房", "拖动滑块")},
	}
	outcome, err := Recover(context.Background(), recoverBrowser(t, fake), RecoveryRequest{URL: recoverTarget, settle: testSettle})
	if err != nil {
		t.Fatalf("Recover() error = %v, want nil", err)
	}
	if outcome.State != RecoveryUnsupported {
		t.Fatalf("state = %s, want unsupported: a negative origin is not a replayable drag", outcome.State)
	}
	if dragged(fake.rec) {
		t.Fatal("no drag may be replayed for an out-of-range control")
	}
}

func TestRecoverClearsThePointerWhenCancelled(t *testing.T) {
	fake := &recoverFake{
		rec:    &recorder{},
		probes: []string{marshalProbe(t, ChallengeProbe{Present: false, Href: recoverTarget, Title: "二手房"})},
		facts:  []string{factsJSON(t, recoverTarget, "二手房", "在售")},
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	outcome, err := Recover(ctx, recoverBrowser(t, fake), RecoveryRequest{URL: recoverTarget, settle: testSettle})
	if err != nil {
		t.Fatalf("Recover() error = %v, want nil", err)
	}
	if outcome.State != RecoveryCancelled {
		t.Fatalf("state = %s, want cancelled", outcome.State)
	}
	if !hasCall(t, fake.rec, "mouseReleased") {
		t.Fatal("a cancelled recovery left the mouse button pressed")
	}
}

func TestRecoverReportsCooldownBeyondTheWindowWithoutWaiting(t *testing.T) {
	fake := &recoverFake{
		rec:    &recorder{},
		probes: []string{marshalProbe(t, canvasProbe(t, 200, 100))},
		facts:  []string{factsJSON(t, recoverTarget, "二手房", "拖动滑块")},
	}
	started := time.Now()
	outcome, err := Recover(context.Background(), recoverBrowser(t, fake), RecoveryRequest{
		URL: recoverTarget, Strategy: StrategyCooldownRenavigate, settle: testSettle,
		Window: 2 * time.Second, Cooldown: 90 * time.Second,
	})
	elapsed := time.Since(started)
	if err != nil {
		t.Fatalf("Recover() error = %v, want nil", err)
	}
	if outcome.State != RecoveryWaitingUser || outcome.ReasonCode != "cooldown-exceeds-window" {
		t.Fatalf("outcome = %s/%s, want waiting-user/cooldown-exceeds-window", outcome.State, outcome.ReasonCode)
	}
	if outcome.NextEligibleAt == "" {
		t.Fatal("a cooldown that does not fit must record when the next attempt is allowed")
	}
	if elapsed > 3*time.Second {
		t.Fatalf("elapsed = %v, want no long sleep: the cooldown must not be truncated into a burst", elapsed)
	}
}

func TestRecoverSurfacesProbeInfrastructureFailure(t *testing.T) {
	fake := &recoverFake{
		rec:       &recorder{},
		probes:    []string{"{}"},
		facts:     []string{factsJSON(t, recoverTarget, "二手房", "在售")},
		exception: "SyntaxError: unexpected token",
	}
	outcome, err := Recover(context.Background(), recoverBrowser(t, fake), RecoveryRequest{URL: recoverTarget, settle: testSettle})
	if err != nil {
		t.Fatalf("Recover() error = %v, want nil", err)
	}
	if outcome.State != RecoveryUnavailable || outcome.ReasonCode != "probe-unavailable" {
		t.Fatalf("outcome = %s/%s, want unavailable/probe-unavailable", outcome.State, outcome.ReasonCode)
	}
	// Infrastructure failure is not a challenge: the caller must be able to tell them
	// apart, so the reason names the probe rather than the site.
	if !strings.Contains(outcome.PageValidation.Reason, "无法读取页面挑战状态") {
		t.Fatalf("reason = %q, want it to name the probe as the failure", outcome.PageValidation.Reason)
	}
}

func TestParseRecoveryStrategyRejectsUnknownValues(t *testing.T) {
	if _, err := ParseRecoveryStrategy(""); err != nil {
		t.Fatalf("ParseRecoveryStrategy(\"\") error = %v, want the auto default", err)
	}
	if _, err := ParseRecoveryStrategy("geetest-v3-canvas"); err != nil {
		t.Fatalf("ParseRecoveryStrategy(canvas) error = %v, want nil", err)
	}
	if _, err := ParseRecoveryStrategy("--eval"); err == nil {
		t.Fatal("ParseRecoveryStrategy(--eval) error = nil, want a rejection")
	}
}

func TestRecoverRefusesNonPublicTargets(t *testing.T) {
	fake := &recoverFake{rec: &recorder{}, probes: []string{"{}"}, facts: []string{"{}"}}
	for _, target := range []string{"file:///etc/passwd", "http://127.0.0.1:9444/x", "http://localhost/x"} {
		if _, err := Recover(context.Background(), recoverBrowser(t, fake), RecoveryRequest{URL: target}); err == nil {
			t.Fatalf("Recover(%s) error = nil, want a rejection", target)
		}
	}
}

// testSettle keeps the re-read wait at milliseconds. Production uses the measured
// default; what is under test here is the decision, not the delay.
const testSettle = 5 * time.Millisecond

// dragged reports whether a pointer drag was actually replayed. Every recovery clears
// a possibly-stuck button first, so the presence of a release event proves nothing.
func dragged(rec *recorder) bool {
	for i, method := range rec.calls {
		if method == "Input.dispatchMouseEvent" && rec.seen[i]["type"] == "mousePressed" {
			return true
		}
	}
	return false
}

func hasCall(t *testing.T, rec *recorder, eventType string) bool {
	t.Helper()
	for _, params := range rec.seen {
		if params["type"] == eventType {
			return true
		}
	}
	return false
}

func lastMouseReleaseButtons(t *testing.T, rec *recorder) any {
	t.Helper()
	for i := len(rec.calls) - 1; i >= 0; i-- {
		if rec.calls[i] != "Input.dispatchMouseEvent" {
			continue
		}
		if rec.seen[i]["type"] == "mouseReleased" {
			return rec.seen[i]["buttons"]
		}
	}
	return nil
}

func TestChallengeFamilyOfSeparatesVisibleChallengesFromWording(t *testing.T) {
	cases := []struct {
		name    string
		probe   ChallengeProbe
		verdict Verdict
		want    ChallengeFamily
	}{
		{"visible canvas", ChallengeProbe{Present: true, Family: "geetest-v3-canvas"}, VerdictOK, ChallengeGeetestV3Canvas},
		{"visible unknown widget", ChallengeProbe{Present: true, Family: "geetest-v3-dom"}, VerdictOK, ChallengeGeetestV3DOM},
		{"captcha wording, nothing on screen", ChallengeProbe{Present: false}, VerdictCaptcha, ChallengeNone},
		{"login wall wins over slider wording", ChallengeProbe{Present: true, Family: "geetest-v3-canvas"}, VerdictLoginWall, ChallengeGeetestV3Canvas},
		{"sign-out without any widget", ChallengeProbe{Present: false}, VerdictLoginWall, ChallengeLoginWall},
		{"site blocked", ChallengeProbe{Present: false}, VerdictBlocked, ChallengeBlocked},
		{"normal page", ChallengeProbe{Present: false}, VerdictOK, ChallengeNone},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			if got := ChallengeFamilyOf(item.probe, item.verdict); got != item.want {
				t.Fatalf("ChallengeFamilyOf = %s, want %s", got, item.want)
			}
		})
	}
}

func TestRecoverHonoursAnExplicitZeroCooldown(t *testing.T) {
	// The Host coordinator owns the cooldown schedule and must be able to say
	// "do not wait in this process". Without the explicit marker, cooldown-renavigate
	// would impose its own default wait while holding the profile.
	fake := &recoverFake{
		rec:    &recorder{},
		probes: []string{marshalProbe(t, canvasProbe(t, 200, 100))},
		facts:  []string{factsJSON(t, recoverTarget, "二手房", "拖动滑块")},
	}
	request := RecoveryRequest{
		URL: recoverTarget, Strategy: StrategyCooldownRenavigate,
		Window: 2 * time.Second, Cooldown: 0, settle: testSettle,
	}
	request.SetCooldownExplicit(true)
	started := time.Now()
	outcome, err := Recover(context.Background(), recoverBrowser(t, fake), request)
	elapsed := time.Since(started)
	if err != nil {
		t.Fatalf("Recover() error = %v, want nil", err)
	}
	// 不等待时两次尝试会连着跑完（中间只有 settle），所以终结原因是预算用尽而不是冷却。
	if outcome.State != RecoveryWaitingUser {
		t.Fatalf("outcome = %s/%s, want waiting-user", outcome.State, outcome.ReasonCode)
	}
	if outcome.ReasonCode != "budget-exhausted" && outcome.ReasonCode != "cooldown-exceeds-window" {
		t.Fatalf("reasonCode = %q, want a budget/window reason", outcome.ReasonCode)
	}
	if elapsed > 3*time.Second {
		t.Fatalf("elapsed = %v, want no wait when the caller owns the cooldown", elapsed)
	}
}

// TestRecoverReentersTheOriginalURLBeforeProbing pins the first step of the
// designed flow: "回到原 URL". Without it, `recover` reads whatever page the
// attached target happens to show — observed on a real machine (2026-10-14) as
// Edge's new-tab page (`ntp.msn.cn`), because target discovery returns the first
// page target and the command never navigated it.
func TestRecoverReentersTheOriginalURLBeforeProbing(t *testing.T) {
	fake := &recoverFake{
		rec:    &recorder{},
		probes: []string{marshalProbe(t, ChallengeProbe{Present: false, Href: recoverTarget, Title: "二手房"})},
		facts:  []string{factsJSON(t, recoverTarget, "二手房", "在售 3室2厅 1100万")},
	}
	outcome, err := Recover(context.Background(), recoverBrowser(t, fake), RecoveryRequest{
		URL: recoverTarget, ProviderID: "lianjia", RetrievalTaskID: "task-1", settle: testSettle,
	})
	if err != nil {
		t.Fatalf("Recover() error = %v, want nil", err)
	}
	params := fake.rec.lastParamsFor("Page.navigate")
	if fake.rec.count("Page.navigate") == 0 || params["url"] != recoverTarget {
		t.Fatalf("recover did not navigate to the original URL (%s): last navigate params = %v", recoverTarget, params)
	}
	if outcome.State != RecoveryRecovered {
		t.Fatalf("state = %s, want recovered once the original page is back and readable", outcome.State)
	}
}

// TestRecoverNeverReportsRecoveredFromAnotherHost is the false success observed on
// a real machine: the attached target was Edge's new-tab page, the probe found no
// challenge, and the command answered `recovered` while the page validation said
// "最终 URL 已经不在原站点上". "No challenge on some other page" is not recovery.
func TestRecoverNeverReportsRecoveredFromAnotherHost(t *testing.T) {
	offSite := "https://ntp.msn.cn/edge/ntp?locale=zh-Hans-CN"
	fake := &recoverFake{
		rec:    &recorder{},
		probes: []string{marshalProbe(t, ChallengeProbe{Present: false, Href: offSite, Title: ""})},
		facts:  []string{factsJSON(t, offSite, "", "")},
	}
	outcome, err := Recover(context.Background(), recoverBrowser(t, fake), RecoveryRequest{
		URL: recoverTarget, ProviderID: "lianjia", RetrievalTaskID: "task-1", settle: testSettle,
		MaxAttempts: 1,
	})
	if err != nil {
		t.Fatalf("Recover() error = %v, want nil", err)
	}
	if outcome.State == RecoveryRecovered {
		t.Fatalf("state = recovered with final URL %s: a page off the original host is never proof of recovery",
			outcome.PageValidation.FinalURL)
	}
	if outcome.PageValidation.HostMatches {
		t.Fatal("pageValidation.HostMatches = true for an off-host page")
	}
	if !strings.Contains(outcome.PageValidation.Reason, "不在原站点") {
		t.Fatalf("reason = %q, want it to name the off-host page", outcome.PageValidation.Reason)
	}
}

// TestRecoverTreatsARedirectToAChallengeHostAsWaitingForTheHuman covers the live shape
// (2026-10-15): the original page redirects to the site's challenge host
// (`bj.lianjia.com/...` → `hip.lianjia.com/captcha`, title `CAPTCHA`), where the widget
// is not one of the families this package can drive. That page is the site asking for a
// person: the honest answer is `waiting-user` plus the observed URL — never `recovered`,
// and never a dead-end `unsupported`.
func TestRecoverTreatsARedirectToAChallengeHostAsWaitingForTheHuman(t *testing.T) {
	challengePage := "https://hip.lianjia.com/captcha?location=https%3A%2F%2Fbj.lianjia.com%2Fershoufang%2F"
	fake := &recoverFake{
		rec: &recorder{},
		probes: []string{marshalProbe(t, ChallengeProbe{
			Present: false, Href: challengePage, Title: "CAPTCHA",
		})},
		facts: []string{factsJSON(t, challengePage, "CAPTCHA", "人机验证 加载中，请稍后... 重新验证")},
	}
	outcome, err := Recover(context.Background(), recoverBrowser(t, fake), RecoveryRequest{
		URL: recoverTarget, ProviderID: "lianjia", RetrievalTaskID: "gate:lianjia", settle: testSettle, MaxAttempts: 1,
	})
	if err != nil {
		t.Fatalf("Recover() error = %v, want nil", err)
	}
	if outcome.State != RecoveryWaitingUser {
		t.Fatalf("state = %s/%s, want waiting-user: this page waits for a person, it is not unsolvable",
			outcome.State, outcome.ReasonCode)
	}
	if outcome.ReasonCode != ReasonChallengePageWaitingUser {
		t.Fatalf("reasonCode = %q, want %q", outcome.ReasonCode, ReasonChallengePageWaitingUser)
	}
	if outcome.BeforeKind != ChallengeSiteChallengePage {
		t.Fatalf("beforeKind = %s, want %s", outcome.BeforeKind, ChallengeSiteChallengePage)
	}
	if !strings.Contains(outcome.PageValidation.Reason, "hip.lianjia.com") {
		t.Fatalf("reason = %q, want it to name the challenge host", outcome.PageValidation.Reason)
	}
	if dragged(fake.rec) {
		t.Fatal("no drag may be replayed when the challenge is not visible")
	}
	if len(outcome.Strategies) != 0 {
		t.Fatalf("strategies = %v, want none: the v3 script must not be applied to this family", outcome.Strategies)
	}
}

// TestRecoverRefusesToCallAChallengePageRecovered is the same check without a host
// change: a site may answer the protected URL with its own challenge route on the very
// same host (`bj.lianjia.com/ershoufang/` → `bj.lianjia.com/captcha`). Matching hosts
// used to be enough to report `recovered`, which is a false success — the URL is the
// site's verification page, not the page we asked for.
func TestRecoverRefusesToCallAChallengePageRecovered(t *testing.T) {
	challengePage := "https://bj.lianjia.com/captcha?from=ershoufang"
	fake := &recoverFake{
		rec:    &recorder{},
		probes: []string{marshalProbe(t, ChallengeProbe{Present: false, Href: challengePage, Title: "CAPTCHA"})},
		facts:  []string{factsJSON(t, challengePage, "CAPTCHA", "请完成下列验证")},
	}
	outcome, err := Recover(context.Background(), recoverBrowser(t, fake), RecoveryRequest{
		URL: recoverTarget, ProviderID: "lianjia", RetrievalTaskID: "task-h", settle: testSettle, MaxAttempts: 1,
	})
	if err != nil {
		t.Fatalf("Recover() error = %v, want nil", err)
	}
	if outcome.State == RecoveryRecovered {
		t.Fatalf("state = recovered on %s: the same host is not the same page", outcome.PageValidation.FinalURL)
	}
	if outcome.State != RecoveryWaitingUser || outcome.ReasonCode != ReasonChallengePageWaitingUser {
		t.Fatalf("outcome = %s/%s, want waiting-user/%s",
			outcome.State, outcome.ReasonCode, ReasonChallengePageWaitingUser)
	}
	if !outcome.PageValidation.HostMatches {
		t.Fatal("HostMatches = false, want true: this case exists to prove the host check alone is not enough")
	}
}

// TestRecoverVerifiesThePageAfterTheBudgetIsSpent pins the second read-back path. When
// the automatic budget runs out, the last thing read used to decide "recovered" from
// `no visible challenge` alone — so a challenge page reached by that read, or a page
// off the original host, was recorded as a recovery.
func TestRecoverVerifiesThePageAfterTheBudgetIsSpent(t *testing.T) {
	good := factsJSON(t, recoverTarget, "二手房", "在售 3室2厅 1100万")
	cases := []struct {
		name         string
		finalFacts   string
		finalProbe   ChallengeProbe
		wantReasonIn string
	}{
		{
			name:       "the final read lands on the site's challenge page",
			finalFacts: factsJSON(t, "https://bj.lianjia.com/captcha?from=ershoufang", "CAPTCHA", "请完成下列验证"),
			finalProbe: ChallengeProbe{Present: false, Href: "https://bj.lianjia.com/captcha?from=ershoufang", Title: "CAPTCHA"},
			// HostMatches is true here: the host check alone is what used to pass.
			wantReasonIn: "人机验证页",
		},
		{
			name:         "the final read lands off the original host",
			finalFacts:   factsJSON(t, "https://ntp.msn.cn/edge/ntp?locale=zh-Hans-CN", "", ""),
			finalProbe:   ChallengeProbe{Present: false, Href: "https://ntp.msn.cn/edge/ntp?locale=zh-Hans-CN"},
			wantReasonIn: "自动恢复未通过",
		},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			fake := &recoverFake{
				rec:    &recorder{},
				probes: []string{marshalProbe(t, canvasProbe(t, 200, 100)), marshalProbe(t, item.finalProbe)},
				// One attempt: the drag's page facts, then the post-budget read.
				facts: []string{good, good, item.finalFacts},
			}
			outcome, err := Recover(context.Background(), recoverBrowser(t, fake), RecoveryRequest{
				URL: recoverTarget, ProviderID: "lianjia", RetrievalTaskID: "task-i",
				MaxAttempts: 1, settle: testSettle,
			})
			if err != nil {
				t.Fatalf("Recover() error = %v, want nil", err)
			}
			if outcome.State == RecoveryRecovered {
				t.Fatalf("state = recovered after the budget with final URL %s: an unverified read is not a recovery",
					outcome.PageValidation.FinalURL)
			}
			if outcome.State != RecoveryWaitingUser {
				t.Fatalf("state = %s/%s, want waiting-user", outcome.State, outcome.ReasonCode)
			}
			if !strings.Contains(outcome.PageValidation.Reason, item.wantReasonIn) {
				t.Fatalf("reason = %q, want it to mention %q", outcome.PageValidation.Reason, item.wantReasonIn)
			}
		})
	}
}

func TestIsChallengePageReadsStructureNotProse(t *testing.T) {
	cases := []struct {
		name     string
		finalURL string
		title    string
		want     bool
	}{
		{"live redirect target", "https://hip.lianjia.com/captcha?location=x", "CAPTCHA", true},
		{"same-host challenge route", "https://bj.lianjia.com/captcha", "CAPTCHA", true},
		{"challenge document suffix", "https://verify.lianjia.com/verify.html", "安全校验", true},
		{"challenge route segment", "https://www.lianjia.com/challenge/abc", "", true},
		{"business page with captcha wording", recoverTarget, "二手房", false},
		{"attached new-tab page", "https://ntp.msn.cn/edge/ntp?locale=zh-Hans-CN", "", false},
		{"login page is not a challenge page", "https://clogin.lianjia.com/login", "登录", false},
		{"unparseable URL", ":::", "", false},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			if got := IsChallengePage(item.finalURL, item.title); got != item.want {
				t.Fatalf("IsChallengePage(%q, %q) = %v, want %v", item.finalURL, item.title, got, item.want)
			}
		})
	}
}

// TestChallengeFamilyOfPageKeepsTheLoginWallOnTop guards the ordering: the login host is
// reached by a redirect too, and answering it with "wait for the human on the challenge
// page" would send the employee to clear a puzzle instead of signing in.
func TestChallengeFamilyOfPageKeepsTheLoginWallOnTop(t *testing.T) {
	login := PageFacts{Href: "https://clogin.lianjia.com/login?service=x", Title: "登录"}
	if got := ChallengeFamilyOfPage(ChallengeProbe{}, login, VerdictLoginWall, recoverTarget); got != ChallengeLoginWall {
		t.Fatalf("ChallengeFamilyOfPage = %s, want %s", got, ChallengeLoginWall)
	}
	visible := ChallengeProbe{Present: true, Family: "geetest-v3-canvas"}
	if got := ChallengeFamilyOfPage(visible, PageFacts{Href: "https://hip.lianjia.com/captcha"}, VerdictCaptcha, recoverTarget); got != ChallengeGeetestV3Canvas {
		t.Fatalf("ChallengeFamilyOfPage = %s, want the visible widget to win", got)
	}
	none := PageFacts{Href: recoverTarget, Title: "二手房"}
	if got := ChallengeFamilyOfPage(ChallengeProbe{}, none, VerdictOK, recoverTarget); got != ChallengeNone {
		t.Fatalf("ChallengeFamilyOfPage = %s, want %s for a normal business page", got, ChallengeNone)
	}
}
