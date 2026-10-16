package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/mmungdong/crwu-ai/internal/platform/browser"
)

// browserAcquirer is how a command obtains a browser session. It is a function
// type rather than a direct call so tests can run the commands without launching a
// real browser window. The options carry the one launch decision that is not a
// target: headless for a credential-only read.
type browserAcquirer func(ctx context.Context, exe, profileDir string, urls []string, opts browser.AcquireOptions) (*browser.Browser, error)

// browserAcquireOverride is the test seam. Production leaves it nil.
var browserAcquireOverride browserAcquirer

func acquireBrowser() browserAcquirer {
	if browserAcquireOverride != nil {
		return browserAcquireOverride
	}
	return browser.AcquireWithOptions
}

// browserFocusOverride is the focus seam. Production leaves it nil and calls
// Browser.FocusControlled, which raises only the owned window.
var browserFocusOverride func(ctx context.Context, session *browser.Browser) error

// focusOwnedWindow raises only the owned target this session used. It is reserved
// for an explicit employee action (login / open) and for a manual challenge; a
// normal page never brings anything forward.
func focusOwnedWindow(ctx context.Context, session *browser.Browser) error {
	if browserFocusOverride != nil {
		return browserFocusOverride(ctx, session)
	}
	return session.FocusControlled(ctx)
}

// browserFlags are the flags shared by every browser subcommand.
type browserFlags struct {
	sitesPath  string
	profileDir string
	siteIDs    []string
}

type browserSiteState struct {
	ID       string `json:"id"`
	Label    string `json:"label"`
	LoginURL string `json:"loginUrl,omitempty"`
	State    string `json:"state"`
	Reason   string `json:"reason"`
	// Verdict is what the protected page turned out to be: ok / login-wall /
	// captcha / blocked. It is the **structural** answer to "why is this not
	// authenticated", so the plugin never has to pattern-match the reason text.
	// Empty means the page was never read (cookie missing, navigation failed).
	Verdict string `json:"verdict,omitempty"`
	// ProtectedURL is the page that was read for this site; it is what the
	// employee must open when a challenge has to be cleared by hand. Not a
	// credential: it is public site configuration.
	ProtectedURL string `json:"protectedUrl,omitempty"`
	// ExpiresAt is when the session credential expires (RFC3339). Empty for a
	// session cookie — see SessionCookie. It lets the panel say "登录有效到 …"
	// instead of a bare "已登录", and lets `unauthenticated` name the expiry.
	ExpiresAt string `json:"expiresAt,omitempty"`
	// SessionCookie marks a credential with no expiry of its own (valid until the
	// browser closes).
	SessionCookie bool `json:"sessionCookie,omitempty"`
}

type browserLoginResult struct {
	OK    bool               `json:"ok"`
	Sites []browserSiteState `json:"sites"`
}

type browserStatusResult struct {
	OK    bool               `json:"ok"`
	Sites []browserSiteState `json:"sites"`
}

type browserOpenResult struct {
	// SiteID is the resolved id when exactly one --site was given; empty when the
	// command opened every selected site.
	SiteID        string   `json:"siteId"`
	Opened        bool     `json:"opened"`
	ProtectedURLs []string `json:"protectedUrls"`
}

type browserProfileResult struct {
	ProfileDir string `json:"profileDir"`
	Exists     bool   `json:"exists"`
	// Permission is the directory mode. The profile holds live session cookies in
	// cleartext, so "is it 0700" is the one fact worth surfacing about it.
	Permission string `json:"permission"`
}

// emitEnvelope writes the documented success/failure envelope. Every browser
// command uses it: the manual promises `{"ok":...,"data":...}` for this CLI, and an
// agent written against that promise gets nothing from a flat object.
func emitEnvelope(cmd *cobra.Command, ok bool, data any) error {
	raw, err := json.Marshal(data)
	if err != nil {
		return fmt.Errorf("序列化输出失败：%w", err)
	}
	return writeJSON(cmd.OutOrStdout(), okEnvelope{OK: ok, Data: raw})
}

type browserActionJSON struct {
	OK          bool   `json:"ok"`
	FailureKind string `json:"failureKind"`
	Verdict     string `json:"verdict"`
	FinalURL    string `json:"finalUrl"`
	Title       string `json:"title"`
	File        string `json:"file"`
	Digest      string `json:"digest"`
	Bytes       int    `json:"bytes"`
	Status      int    `json:"status"`
	Error       string `json:"error"`
}

func newBrowserCommand(deps Dependencies, examples map[string][]schemeExample) *cobra.Command {
	flags := &browserFlags{}

	command := &cobra.Command{
		Use:   "browser",
		Short: "Drive a real browser to read rendered pages and capture screenshots",
		Long: "browser drives a real Chromium-family browser through the DevTools Protocol. " +
			"It knows nothing about any particular site: the sites it may open, and how to tell " +
			"whether a session is live, come from --sites. fetch and shot reuse one owned window " +
			"and leave it in the background by default (--background=false shows that same owned " +
			"window); login and open use the visible owned window because a person has to act in it.",
	}
	command.PersistentFlags().StringVar(&flags.sitesPath, "sites", "",
		"Path to a JSON file describing the sites (required by login and status)")
	command.PersistentFlags().StringVar(&flags.profileDir, "profile", "",
		"Browser profile directory (default: ~/.crwu/browser/profile)")

	command.AddCommand(newBrowserProfileCommand(deps, flags, examples))
	command.AddCommand(newBrowserLoginCommand(deps, flags, examples))
	command.AddCommand(newBrowserStatusCommand(deps, flags, examples))
	command.AddCommand(newBrowserFetchCommand(deps, flags, examples, false))
	command.AddCommand(newBrowserFetchCommand(deps, flags, examples, true))
	command.AddCommand(newBrowserRecoverCommand(deps, flags, examples))
	command.AddCommand(newBrowserOpenCommand(deps, flags, examples))
	return command
}

// withProfile resolves the profile directory, falling back to the shared default.
func (f *browserFlags) withProfile(deps Dependencies) (string, error) {
	if strings.TrimSpace(f.profileDir) != "" {
		return strings.TrimSpace(f.profileDir), nil
	}
	return browser.ProfileDir(deps.Getenv)
}

// selectedSites loads the site list and narrows it to --site values.
func (f *browserFlags) selectedSites() ([]browser.Site, error) {
	if strings.TrimSpace(f.sitesPath) == "" {
		return nil, errors.New("缺少 --sites：请给出站点清单 JSON 文件")
	}
	sites, err := browser.LoadSites(f.sitesPath)
	if err != nil {
		return nil, err
	}
	if len(f.siteIDs) == 0 {
		return sites, nil
	}
	selected := make([]browser.Site, 0, len(f.siteIDs))
	for _, id := range f.siteIDs {
		site, err := browser.FindSite(sites, id)
		if err != nil {
			return nil, err
		}
		selected = append(selected, site)
	}
	return selected, nil
}

func newBrowserProfileCommand(deps Dependencies, flags *browserFlags, examples map[string][]schemeExample) *cobra.Command {
	command := &cobra.Command{
		Use:     "profile",
		Short:   "Show where the browser profile lives",
		Example: "  crwu browser profile",
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			dir, err := flags.withProfile(deps)
			if err != nil {
				return err
			}
			info, statErr := os.Stat(dir)
			result := browserProfileResult{ProfileDir: dir}
			if statErr == nil && info.IsDir() {
				result.Exists = true
				result.Permission = fmt.Sprintf("%04o", info.Mode().Perm())
			}
			return emitEnvelope(cmd, true, result)
		},
	}
	addExamples(examples, "browser profile", "Show the shared browser profile location.", "crwu browser profile")
	return command
}

func newBrowserLoginCommand(deps Dependencies, flags *browserFlags, examples map[string][]schemeExample) *cobra.Command {
	var timeout time.Duration
	command := &cobra.Command{
		Use:   "login",
		Short: "Open the owned visible window and wait until every site is signed in",
		Example: "  crwu browser login --sites ~/.crwu/browser/sites.json\n" +
			"  crwu browser login --sites sites.json --site lianjia --timeout 10m",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			sites, err := flags.selectedSites()
			if err != nil {
				return err
			}
			profileDir, err := flags.withProfile(deps)
			if err != nil {
				return err
			}

			loginURLs := make([]string, 0, len(sites))
			for _, site := range sites {
				loginURLs = append(loginURLs, site.LoginURL)
			}

			ctx := cmd.Context()
			if ctx == nil {
				ctx = context.Background()
			}
			// Login is an explicit employee action: acquire the owned target and bring
			// only that window forward. On a cold start the package opens loginURLs in
			// it; attached to a running browser, the CLI opens the tabs below.
			session, err := acquireBrowser()(ctx, "", profileDir, loginURLs,
				browser.AcquireOptions{Foreground: true})
			if err != nil {
				return fmt.Errorf("启动浏览器失败：%w", err)
			}

			// 附着到已在运行的浏览器时，登录页不会由启动分支打开 —— 补开，
			// 否则员工面对的是一个没有登录入口的窗口。
			if !session.Owned {
				openLoginTabs(ctx, session, sites)
			}

			deadline := time.Now().Add(timeout)
			for {
				states := cookieStates(ctx, session, sites)
				if allAuthenticated(states) {
					if session.Owned {
						_ = session.Release()
					}
					return emitEnvelope(cmd, true, browserLoginResult{OK: true, Sites: states})
				}
				if !time.Now().Before(deadline) {
					// 刻意不 Release：窗口留给员工继续登录。
					if err := emitEnvelope(cmd, false, browserLoginResult{OK: false, Sites: states}); err != nil {
						return err
					}
					return fmt.Errorf("等待登录超时（%s）：浏览器窗口已保留，完成登录后请重试", timeout)
				}
				select {
				case <-ctx.Done():
					// 取消不是「保留窗口」的场景：本进程启动的实例必须回收。
					_ = emitEnvelope(cmd, false, browserLoginResult{OK: false, Sites: states})
					if session.Owned {
						_ = session.Release()
					}
					return ctx.Err()
				case <-time.After(loginPollEvery):
				}
			}
		},
	}
	command.Flags().DurationVar(&timeout, "timeout", 5*time.Minute, "How long to wait for sign-in")
	command.Flags().StringArrayVar(&flags.siteIDs, "site", nil, "Limit to a site id (repeatable)")
	addExamples(examples, "browser login",
		"Open the login pages and wait until every site is signed in.",
		"crwu browser login --sites sites.json")
	return command
}

// newBrowserOpenCommand brings the employee's existing browser profile back to a
// site's protected page so a human-verification challenge can be cleared by hand.
//
// It never waits and never releases the session: the caller (the Workbench panel)
// needs the window to stay open on screen after the command returns.
func newBrowserOpenCommand(deps Dependencies, flags *browserFlags, examples map[string][]schemeExample) *cobra.Command {
	command := &cobra.Command{
		Use:     "open",
		Short:   "Open a site's protected page in the owned visible window without waiting",
		Example: "  crwu browser open --sites ~/.crwu/browser/sites.json --site lianjia",
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			sites, err := flags.selectedSites()
			if err != nil {
				return err
			}
			profileDir, err := flags.withProfile(deps)
			if err != nil {
				return err
			}

			protectedURLs := make([]string, 0, len(sites))
			for _, site := range sites {
				protectedURLs = append(protectedURLs, site.ProtectedURL)
			}

			ctx := cmd.Context()
			if ctx == nil {
				ctx = context.Background()
			}
			// Open is an explicit employee action on the owned target: bring that one
			// window forward. A cold start opens protectedURLs in it; an attached
			// session gets the tabs opened below.
			session, err := acquireBrowser()(ctx, "", profileDir, protectedURLs,
				browser.AcquireOptions{Foreground: true})
			if err != nil {
				return fmt.Errorf("启动浏览器失败：%w", err)
			}

			// An attached session has no tab from the startup branch, so the page the
			// employee has to act on would be missing.
			if !session.Owned {
				openProtectedTabs(ctx, session, sites)
			}

			siteID := ""
			if len(flags.siteIDs) == 1 {
				siteID = sites[0].ID
			}
			return emitEnvelope(cmd, true, browserOpenResult{SiteID: siteID, Opened: true, ProtectedURLs: protectedURLs})
		},
	}
	command.Flags().StringArrayVar(&flags.siteIDs, "site", nil, "Limit to a site id (repeatable)")
	addExamples(examples, "browser open",
		"Open a site's protected page in the visible browser window and return immediately.",
		"crwu browser open --sites ~/.crwu/browser/sites.json --site lianjia")
	return command
}

// newBrowserStatusCommand reports the profile's credentials, and only reads the
// protected pages when asked.
//
// The default is a **credential read**: the browser is acquired headless (or
// attached to, when one is already running), cookies come from the profile via
// `Storage.getCookies`, and no URL is passed at launch. Nothing navigates, so no
// window is needed and no fingerprint surface is exposed. `--verify-page` adds the
// page read that produces `verdict`; it reads those pages in the owned target and
// keeps that target for the next call, never adopting an arbitrary tab.
func newBrowserStatusCommand(deps Dependencies, flags *browserFlags, examples map[string][]schemeExample) *cobra.Command {
	var verifyPage bool
	command := &cobra.Command{
		Use:   "status",
		Short: "Report each site's stored session, or read its page with --verify-page",
		Long: "status reads the profile's stored credentials and their expiry without " +
			"opening a window or loading a page. With --verify-page it also reads each " +
			"site's protected page in the owned window and reports the page verdict.",
		Example: "  crwu browser status --sites ~/.crwu/browser/sites.json\n" +
			"  crwu browser status --sites sites.json --verify-page",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			sites, err := flags.selectedSites()
			if err != nil {
				return err
			}
			profileDir, err := flags.withProfile(deps)
			if err != nil {
				return err
			}
			ctx := cmd.Context()
			if ctx == nil {
				ctx = context.Background()
			}

			// A credential read loads no page, so headless exposes no fingerprint
			// surface. Page verification reads protected pages in the owned window and
			// must never adopt the employee's first tab or start a second browser.
			opts := browser.AcquireOptions{Headless: true}
			if verifyPage {
				opts = browser.AcquireOptions{Background: true, KeepAlive: true}
			}
			session, err := acquireBrowser()(ctx, "", profileDir, nil, opts)
			if err != nil {
				// 拿不到浏览器不等于「没登录」：逐站如实报 unknown。
				states := make([]browserSiteState, 0, len(sites))
				for _, site := range sites {
					states = append(states, browserSiteState{
						ID: site.ID, Label: site.Label, State: string(browser.LoginUnknown),
						Reason: fmt.Sprintf("无法获得浏览器会话：%v", err),
					})
				}
				if writeErr := emitEnvelope(cmd, false, browserStatusResult{OK: false, Sites: states}); writeErr != nil {
					return writeErr
				}
				return fmt.Errorf("无法获得浏览器会话：%w", err)
			}
			// Only an instance this process started is reclaimed. An attached browser
			// belongs to whoever started it, usually the employee watching the login
			// window, so we do not even drop our own connection to it.
			if session.Owned {
				defer func() { _ = session.Release() }()
			}

			var states []browserSiteState
			if verifyPage {
				states = verifySites(ctx, session, sites)
				// A visible challenge is the one page result the employee has to act
				// on: raise the same owned target so it can be cleared by hand. A
				// normal page never brings the window forward.
				if anyManualVerification(states) {
					_ = focusOwnedWindow(ctx, session)
				}
			} else {
				states = credentialStates(ctx, session, sites)
			}
			ok := allAuthenticated(states)
			if err := emitEnvelope(cmd, ok, browserStatusResult{OK: ok, Sites: states}); err != nil {
				return err
			}
			if !ok {
				return errors.New("有站点未处于已登录状态")
			}
			return nil
		},
	}
	command.Flags().StringArrayVar(&flags.siteIDs, "site", nil, "Limit to a site id (repeatable)")
	command.Flags().BoolVar(&verifyPage, "verify-page", false,
		"Also read each site's protected page for the page verdict in the owned window")
	addExamples(examples, "browser status",
		"Report each site's stored credential and expiry without opening a window or loading a page.",
		"crwu browser status --sites sites.json")
	addExamples(examples, "browser status",
		"Also read each site's protected page in the owned window and report the page verdict.",
		"crwu browser status --sites sites.json --verify-page")
	return command
}

func newBrowserFetchCommand(deps Dependencies, flags *browserFlags, examples map[string][]schemeExample, shot bool) *cobra.Command {
	var url, out, dump string
	var waitMS int
	var scroll, fullPage, background bool

	use, short := "fetch", "Read the rendered DOM of one page in a reusable background window"
	example := "  crwu browser fetch --url https://bj.lianjia.com/ershoufang/1.html --out page.html"
	if shot {
		use, short = "shot", "Capture a full-page screenshot of one page in a reusable background window"
		example = "  crwu browser shot --url https://bj.lianjia.com/ershoufang/1.html --out page.png"
	}
	visibleExample := strings.TrimSpace(example) + " --background=false"

	command := &cobra.Command{
		Use:   use,
		Short: short,
		Long: "fetch and shot read one page through CDP in one owned window. By default that window " +
			"is reused and left in the background, so consecutive actions share one rendered target " +
			"and nothing is brought forward. It is not a promise that no OS window or startup UI is " +
			"ever shown. --background=false keeps the same owned target but shows its window for this " +
			"action; it never adopts an arbitrary tab and never starts a second browser while one is " +
			"running.",
		Example: example + "\n  " + visibleExample,
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if strings.TrimSpace(url) == "" {
				return errors.New("缺少 --url：请给出要抓取的页面地址")
			}
			if strings.TrimSpace(out) == "" {
				return errors.New("缺少 --out：请给出产物落盘路径")
			}
			profileDir, err := flags.withProfile(deps)
			if err != nil {
				return err
			}
			ctx := cmd.Context()
			if ctx == nil {
				ctx = context.Background()
			}
			// Both modes read the page in one owned target; the flag only decides whether
			// that window is left in the background or shown for this action.
			opts := browser.AcquireOptions{Background: background, Foreground: !background, KeepAlive: true}
			session, err := acquireBrowser()(ctx, "", profileDir, nil, opts)
			if err != nil {
				return writeActionFailure(cmd, fmt.Errorf("无法获得浏览器会话：%w", err))
			}
			defer func() { _ = session.Release() }()

			options := browser.Options{URL: url, Out: out, Dump: dump, WaitMS: waitMS, Scroll: scroll, FullPage: fullPage}
			var result browser.Result
			if shot {
				result, err = browser.DoShot(ctx, session, options)
			} else {
				result, err = browser.DoFetch(ctx, session, options)
			}
			// A manual challenge is the one page shape the employee has to see: raise
			// only the owned target that hit it so it can be cleared by hand.
			if needsManualVerification(result) {
				_ = focusOwnedWindow(ctx, session)
			}
			payload := browserActionJSON{
				OK: result.OK, FailureKind: string(result.FailureKind), Verdict: string(result.Verdict),
				FinalURL: result.FinalURL, Title: result.Title, File: result.File,
				Digest: result.Digest, Bytes: result.Bytes, Status: result.Status,
			}
			if err != nil {
				payload.Error = err.Error()
			}
			if writeErr := emitEnvelope(cmd, result.OK, payload); writeErr != nil {
				return writeErr
			}
			if err != nil {
				return err
			}
			if !result.OK {
				return fmt.Errorf("页面判定为 %s（失败类别 %s）：未写出产物", result.Verdict, result.FailureKind)
			}
			return nil
		},
	}
	command.Flags().StringVar(&url, "url", "", "Page to read (required)")
	command.Flags().StringVar(&out, "out", "", "Where to write the artifact on success (required)")
	command.Flags().StringVar(&dump, "dump", "",
		"Where to write the rendered DOM even when the page did not classify as usable")
	command.Flags().IntVar(&waitMS, "wait-ms", 9000, "How long to let the page settle after navigation")
	command.Flags().BoolVar(&scroll, "scroll", false, "Walk the page first so lazy content materialises")
	command.Flags().BoolVar(&background, "background", true,
		"Reuse and leave the owned window in the background (default); --background=false shows that same owned window for this action")
	if shot {
		command.Flags().BoolVar(&fullPage, "full-page", true, "Capture the whole page, not just the viewport")
	}
	addExamples(examples, "browser "+use, short+".", strings.TrimSpace(example))
	addExamples(examples, "browser "+use,
		"Show the same owned window for this action instead of leaving it in the background.",
		visibleExample)
	return command
}

// needsManualVerification reports whether the page stopped on a human challenge
// the employee must clear in the window (as opposed to a normal read or a login).
func needsManualVerification(result browser.Result) bool {
	return result.Verdict == browser.VerdictCaptcha || result.FailureKind == browser.FailureCaptcha
}

// anyManualVerification reports whether a page-verification pass saw a challenge.
func anyManualVerification(states []browserSiteState) bool {
	for _, state := range states {
		if state.Verdict == string(browser.VerdictCaptcha) {
			return true
		}
	}
	return false
}

// writeActionFailure emits the JSON contract for an infrastructure failure, so a
// caller always gets machine-readable output even when no page was read.
func writeActionFailure(cmd *cobra.Command, err error) error {
	payload := browserActionJSON{FailureKind: string(browser.FailureUnknown), Error: err.Error()}
	if writeErr := emitEnvelope(cmd, false, payload); writeErr != nil {
		return writeErr
	}
	return err
}

// newBrowserRecoverCommand attempts one bounded recovery of a visible human
// verification challenge on the page a retrieval task was reading.
//
// Three deliberate properties:
//
//   - **The budget is a capability, not a parameter.** `--attempts`, `--window-ms`,
//     `--script-timeout-ms`, and `--cooldown-ms` are accepted so the calling adapter
//     can state its policy, but every one of them is clamped in the browser package
//     to the caps the requirement fixes (2 attempts, 120s, 30s, 120s). A bound the
//     caller can widen is not a bound.
//   - **No arbitrary page evaluation.** There is no `--eval` / `--script` flag: the
//     only script that runs is the embedded fixed probe.
//   - **Exit code is not the verdict.** `data` always carries the full outcome,
//     including `state` and the page-level evidence; the exit status is a convenience
//     for shell callers. The archive's solver could exit 0 while still on the
//     challenge page, which is exactly the failure mode this contract prevents.
func newBrowserRecoverCommand(deps Dependencies, flags *browserFlags, examples map[string][]schemeExample) *cobra.Command {
	var siteID, targetURL, taskID, strategy string
	var attempts, windowMS, cooldownMS, scriptTimeoutMS int

	command := &cobra.Command{
		Use:   "recover",
		Short: "Attempt one bounded recovery of a visible verification challenge",
		Long: "recover re-enters the page a retrieval task was reading and tries the " +
			"configured fixed strategy for a visible human-verification challenge. " +
			"It never reports success from a script's exit status: the page is read " +
			"back and the outcome carries what was actually on screen.",
		Example: "  crwu browser recover --sites sites.json --site lianjia --url https://bj.lianjia.com/ershoufang/1.html\n" +
			"  crwu browser recover --sites sites.json --site lianjia --url https://bj.lianjia.com/x.html --strategy cooldown-renavigate",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			sites, err := flags.selectedSites()
			if err != nil {
				return err
			}
			if strings.TrimSpace(siteID) == "" {
				return errors.New("缺少 --site：请给出要恢复的来源 id")
			}
			site, err := browser.FindSite(sites, siteID)
			if err != nil {
				return err
			}
			if strings.TrimSpace(targetURL) == "" {
				return errors.New("缺少 --url：恢复必须回到原来的页面")
			}
			parsed, err := browser.ParseRecoveryStrategy(strategy)
			if err != nil {
				return err
			}
			profileDir, err := flags.withProfile(deps)
			if err != nil {
				return err
			}
			ctx := cmd.Context()
			if ctx == nil {
				ctx = context.Background()
			}

			// Recover must run against the owned target (the page that hit the
			// challenge), never an arbitrary foreign tab, and must leave the browser
			// alive for the next call.
			session, err := acquireBrowser()(ctx, "", profileDir, nil,
				browser.AcquireOptions{Background: true, KeepAlive: true})
			if err != nil {
				// 拿不到浏览器不是「恢复失败」：如实报 unavailable，让调用方保留断点。
				outcome := browser.RecoveryOutcome{
					RetrievalTaskID: taskID,
					ProviderID:      site.ID,
					StrategyID:      string(parsed),
					State:           browser.RecoveryUnavailable,
					ReasonCode:      "browser-unavailable",
					PageValidation:  browser.PageValidation{Reason: err.Error()},
				}
				if writeErr := emitEnvelope(cmd, false, outcome); writeErr != nil {
					return writeErr
				}
				return fmt.Errorf("无法获得浏览器会话：%w", err)
			}
			defer func() { _ = session.Release() }()

			request := browser.RecoveryRequest{
				URL:             targetURL,
				Strategy:        parsed,
				ProviderID:      site.ID,
				RetrievalTaskID: taskID,
				MaxAttempts:     attempts,
				Window:          time.Duration(windowMS) * time.Millisecond,
				ScriptTimeout:   time.Duration(scriptTimeoutMS) * time.Millisecond,
				Cooldown:        time.Duration(cooldownMS) * time.Millisecond,
			}
			// 调用方显式给了 `--cooldown-ms`（含 0）就按它来：宿主协调器要能说
			// "冷却我自己管，别在命令行进程里睡"。
			request.SetCooldownExplicit(cmd.Flags().Changed("cooldown-ms"))
			outcome, err := browser.Recover(ctx, session, request)
			if err != nil {
				return writeActionFailure(cmd, err)
			}
			ok := outcome.State == browser.RecoveryRecovered
			if writeErr := emitEnvelope(cmd, ok, outcome); writeErr != nil {
				return writeErr
			}
			if !ok {
				return fmt.Errorf("自动恢复未通过（%s / %s）：请在浏览器窗口里人工完成验证后重试同一任务",
					outcome.State, outcome.ReasonCode)
			}
			return nil
		},
	}
	command.Flags().StringVar(&siteID, "site", "", "Source id to recover (must exist in --sites) (required)")
	command.Flags().StringVar(&targetURL, "url", "", "The page the retrieval task was reading (required)")
	command.Flags().StringVar(&strategy, "strategy", string(browser.StrategyAuto),
		"Recovery strategy: auto, cooldown-renavigate, geetest-v3-canvas")
	command.Flags().StringVar(&taskID, "task-id", "",
		"Opaque retrieval-task id echoed back in the outcome (caller-supplied, never a path)")
	command.Flags().IntVar(&attempts, "attempts", 0, "Caller's attempt budget (clamped to 2)")
	command.Flags().IntVar(&windowMS, "window-ms", 0, "Caller's total window in ms (clamped to 120000)")
	command.Flags().IntVar(&cooldownMS, "cooldown-ms", 0,
		"Caller's cooldown before re-entering the URL, 0 uses the caller's policy default")
	command.Flags().IntVar(&scriptTimeoutMS, "script-timeout-ms", 0, "Per script/CDP call timeout in ms (clamped to 30000)")
	addExamples(examples, "browser recover",
		"Attempt one bounded recovery of a visible verification challenge, then read the page back.",
		"crwu browser recover --sites sites.json --site lianjia --url https://bj.lianjia.com/ershoufang/1.html")
	return command
}

// loginPollEvery is how often a login run re-checks the sites.
const loginPollEvery = 3 * time.Second

// credentialStates reports each site from the profile's cookies alone.
//
// `status` uses this by default: it is the whole check when the answer needed is
// "is there a live credential", and it touches neither the network nor a page, so
// no window is required. `expiresAt` is the machine-readable expiry and the reason
// carries the same fact in the employee's words.
func credentialStates(ctx context.Context, session *browser.Browser, sites []browser.Site) []browserSiteState {
	cookies, err := session.Client.Cookies(ctx)
	states := make([]browserSiteState, 0, len(sites))
	for _, site := range sites {
		state := browserSiteState{
			ID: site.ID, Label: site.Label, LoginURL: site.LoginURL,
			ProtectedURL: site.ProtectedURL,
		}
		if err != nil {
			state.State = string(browser.LoginUnknown)
			state.Reason = fmt.Sprintf("无法读取登录凭据：%v", err)
			states = append(states, state)
			continue
		}
		evidence := browser.AuthCookieEvidence(cookies, site)
		switch {
		case evidence.Present && !evidence.SessionCookie:
			state.State = string(browser.LoginAuthenticated)
			state.ExpiresAt = evidence.ExpiresAt.UTC().Format(time.RFC3339)
			state.Reason = fmt.Sprintf("已登录（到期 %s）", evidence.ExpiresAt.Local().Format("2006-01-02 15:04"))
		case evidence.Present:
			state.State = string(browser.LoginAuthenticated)
			state.SessionCookie = true
			state.Reason = "已登录（会话 cookie，关掉浏览器即失效）"
		case !evidence.ExpiredAt.IsZero():
			state.State = string(browser.LoginUnauthenticated)
			state.Reason = fmt.Sprintf("登录凭据已过期（%s）：请重新登录该来源",
				evidence.ExpiredAt.Local().Format("2006-01-02 15:04"))
		default:
			state.State = string(browser.LoginUnauthenticated)
			state.Reason = "尚未检测到该来源的登录凭据"
		}
		states = append(states, state)
	}
	return states
}

// cookieStates reports each site's state from cookie presence alone.
//
// The login loop must not navigate. It is bound to one page target, which is very
// likely the tab the employee is signing in on; navigating it every few seconds
// destroys an in-progress slider or verification code and the sign-in never
// completes. Presence is also what the design says login waits for; the
// authoritative navigation check belongs to `status` and to whatever runs before a
// valuation starts.
func cookieStates(ctx context.Context, session *browser.Browser, sites []browser.Site) []browserSiteState {
	cookies, err := session.Client.Cookies(ctx)
	states := make([]browserSiteState, 0, len(sites))
	for _, site := range sites {
		state := browserSiteState{ID: site.ID, Label: site.Label, LoginURL: site.LoginURL}
		switch {
		case err != nil:
			state.State = string(browser.LoginUnknown)
			state.Reason = fmt.Sprintf("无法读取登录凭据：%v", err)
		case browser.AuthCookiePresent(cookies, site):
			state.State = string(browser.LoginAuthenticated)
		default:
			state.State = string(browser.LoginUnauthenticated)
			state.Reason = "尚未检测到该来源的登录凭据"
		}
		states = append(states, state)
	}
	return states
}

// openLoginTabs opens the sites' login pages in the running browser.
func openLoginTabs(ctx context.Context, session *browser.Browser, sites []browser.Site) {
	for _, site := range sites {
		_, _ = session.Client.Call(ctx, "Target.createTarget", map[string]any{"url": site.LoginURL})
	}
}

// openProtectedTabs opens the sites' protected pages in the running browser.
func openProtectedTabs(ctx context.Context, session *browser.Browser, sites []browser.Site) {
	for _, site := range sites {
		_, _ = session.Client.Call(ctx, "Target.createTarget", map[string]any{"url": site.ProtectedURL})
	}
}

// verifySites runs the authoritative check for each site.
func verifySites(ctx context.Context, session *browser.Browser, sites []browser.Site) []browserSiteState {
	states := make([]browserSiteState, 0, len(sites))
	for _, site := range sites {
		// 一次导航拿到状态、判定与凭据有效期：分开调用会把受保护页读两遍，风控只会更紧。
		result := browser.VerifySiteDetailed(ctx, session.Client, site)
		expiresAt := ""
		if !result.ExpiresAt.IsZero() && !result.SessionCookie {
			expiresAt = result.ExpiresAt.UTC().Format(time.RFC3339)
		}
		states = append(states, browserSiteState{
			ID: site.ID, Label: site.Label, LoginURL: site.LoginURL,
			State: string(result.State), Reason: result.Reason,
			Verdict: string(result.Verdict), ProtectedURL: site.ProtectedURL,
			ExpiresAt: expiresAt, SessionCookie: result.SessionCookie,
		})
	}
	return states
}

func allAuthenticated(states []browserSiteState) bool {
	if len(states) == 0 {
		return false
	}
	for _, state := range states {
		if state.State != string(browser.LoginAuthenticated) {
			return false
		}
	}
	return true
}
