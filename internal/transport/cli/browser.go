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
// real browser window.
type browserAcquirer func(ctx context.Context, exe, profileDir string, urls []string) (*browser.Browser, error)

// browserAcquireOverride is the test seam. Production leaves it nil.
var browserAcquireOverride browserAcquirer

func acquireBrowser() browserAcquirer {
	if browserAcquireOverride != nil {
		return browserAcquireOverride
	}
	return browser.Acquire
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
}

type browserLoginResult struct {
	OK    bool               `json:"ok"`
	Sites []browserSiteState `json:"sites"`
}

type browserStatusResult struct {
	OK    bool               `json:"ok"`
	Sites []browserSiteState `json:"sites"`
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
		Long: "browser opens a real, visible Chromium browser and reads pages through the " +
			"DevTools Protocol. It knows nothing about any particular site: the sites it may " +
			"open, and how to tell whether a session is live, come from --sites.",
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
		Short: "Open a visible window and wait until every site is signed in",
		Example: "  crwu browser login --sites ~/.crwu/browser/sites.json\n" +
			"  crwu browser login --sites sites.json --site ke --timeout 10m",
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
			session, err := acquireBrowser()(ctx, "", profileDir, loginURLs)
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

func newBrowserStatusCommand(deps Dependencies, flags *browserFlags, examples map[string][]schemeExample) *cobra.Command {
	command := &cobra.Command{
		Use:     "status",
		Short:   "Report whether each site's session is usable right now",
		Example: "  crwu browser status --sites ~/.crwu/browser/sites.json",
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
			ctx := cmd.Context()
			if ctx == nil {
				ctx = context.Background()
			}

			session, err := acquireBrowser()(ctx, "", profileDir, nil)
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
			defer func() { _ = session.Release() }()

			states := verifySites(ctx, session, sites)
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
	addExamples(examples, "browser status",
		"Report each site's session state (authenticated / unauthenticated / unknown).",
		"crwu browser status --sites sites.json")
	return command
}

func newBrowserFetchCommand(deps Dependencies, flags *browserFlags, examples map[string][]schemeExample, shot bool) *cobra.Command {
	var url, out, dump string
	var waitMS int
	var scroll, fullPage bool

	use, short, example := "fetch", "Read the rendered DOM of one page", "  crwu browser fetch --url https://bj.ke.com/ershoufang/1.html --out /tmp/p.html"
	if shot {
		use, short = "shot", "Capture a full-page screenshot of one page"
		example = "  crwu browser shot --url https://bj.ke.com/ershoufang/1.html --out /tmp/p.png"
	}

	command := &cobra.Command{
		Use:     use,
		Short:   short,
		Example: example,
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
			session, err := acquireBrowser()(ctx, "", profileDir, nil)
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
	if shot {
		command.Flags().BoolVar(&fullPage, "full-page", true, "Capture the whole page, not just the viewport")
	}
	addExamples(examples, "browser "+use, short+".", strings.TrimSpace(example))
	return command
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

// loginPollEvery is how often a login run re-checks the sites.
const loginPollEvery = 3 * time.Second

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

// verifySites runs the authoritative check for each site.
func verifySites(ctx context.Context, session *browser.Browser, sites []browser.Site) []browserSiteState {
	states := make([]browserSiteState, 0, len(sites))
	for _, site := range sites {
		state, reason := browser.VerifySite(ctx, session.Client, site)
		states = append(states, browserSiteState{
			ID: site.ID, Label: site.Label, LoginURL: site.LoginURL,
			State: string(state), Reason: reason,
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
