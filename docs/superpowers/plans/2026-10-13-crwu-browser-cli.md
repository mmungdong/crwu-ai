# `crwu browser` 浏览器抓取能力 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 `crwu` 增加一组通用浏览器命令（`profile` / `login` / `status` / `fetch` / `shot`），让 agent 能在员工已登录的真实浏览器上取渲染后的 DOM 与全页截图。

**Architecture:** 新增 `internal/platform/browser` 包，只做「拿浏览器、验证登录、取页面、截图」四件事，不认识任何站点业务语义。站点（登录 URL、受保护探测 URL、auth cookie 名）由调用方通过 `--sites` 传入的 JSON 文件声明。浏览器一律**有头**、复用固定 profile、**附着优先**；CDP 客户端自持（`scanlogin` 保持不动）。

**Tech Stack:** Go；`spf13/cobra`（CLI）；`gorilla/websocket`（CDP 传输，已在 `go.mod`）；`image/png`（截图校验）。

**Spec:** [`docs/superpowers/specs/2026-10-13-crwu-browser-design.md`](../specs/2026-10-13-crwu-browser-design.md)

## Global Constraints

- 站点语义**不得**硬编码在 CLI 里：站点清单只来自 `--sites <file>`（JSON 数组）。
- 浏览器**必须有头**：启动参数**不得**包含 `--headless`。
- 启动参数**必须**包含 `--no-sandbox`（DSH 沙箱下不加则 Chromium 自身沙箱初始化失败 → SIGTRAP）、`--remote-debugging-port`、`--user-data-dir`、`--disable-gpu`、`--remote-allow-origins=*`。
- **不得**使用 `--window-position`（窗口须正常可见）。
- profile 目录权限 **0700**；环境变量覆盖名 `CRWU_BROWSER_PROFILE`；浏览器可执行文件覆盖名 `CRWU_BROWSER`。
- **永不回显 cookie 值**：任何输出、日志、错误里只允许出现 cookie 的 `domain` / `name` / 长度 / 存在性。
- `crwu scheme` 的 stdout **只能是 JSON**；诊断信息走 stderr。
- 命令失败一律**返回结构化错误**，不 panic、不打印裸堆栈。
- 提交（`git commit`）须用户显式授权（仓库 `AGENTS.md`）。未授权时执行 `git add` 并停下等指示。

## Review Focus

1. **`--sites` 文件缺失/畸形/重复 id/空 URL** —— 期望：结构化报错并说明缺哪一项，绝不启动浏览器。
2. **profile 目录不存在、权限不是 0700、或 `CRWU_BROWSER_PROFILE` 指向一个文件而非目录** —— 期望：明确报错，不静默改成别的路径。
3. **浏览器已在运行但调试端口不可达**（进程活着、端口被占/被关）—— 期望：判定为「不可附着」，另起受控实例，而不是把请求挂死。
4. **页面是验证页 / 拦截页 / 登录页** —— 期望：截图**不写盘即判失败**，绝不产出验证页截图当房源页。
5. **取消与超时** —— 期望：命令及时返回，且**不留下无主浏览器进程**；由本进程启动的实例必须被回收。

---

### Task 1: 站点定义装载与 profile 目录

**Files:**
- Create: `internal/platform/browser/site.go`
- Create: `internal/platform/browser/profile.go`
- Test: `internal/platform/browser/site_test.go`
- Test: `internal/platform/browser/profile_test.go`

**Interfaces:**
- Consumes: 无
- Produces:
  - `type Site struct { ID, Label, LoginURL, ProtectedURL, AuthCookie string; AuthDomains []string }`
  - `func LoadSites(path string) ([]Site, error)`
  - `func FindSite(sites []Site, id string) (Site, error)`
  - `func ProfileDir(getenv func(string) string) (string, error)`
  - `func EnsureProfileDir(dir string) error`

- [ ] **Step 1: Write the failing tests**

```go
// site_test.go
func TestLoadSitesRejectsMissingRequiredField(t *testing.T) {
    // 每缺一项都必须是结构化错误，且错误文本里出现缺的那一项
    for _, tc := range []struct{ name, body, wantMention string }{
        {"no id", `[{"loginUrl":"https://a/","protectedUrl":"https://b/","authCookie":"c"}]`, "id"},
        {"no loginUrl", `[{"id":"ke","protectedUrl":"https://b/","authCookie":"c"}]`, "loginUrl"},
        {"no protectedUrl", `[{"id":"ke","loginUrl":"https://a/","authCookie":"c"}]`, "protectedUrl"},
        {"no authCookie", `[{"id":"ke","loginUrl":"https://a/","protectedUrl":"https://b/"}]`, "authCookie"},
    } { /* 写文件 → LoadSites → 断言 err != nil 且 strings.Contains(err.Error(), tc.wantMention) */ }
}

func TestLoadSitesRejectsDuplicateID(t *testing.T) { /* 两个同 id → err 里含 id 名 */ }

func TestFindSiteUnknownIDListsKnownIDs(t *testing.T) { /* 未知 id → err 里同时含未知 id 与已配置的 id 列表 */ }
```

```go
// profile_test.go
func TestProfileDirPrefersEnvOverride(t *testing.T) {
    got, err := ProfileDir(func(k string) string {
        if k == "CRWU_BROWSER_PROFILE" { return "/tmp/x-profile" }
        return ""
    })
    // want "/tmp/x-profile"
}

func TestProfileDirDefaultsUnderUserHome(t *testing.T) {
    // getenv 恒返回 "" → want filepath.Join(home, ".crwu", "browser", "profile")
}

func TestEnsureProfileDirCreatesAndForces0700(t *testing.T) {
    // 先建一个 0755 的目录 → EnsureProfileDir → 再 Stat 应为 0700
}

func TestEnsureProfileDirRejectsFileInPlaceOfDir(t *testing.T) {
    // 路径上已存在一个普通文件 → 必须报错，且不得删除该文件
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/platform/browser/ -run 'TestLoadSites|TestFindSite|TestProfileDir|TestEnsureProfileDir' -v`
Expected: FAIL — `undefined: LoadSites` / `undefined: ProfileDir`

- [ ] **Step 3: Implement `site.go` and `profile.go`**

`Site` 的 JSON 字段名用 camelCase（与 `--sites` 文件一致）。`LoadSites` 逐条校验：`id` / `loginUrl` / `protectedUrl` / `authCookie` 非空；`id` 唯一；URL 能被 `url.Parse` 解析。错误文本里带上条目序号与缺失字段名。

`ProfileDir`：`CRWU_BROWSER_PROFILE` 非空则用它；否则 `os.UserHomeDir()` + `.crwu/browser/profile`。

`EnsureProfileDir`：`os.MkdirAll(dir, 0o700)`，随后 `os.Chmod(dir, 0o700)` 强制纠正已存在的宽权限；若路径已是普通文件则返回明确错误（**不删除**）。

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/platform/browser/ -v`
Expected: PASS

- [ ] **Step 5: Stage**

```bash
git add internal/platform/browser/
```

---

### Task 2: 浏览器启动参数与调试端点等待

**Files:**
- Create: `internal/platform/browser/launch.go`
- Test: `internal/platform/browser/launch_test.go`

**Interfaces:**
- Consumes: Task 1 的 `ProfileDir`
- Produces:
  - `type LaunchSpec struct { ProfileDir string; Port int; URLs []string }`
  - `func LaunchArgs(spec LaunchSpec) []string`
  - `func FreePort() (int, error)`
  - `func StartBrowser(exe string, args []string) (*os.Process, error)`
  - `func WaitForPageTarget(ctx context.Context, port int, timeout time.Duration) (wsURL string, err error)`

- [ ] **Step 1: Write the failing test**

```go
func TestLaunchArgsAlwaysHeadedWithSandboxOff(t *testing.T) {
    args := LaunchArgs(LaunchSpec{ProfileDir: "/tmp/p", Port: 9333, URLs: []string{"https://a/"}})
    joined := strings.Join(args, " ")
    for _, want := range []string{
        "--remote-debugging-port=9333", "--user-data-dir=/tmp/p",
        "--no-sandbox", "--disable-gpu", "--remote-allow-origins=*",
        "--no-first-run", "--no-default-browser-check", "--disable-crashpad",
        "https://a/",
    } {
        if !strings.Contains(joined, want) { t.Fatalf("LaunchArgs missing %q: %v", want, args) }
    }
    for _, banned := range []string{"--headless", "--window-position"} {
        if strings.Contains(joined, banned) { t.Fatalf("LaunchArgs must not contain %q: %v", banned, args) }
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/platform/browser/ -run TestLaunchArgs -v`
Expected: FAIL — `undefined: LaunchArgs`

- [ ] **Step 3: Implement `launch.go`**

`LaunchArgs` 是**纯函数**（无副作用、可断言）。`FreePort` 用 `net.Listen("tcp","127.0.0.1:0")` 后立即关闭取端口（与 `scanlogin.FreePort` 同法，该函数未导出故此处重写）。`StartBrowser` 用 `exec.Command`，`Stdout`/`Stderr` 丢弃，进程不 `Wait`（由 Task 6 的释放函数负责）。`WaitForPageTarget` 轮询 `http://127.0.0.1:<port>/json/list`，取第一个 `type == "page"` 且 `webSocketDebuggerUrl` 非空的目标；超时返回明确错误。

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/platform/browser/ -v`
Expected: PASS

- [ ] **Step 5: Stage**

```bash
git add internal/platform/browser/
```

---

### Task 3: CDP 客户端

**Files:**
- Create: `internal/platform/browser/cdp.go`
- Test: `internal/platform/browser/cdp_test.go`

**Interfaces:**
- Consumes: 无（自成一体，仅依赖 `gorilla/websocket`）
- Produces:
  - `type Client struct{ … }`
  - `func Dial(ctx context.Context, wsURL string) (*Client, error)`
  - `func (c *Client) Call(ctx context.Context, method string, params map[string]any) (json.RawMessage, error)`
  - `func (c *Client) Cookies(ctx context.Context) ([]Cookie, error)`
  - `func (c *Client) Close() error`
  - `type Cookie struct { Name, Domain, Value string }`

**为什么这里另写一份 CDP 客户端**：spec §9 要求 `internal/platform/scanlogin` **不动**。`scanlogin` 的客户端与其会话捕获逻辑耦合，抽出来会改动已验证的登录链路。本包自持一份最小客户端（约 60 行），代价可控。

- [ ] **Step 1: Write the failing tests**

测试用**本地假 CDP 服务**：`httptest.NewServer` 提供 `/json/version`，再用 `websocket.Upgrader` 起一个回显指定 `result` 的 WS 端点。**测试不得访问外网。**

```go
func TestCallRoutesResponseByID(t *testing.T) {
    // 服务端先推一条无关事件（无 id），再回 id 匹配的响应
    // 断言 Call 返回的是匹配 id 的那条 result，而不是被事件带偏
}

func TestCallReturnsErrorOnErrorField(t *testing.T) {
    // 服务端回 {"id":n,"error":{"code":-1,"message":"boom"}}
    // 断言 err != nil 且含 "boom"
}

func TestCookiesParsesDomainNameValueOnly(t *testing.T) {
    // 服务端回 Network.getCookies 结果，含 value
    // 断言返回的 Cookie 有 Name/Domain/Value，且没有其它字段
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/platform/browser/ -run 'TestCall|TestCookies' -v`
Expected: FAIL — `undefined: Dial`

- [ ] **Step 3: Implement `cdp.go`**

`Call` 用互斥锁保护 id 自增与写；读循环忽略 `id` 不匹配的消息（事件与其它响应），只返回 id 匹配的那条；`error` 非空时返回 `fmt.Errorf("CDP %s: %s", method, msg)`。`Cookies` 走 `Network.getCookies`（不传 `urls`，取全部），只解出 `name`/`domain`/`value`。

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/platform/browser/ -v`
Expected: PASS

- [ ] **Step 5: Stage**

```bash
git add internal/platform/browser/
```

---

### Task 4: 页面事实、滚动与 DOM/截图原语

**Files:**
- Create: `internal/platform/browser/page.go`
- Test: `internal/platform/browser/page_test.go`

**Interfaces:**
- Consumes: Task 3 的 `*Client`
- Produces:
  - `type PageFacts struct { Href, Title, Text string }`
  - `func (c *Client) Navigate(ctx context.Context, url string) error`
  - `func (c *Client) SetViewport(ctx context.Context, width, height int) error`
  - `func (c *Client) Facts(ctx context.Context) (PageFacts, error)`
  - `func (c *Client) ScrollAll(ctx context.Context) error`
  - `func (c *Client) OuterHTML(ctx context.Context) (string, error)`
  - `func (c *Client) Screenshot(ctx context.Context) ([]byte, error)`
  - `func ScrollScript() string`（纯函数，供断言）

- [ ] **Step 1: Write the failing test**

```go
func TestScrollScriptWalksWholePageAndReturnsToTop(t *testing.T) {
    s := ScrollScript()
    // 断言：按步长推进（含 scrollHeight 与 window.scrollTo）、最后回到 0
    for _, want := range []string{"scrollHeight", "window.scrollTo(0,0)", "awaitPromise"} { /* … */ }
}
```

```go
func TestFactsParsesEvaluateResult(t *testing.T) {
    // 假 CDP 服务对 Runtime.evaluate 回 {"result":{"value":"{\"href\":\"https://a/\",\"title\":\"T\",\"text\":\"B\"}"}}
    // 断言 Facts() 得到 Href/Title/Text 三个字段
}

func TestFactsTreatsUnparseableValueAsEmpty(t *testing.T) {
    // value 是 "not json" → 返回零值 PageFacts 且 err != nil（不得 panic、不得返回半个结构）
}
```

`Navigate` / `SetViewport` / `ScrollAll` / `OuterHTML` / `Screenshot` 是对 CDP 的直接封装，
由 Task 7 的真机验收覆盖；`ScrollScript` 与 `Facts` 这两个**有决策**的部分在此单测。

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/platform/browser/ -run TestScrollScript -v`
Expected: FAIL — `undefined: ScrollScript`

- [ ] **Step 3: Implement `page.go`**

`Navigate` 调 `Page.navigate`，随后轮询 `Facts().Href` 直到非空或超时（不做「等 load 事件」，避免 SPA 永不触发）。`ScrollAll` 用 `Runtime.evaluate` + `awaitPromise: true` 执行 `ScrollScript()`。`Screenshot` 先 `Page.getLayoutMetrics` 取 `cssContentSize`，用它 `SetViewport`，再 `Page.captureScreenshot{format:"png", captureBeyondViewport:true}`，返回解码后的字节。**调用方负责在截图后恢复视口**（Task 5 处理）。

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/platform/browser/ -v`
Expected: PASS

- [ ] **Step 5: Stage**

```bash
git add internal/platform/browser/
```

---

### Task 5: 页面判定、截图校验与登录态验证

**Files:**
- Create: `internal/platform/browser/classify.go`
- Create: `internal/platform/browser/verify.go`
- Test: `internal/platform/browser/classify_test.go`
- Test: `internal/platform/browser/verify_test.go`

**Interfaces:**
- Consumes: Task 1 的 `Site`；Task 3 的 `Cookie`；Task 4 的 `PageFacts`
- Produces:
  - `type Verdict string`（`VerdictOK` / `VerdictLoginWall` / `VerdictCaptcha` / `VerdictBlocked`）
  - `func ClassifyPage(facts PageFacts) Verdict`
  - `func AuthCookiePresent(cookies []Cookie, site Site) bool`
  - `type LoginState string`（`LoginAuthenticated` / `LoginUnauthenticated` / `LoginUnknown`）
  - `func VerifySite(ctx context.Context, c *Client, site Site) (LoginState, string)`
  - `func VerifyScreenshot(png []byte) error`

- [ ] **Step 1: Write the failing tests**

```go
func TestClassifyPageSeparatesBlockedFromMissingData(t *testing.T) {
    for _, tc := range []struct{ name string; facts PageFacts; want Verdict }{
        {"login wall by title", PageFacts{Href: "https://clogin.ke.com/login", Title: "登录"}, VerdictLoginWall},
        {"login wall by text", PageFacts{Href: "https://x/", Title: "x", Text: "用户登录 手机快捷登录"}, VerdictLoginWall},
        {"captcha by title", PageFacts{Title: "CAPTCHA"}, VerdictCaptcha},
        {"captcha by text", PageFacts{Title: "x", Text: "人机验证 点击按钮开始验证"}, VerdictCaptcha},
        {"blocked", PageFacts{Title: "x", Text: "访问已被拦截 拦截 ID"}, VerdictBlocked},
        {"normal page", PageFacts{Href: "https://bj.ke.com/ershoufang/chaoyang/", Title: "二手房", Text: "在售"}, VerdictOK},
    } { /* 断言 ClassifyPage(tc.facts) == tc.want */ }
}

func TestAuthCookiePresentRequiresNameDomainAndValue(t *testing.T) {
    site := Site{ID: "ke", AuthCookie: "lianjia_token", AuthDomains: []string{".ke.com"}}
    // 只命中 name 但 domain 不符 → false
    // domain 命中但 value 为空串 → false
    // 三者齐 → true
}

func TestVerifyScreenshotRejectsBlankAndTinyImages(t *testing.T) {
    // 纯白 1440x1200 → error 含 "空白"
    // 10x10 的图片 → error 含 "尺寸"
    // 有内容的图（画几条线）→ nil
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/platform/browser/ -run 'TestClassifyPage|TestAuthCookiePresent|TestVerifyScreenshot' -v`
Expected: FAIL — `undefined: ClassifyPage`

- [ ] **Step 3: Implement `classify.go` 与 `verify.go`**

`ClassifyPage` 的判定顺序**必须是**：登录墙 → 验证码 → 拦截 → 正常。理由：被登录墙挡住时页面里往往同时带着验证码痕迹，先判登录墙才不会把员工指去点验证码。

`ClassifyPage` 用到的特征串（来自实测页面）：登录墙 `Title == "登录"` 或正文含 `用户登录` / `手机快捷登录` / 最终 URL 命中 `clogin.`；验证码 `Title == "CAPTCHA"` 或正文含 `人机验证` / `安全验证` / `拖动滑块`；拦截正文含 `访问已被拦截`。

`VerifySite`：先 `AuthCookiePresent` 做**快判**（不通过直接 `LoginUnauthenticated`）；再 `Navigate(site.ProtectedURL)` + `Facts()` + `ClassifyPage`——`VerdictOK` → `LoginAuthenticated`，`VerdictLoginWall` → `LoginUnauthenticated`，其余（验证码/拦截/导航失败）→ `LoginUnknown`。返回的第二值是**给员工看的原因**，不得含 cookie 值。

`VerifyScreenshot`：`png.Decode`；宽 < 200 或高 < 200 → 错；按**每 4 个像素采样**统计非白占比（`min(r,g,b) < 235`），占比 < 3% → 错（文案含「空白」）。

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/platform/browser/ -v`
Expected: PASS

- [ ] **Step 5: Stage**

```bash
git add internal/platform/browser/
```

---

### Task 6: 附着优先的浏览器获取与释放

**Files:**
- Create: `internal/platform/browser/acquire.go`
- Test: `internal/platform/browser/acquire_test.go`

**Interfaces:**
- Consumes: Task 1 的 `ProfileDir`；Task 2 的 `LaunchArgs` / `FreePort` / `StartBrowser` / `WaitForPageTarget`；Task 3 的 `Dial`
- Produces:
  - `func DebugPortFile(profileDir string) string`
  - `func RunningPort(profileDir string) (int, bool)`
  - `type Browser struct { Port int; Owned bool; Client *Client; release func() }`
  - `func (b *Browser) Release() error`
  - `func Acquire(ctx context.Context, exe, profileDir string, urls []string) (*Browser, error)`

**浏览器可执行文件来源**：直接调用 `scanlogin.DiscoverBrowser()`（spec §9 要求复用其发现逻辑，不重写第二份）。
调用方在 `exe == ""` 时自行回退到它。

- [ ] **Step 1: Write the failing tests**

```go
func TestRunningPortReturnsFalseWhenPortFileMissing(t *testing.T) { /* → (0,false) */ }

func TestRunningPortReturnsFalseWhenPortFileIsGarbage(t *testing.T) {
    // 写入 "abc" → (0,false)，且不得 panic
}

func TestRunningPortReturnsFalseWhenDebuggerNotAnswering(t *testing.T) {
    // 写入一个没人监听的端口 → (0,false)
}

func TestRunningPortReturnsPortWhenDebuggerAnswers(t *testing.T) {
    // httptest 起 /json/version → 把它的端口写进 port 文件 → (port,true)
}

func TestReleaseIsIdempotent(t *testing.T) {
    // 对 Owned:false 的 Browser 连调两次 Release() → 两次都返回 nil，不 panic
}

func TestReleaseNeverKillsNonOwnedBrowser(t *testing.T) {
    // Owned:false 且端口文件属于一个真实在跑的假调试端点
    // Release() 之后该端点**仍然可达**
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/platform/browser/ -run TestRunningPort -v`
Expected: FAIL — `undefined: RunningPort`

- [ ] **Step 3: Implement `acquire.go`**

`DebugPortFile` 返回 `<profileDir>/../debug-port`（即 `~/.crwu/browser/debug-port`，**与 profile 同级而非其内**，避免浏览器把它当成 profile 内容）。

`Acquire` 顺序：
1. `RunningPort` 命中 → `Dial` 到该端口的 page target → 返回 `Owned:false`，`release` 只关 WS；
2. 否则 `FreePort` → `StartBrowser(exe, LaunchArgs{…})` → `WaitForPageTarget` → `Dial` → 写 port 文件 → 返回 `Owned:true`，`release` 关闭 WS、`Process.Kill()`、`Wait()`、删 port 文件。

`release` **必须幂等**（多次调用不 panic），且**只回收自己启动的实例**（`Owned:false` 时绝不杀进程）。

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/platform/browser/ -v`
Expected: PASS

- [ ] **Step 5: Stage**

```bash
git add internal/platform/browser/
```

---

### Task 7: `fetch` / `shot` 结果与失败分类

**Files:**
- Create: `internal/platform/browser/action.go`
- Test: `internal/platform/browser/action_test.go`

**Interfaces:**
- Consumes: Task 4 / Task 5 / Task 6
- Produces:
  - `type FailureKind string`（`""` / `FailureLogin` / `FailureCaptcha` / `FailureBlocked` / `FailureRateLimited` / `FailureNotFound` / `FailureServerError` / `FailureNetwork` / `FailureUnknown`）
  - `func FailureKindOf(v Verdict, status int, navErr error) FailureKind`
  - `type Result struct { OK bool; FailureKind FailureKind; Verdict Verdict; FinalURL, Title, File, Digest string; Bytes, Status int }`
  - `type Options struct { URL, Out, Dump string; WaitMS int; Scroll bool }`
  - `func DoFetch(ctx context.Context, b *Browser, opt Options) (Result, error)`
  - `func DoShot(ctx context.Context, b *Browser, opt Options) (Result, error)`

- [ ] **Step 1: Write the failing test**

```go
func TestFailureKindMapsVerdictStatusAndNavError(t *testing.T) {
    for _, tc := range []struct{ name string; v Verdict; status int; navErr error; want FailureKind }{
        {"login wall", VerdictLoginWall, 200, nil, FailureLogin},
        {"captcha", VerdictCaptcha, 200, nil, FailureCaptcha},
        {"blocked", VerdictBlocked, 200, nil, FailureBlocked},
        {"rate limited", VerdictOK, 429, nil, FailureRateLimited},
        {"forbidden", VerdictOK, 403, nil, FailureRateLimited},
        {"not found", VerdictOK, 404, nil, FailureNotFound},
        {"server error", VerdictOK, 500, nil, FailureServerError},
        {"network", VerdictOK, 0, errors.New("dial tcp: timeout"), FailureNetwork},
        {"ok", VerdictOK, 200, nil, ""},
    } { /* 断言 FailureKindOf(...) == tc.want */ }
}
```

```go
func TestDoShotDoesNotWriteFileWhenVerdictIsNotOK(t *testing.T) {
    // 假 CDP 服务让页面 Facts 命中验证码特征
    // 断言：返回的 Result.OK == false，且 out 路径**不存在**
}

func TestDoFetchWritesDumpEvenWhenVerdictIsNotOK(t *testing.T) {
    // 同一个验证码页面，但带上 dumpPath
    // 断言：out 不存在，dumpPath **存在**且内容非空
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/platform/browser/ -run 'TestFailureKindMaps|TestDoShot|TestDoFetchWrites' -v`
Expected: FAIL — `undefined: FailureKindOf`

- [ ] **Step 3: Implement `action.go`**

优先级**必须**是：`navErr` → `Verdict` → 状态码。理由：导航都没成功时，状态码是 0，不能把它说成「服务器错误」。

`DoFetch`：`SetViewport(1440,1000)` → `Navigate` → `time.Sleep(waitMS)` → 可选 `ScrollAll` → `Facts` + `ClassifyPage` → 分类非 OK 时**不写文件**直接返回结果 → 否则 `OuterHTML` 写 `out`，算 `sha256` 前 12 位进 `Digest`，返回 `OK:true`。

`DoShot`：同上流程，但用 `Screenshot()` → `VerifyScreenshot()` 失败则**不写文件**返回结果 → 通过才写 `out`。**写盘前必须恢复视口**（`SetViewport(1440,1000)`），否则下一次调用会继承超大视口。

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/platform/browser/ -v`
Expected: PASS

- [ ] **Step 5: Stage**

```bash
git add internal/platform/browser/
```

---

### Task 8: CLI 命令与契约文档

**Files:**
- Create: `internal/transport/cli/browser.go`
- Modify: `internal/transport/cli/cli.go:84`（在 `root.AddCommand(newH3YunCommand(...))` 后加一行注册）
- Test: `internal/transport/cli/browser_test.go`
- Modify: `docs/v0.0.1/cli-manual.md`
- Modify: `docs/v0.0.1/cli-command-contract.md`
- Modify: `docs/v0.0.1/CHANGELOG.md`

**Interfaces:**
- Consumes: Task 1–7 的全部导出
- Produces: `func newBrowserCommand(examples map[string][]schemeExample) *cobra.Command`

- [ ] **Step 1: Write the failing tests**

```go
func TestBrowserLoginRequiresSitesFlag(t *testing.T) {
    // RunWithDependencies(["browser","login"], …) → 非 0 退出码，stderr 含 "--sites"
}

func TestBrowserFetchRequiresURLAndOut(t *testing.T) { /* 缺 --url / --out 各自报错并指名 */ }

func TestBrowserStatusEmitsJSONOnStdout(t *testing.T) {
    // 用一个临时 sites 文件 + 一个必然不可达的 profile → stdout 必须是合法 JSON
    // 且 stdout 中不得出现任何 cookie 值（用哨兵值断言）
}

func TestBrowserSchemeIsJSONOnly(t *testing.T) {
    // RunWithDependencies(["scheme","browser"], …) → stdout 可被 json.Unmarshal
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/transport/cli/ -run TestBrowser -v`
Expected: FAIL — 未知命令 `browser`

- [ ] **Step 3: Implement `browser.go` 并注册**

子命令与标志（`--sites` 与 `--profile` 为持久标志挂在 `browser` 上）：

| 命令 | 标志 |
| --- | --- |
| `browser profile` | — |
| `browser login` | `--site <id>`（可重复，缺省全部）、`--timeout`（缺省 `5m`） |
| `browser status` | `--site <id>`（可重复，缺省全部） |
| `browser fetch` | `--url`（必填）、`--out`（必填）、`--wait-ms`（缺省 `9000`）、`--scroll`、`--dump <f>` |
| `browser shot` | `--url`（必填）、`--out`（必填）、`--wait-ms`（缺省 `9000`）、`--scroll`、`--full-page`（缺省 true）、`--dump <f>` |

`--dump` = **即使判定不是 OK 也把已渲染 DOM 存到该路径**，供排障（页面被拦/验证时仍能看到现场）。
`--out` 只在判定 OK 时写。

每个子命令：**stdout 只写一份 JSON**（`writeJSON`），诊断走 `cmd.ErrOrStderr()`。`login` 成功判据是**所有选定站点都 `LoginAuthenticated`**；未全部通过时返回非 0 退出码，但 JSON 里逐站给出状态与原因，且**保留浏览器窗口**。

`addExamples(examples, "browser", …)` 为每个叶子补至少一条示例命令。

同时更新三份文档：`cli-manual.md` 加一节 `crwu browser`（含登录前置、profile 位置、窗口为何可见）；`cli-command-contract.md` 登记五个叶子命令的参数与输出契约；`CHANGELOG.md` 追加本次功能条目。

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/transport/cli/ -v && go test ./internal/platform/browser/ -v`
Expected: PASS

- [ ] **Step 5: Run the repository gates**

Run: `make test && make docs-check && git diff --check`
Expected: 全部通过

- [ ] **Step 6: Stage**

```bash
git add internal/transport/cli/ docs/
```

---

## 真机验收（由员工在本机执行，不属于自动化测试）

1. `crwu browser profile` → 打印 profile 路径
2. `crwu browser login --sites <file>` → 弹出**可见窗口**，员工完成贝壳/链家登录（含滑块）
3. `crwu browser status --sites <file>` → 两站均 `authenticated`
4. `crwu browser fetch --url https://bj.ke.com/ershoufang/<id>.html --out /tmp/d.html` → `ok:true`，`/tmp/d.html` 里含该房源信息
5. `crwu browser shot --url <同一 URL> --out /tmp/d.png` → `ok:true`，图片打开是**房源页**而非验证页
6. 关掉浏览器窗口后再跑第 4 步 → 仍成功（自动另起受控实例）

## 不在本计划范围

插件侧接入（`browserTransport`、URL 模板校正、解析器兜底、估值域登录门禁、截图注入）属 **Plan B**，
在本计划通过真机验收后单独出计划。
