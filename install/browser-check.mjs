/**
 * 真实浏览器验收（第 5 ~ 7a 条验收判据的唯一自动化办法）。
 *
 * 为什么需要它：`npm run smoke:built` 用替身把 `lib/client.js` 过一遍 `__ModuleLoader__`，
 * 只能证明「产物形状对、注册调用了」；**面板真的画出来、标签能切、切标签不重复列举 OSS**
 * 这些行为只有真浏览器能证明。第 26 轮之前这一条一直挂在「需人眼」。
 *
 * 前置：
 *   1. 有一个正在跑的 DSH profile 装了本插件（推荐独立 profile，见 README 第五节）：
 *        dsh plugin --profile smoke add .
 *        DSH_PERMISSION_MODE=danger-full-access dsh --profile smoke --port 3099 --no-open
 *      起 profile 时给出的 `http://127.0.0.1:<port>/?token=<token>` 就是 `--url`。
 *   2. 有 `playwright-core` 与一个已安装的 Chromium 系浏览器。本脚本默认用系统里的
 *      Microsoft Edge（channel: 'msedge'），因此**不需要下载 Chromium**：
 *        mkdir -p /tmp/pw && cd /tmp/pw && npm i playwright-core
 *        node <本文件> --url 'http://127.0.0.1:3099/?token=...' --playwright /tmp/pw/node_modules
 *
 * 一条硬约束：**本脚本绝不点击「AI 审核」**。那会在真实案例上跑一次真实审核、写真实工作空间、
 * 可能自动传真实 OSS。脚本末尾会核对整个会话里没有发出过 `audit-start`，发了就判失败。
 *
 * 用法：
 *   node install/browser-check.mjs --url <带 token 的地址> [--out <截图目录>] [--playwright <node_modules 路径>]
 */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

function argOf(name, fallback = '') {
  const at = process.argv.indexOf(`--${name}`)
  if (at < 0) return fallback
  return process.argv[at + 1] ?? fallback
}

/** 从可能被 `--playwright` 指定的 node_modules 里加载 playwright-core。 */
async function loadPlaywright() {
  const root = argOf('playwright')
  const specifier = root === '' ? 'playwright-core' : pathToFileURL(join(root, 'playwright-core', 'index.js')).href
  let mod
  try {
    mod = await import(specifier)
  } catch (error) {
    throw new Error(`加载 playwright-core 失败（${specifier}）：${error instanceof Error ? error.message : String(error)}`)
  }
  // playwright-core 是 CJS：从 ESM `import()` 进来时导出挂在 `default` 上。
  const chromium = mod.chromium ?? mod.default?.chromium
  if (chromium === undefined) throw new Error(`playwright-core 没有暴露 chromium（${specifier}）`)
  return { chromium }
}

const SEQ = /2026-\d{6}-LX\d+-BG\d+/

/** 一条检查 = 一个名字 + 一个断言函数；失败收进 failures，不中断后面的检查。 */
class Checks {
  constructor() {
    this.failures = []
    this.passed = []
  }

  that(name, condition, detail = '') {
    if (condition) this.passed.push(name)
    else this.failures.push(detail === '' ? name : `${name}（${detail}）`)
    return condition === true
  }
}

async function main() {
  const url = argOf('url')
  if (url === '') throw new Error('缺少 --url（带 token 的 DSH 页面地址）')
  const out = argOf('out', join(process.cwd(), 'browser-check-shots'))
  await mkdir(out, { recursive: true })

  const { chromium } = await loadPlaywright()
  const browser = await chromium.launch({
    channel: 'msedge',
    headless: true,
    args: ['--disable-gpu', '--in-process-gpu', '--disable-software-rasterizer', '--no-first-run'],
  })
  const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } })
  const ops = []
  const consoleErrors = []
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 160)) })
  page.on('pageerror', (error) => consoleErrors.push(String(error).slice(0, 160)))
  page.on('request', (request) => {
    if (request.url().includes('/api/crwu-workbench') && request.method() === 'POST') {
      try { ops.push(JSON.parse(request.postData() ?? '{}').op) } catch { ops.push('?') }
    }
  })

  const checks = new Checks()
  const body = () => page.locator('body').innerText()
  // 右上角那颗环境指示灯。它在两个槽位各挂一次（会话头 / 面板头），但 `main` 是 keyed 槽位，
  // 同一时刻只渲染其中一个，所以 first() 拿到的就是「当前看得见的那颗」。
  const lamp = () => page.getByRole('button', { name: '环境自检' }).first()
  const ossListings = () => ops.filter((op) => op === 'oss-index').length

  /**
   * 一个阶段失败不能变成崩溃：验收工具必须**报告**失败。
   * 返回 true 表示这一阶段通过、后续阶段可以继续。
   */
  const phase = async (name, fn) => {
    try {
      await fn()
      return true
    } catch (error) {
      checks.failures.push(`${name}（${String(error).split('\n')[0].slice(0, 160)}）`)
      return false
    }
  }

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })

    // ── 第 5 条：侧栏入口出现 ──────────────────────────────────────────────
    const entry = page.getByText('中瑞世联工作台', { exact: false }).first()
    const hasEntry = await phase('侧栏出现「中瑞世联工作台」入口', async () => {
      await entry.waitFor({ state: 'visible', timeout: 45_000 })
      checks.passed.push('侧栏出现「中瑞世联工作台」入口')
    })
    if (!hasEntry) {
      // 面板都没出现，后面的检查没有意义 —— 但上面的失败已经记录了。
      await page.screenshot({ path: join(out, 'no-panel.png') })
    } else {
      await entry.click()
      // 打开面板后**没有**页内「环境自检」标签页了：右上角那颗灯才是入口，
      // 自检期间显示 loading，出结论后要么直接进报告审核（通过），要么停在这一页（不通过）。
      let envOk = false
      const opened = await phase('点进去后工作台渲染出右上角环境指示灯', async () => {
        await lamp().waitFor({ state: 'visible', timeout: 30_000 })
        checks.passed.push('点进去后工作台渲染出右上角环境指示灯')
        // 自检要跑 shell 与网络（探二进制、问氚云/钉钉、列一次 OSS），给足时间。
        await page.waitForFunction(
          () => /环境就绪|环境未通过/.test(document.body.innerText),
          undefined,
          { timeout: 120_000 },
        )
      })
      if (opened) {
        // ── 右上角指示灯：绿=通过、红=不通过，且颜色必须与结论一致 ──────────
        await phase('右上角环境指示灯', async () => {
          const classes = String(await lamp().locator('span').first().getAttribute('class') ?? '')
          const ok = classes.includes('crwu-audit-dot-ok')
          const bad = classes.includes('crwu-audit-dot-bad')
          envOk = ok
          checks.that('指示灯有结论色（绿或红）', ok || bad, `class=${classes}`)
          checks.that('指示灯颜色与自检结论一致', ok !== bad, `绿=${String(ok)} 红=${String(bad)}`)
          const title = String(await lamp().getAttribute('title') ?? '')
          checks.that('指示灯悬停文案给出结论', /环境(就绪|未通过|自检中|未自检)/.test(title))
          await page.screenshot({ path: join(out, 'lamp.png') })
        })

        // ── 门禁：通过就直接进报告审核；不通过必须停在环境自检页 ────────────
        await phase('自检门禁', async () => {
          const text = await body()
          if (envOk) {
            checks.that('自检通过就直接进报告审核', text.includes('待审核报告'))
          } else {
            checks.that('自检不通过时停在环境自检页', text.includes('环境未通过'))
            checks.that('自检不通过时报告审核不出现', !text.includes('待审核报告'))
          }
        })

        // ── 第 6 条：环境自检页画真实探测结果（同时证明 Host→Client 链路） ──
        await phase('环境自检页', async () => {
          await lamp().click()
          await page.waitForTimeout(1500)
          const envText = await body()
          checks.that('环境自检显示真实平台', /darwin|linux|win32/.test(envText))
          checks.that('环境自检显示真实二进制路径', envText.includes('/Users/') || envText.includes('/usr/'))
          checks.that('环境自检显示氚云与钉钉服务行', envText.includes('氚云') && envText.includes('钉钉'))
          checks.that('环境自检显示 iFinD 密钥状态', envText.includes('iFinD'))
          checks.that('环境自检显示 OSS 回传配置', envText.includes('交付件回传'))
          checks.that('环境自检显示运行环境信息', envText.includes('运行环境信息'))
          // 审核子代理挂在哪必须可见：这是「子代理树挂在谁下面」的唯一说明。
          checks.that('运行环境信息里给出审核根会话', envText.includes('审核根会话'))
          checks.that('环境自检显示通过率与阻塞计数', envText.includes('已通过') && envText.includes('未通过'))
          // ① 只讲插件选定的案例根目录：不该因为"你从哪个会话点进来"而变样。
          checks.that('① 不拿当前会话说事（换会话不会变）', !envText.includes('不是同一个') && !envText.includes('的会话中打开工作台'))
          await page.screenshot({ path: join(out, 'env.png') })
        })

        // ── 重新自检也要有加载态（用户点下去到结论出来有好几秒）────────────────
        await phase('重新自检加载态', async () => {
          const recheck = page.getByRole('button', { name: '重新自检' }).first()
          if (await recheck.count() === 0) {
            checks.that('环境自检页有「重新自检」按钮', false)
            return
          }
          // 同翻页那条：把这一次 env 拖慢，让瞬态加载态变成确定性断言。
          await page.route('**/api/crwu-workbench**', async (route) => {
            const payload = route.request().postData() ?? ''
            if (payload.includes('"op":"env"')) await new Promise((resolve) => setTimeout(resolve, 3000))
            await route.continue()
          })
          await recheck.click()
          await page.waitForTimeout(900)
          checks.that('重新自检时出现加载进度条', await page.locator('.crwu-audit-load-bar').count() > 0)
          checks.that('重新自检时正文被压暗', await page.locator('.crwu-audit-dim').count() > 0)
          await page.screenshot({ path: join(out, 'env-loading.png') })
          await page.waitForTimeout(6000)
          await page.unroute('**/api/crwu-workbench**')
          // 别用固定等待：真机上 env 要跑二进制探测 + 氚云/钉钉 + 一次 OSS 实测，5~13 秒都可能。
          await page.waitForFunction(
            () => document.querySelectorAll('.crwu-audit-load-bar').length === 0,
            undefined,
            { timeout: 90_000 },
          ).catch(() => undefined)
          checks.that('重新自检结束后加载态收掉', await page.locator('.crwu-audit-load-bar').count() === 0)
        })

        // ── 第 7a 条：报告页画出真实氚云待办 ──────────────────────────────
        await phase('待审核报告页', async () => {
          if (!envOk) {
            // 不通过时的门禁：点「进入报告审核」应当被 loading 拦住，报告页不许出来。
            const entryButton = page.getByRole('button', { name: '进入报告审核' }).first()
            if (await entryButton.count() > 0) {
              await entryButton.click()
              await page.waitForTimeout(8000)
              const blockedText = await body()
              checks.that('不通过时点进去会被拦住（报告页不出现）', !blockedText.includes('待审核报告'))
              checks.that('拦住时给出明确说明', blockedText.includes('环境自检未通过'))
              await page.screenshot({ path: join(out, 'gate.png') })
            } else {
              checks.that('环境自检页存在「进入报告审核」入口', false, '按钮都没渲染出来')
            }
            return
          }
          // 从环境自检页回到报告审核（通过时这个按钮就是放行的）。
          const back = page.getByRole('button', { name: '进入报告审核' }).first()
          if (await back.count() > 0) {
            await back.click()
            await page.waitForTimeout(2000)
          }
          await page.getByRole('button', { name: /待审核报告/ }).last().click()
          // 氚云查询真机上十几秒是常态：等真正画出流水号（或明确报错）再断言，别用固定等待。
          await page.waitForFunction(
            (source) => new RegExp(source).test(document.body.innerText),
            SEQ.source,
            { timeout: 90_000 },
          ).catch(() => undefined)
          const pendingText = await body()
          checks.that('待审核报告画出真实流水号行', SEQ.test(pendingText))
          checks.that('待审核报告显示复核级次', pendingText.includes('初审'))
          // 风险等级要透出来：这一列是用户要求加的（真实取值 A/B/C）。
          checks.that('待审核报告有「风险等级」列', pendingText.includes('风险等级'))
          const risks = await page.$$eval(
            'td.crwu-audit-td-nowrap .crwu-audit-badge',
            (nodes) => nodes.map((node) => (node.textContent ?? '').trim()),
          )
          checks.that(
            '风险等级渲染成徽章（A/B/C 或占位 —）',
            risks.length > 0 && risks.every((text) => /^[ABC]$/.test(text) || text === '—'),
            risks.slice(0, 6).join(' / '),
          )
          // 列宽分工：流水号/风险/时间这几列一律不换行，否则会被从中间折断、挤成一团。
          checks.that(
            '窄列不换行（不再被折断）',
            await page.$$eval('td.crwu-audit-td-nowrap', (nodes) => nodes.length > 0
              && nodes.every((node) => getComputedStyle(node).whiteSpace === 'nowrap')),
          )
          await page.screenshot({ path: join(out, 'pending.png') })
        })

        // ── 「审核信息」抽屉：读一个**真实** OSS 对象并渲染摘要 ────────────
        // 这条盯的是第 26 轮修掉的那个缺陷：`ossutil` 把 `<n>(s) elapsed` 写到 stdout，
        // 严格 JSON.parse 必失败，界面上就是「审核信息」永远报「不是合法 JSON」。
        // 只有点开真实对象才能证明它真的好了。
        await phase('审核信息抽屉', async () => {
          const button = page.getByRole('button', { name: '审核信息' }).first()
          if (await button.count() === 0) {
            checks.that('存在可点开的「审核信息」入口', false, '当前没有已完成并上云的记录')
            return
          }
          const before = ops.filter((op) => op === 'oss-result').length
          await button.click()
          // 读一条真实对象要跑一次 ossutil（真机几秒到几十秒）：等「读到内容 / 明确报错」再断言。
          // 固定等待会假红，而且会连锁 —— 抽屉没关掉时它的遮罩会挡住后面所有点击。
          await page.waitForFunction(
            () => /项目编号|不是合法 JSON|没有审核结果 JSON/.test(document.body.innerText),
            undefined,
            { timeout: 90_000 },
          ).catch(() => undefined)
          const drawerText = await body()
          checks.that('点开审核信息会去读一个对象', ops.filter((op) => op === 'oss-result').length === before + 1)
          checks.that('抽屉不再报「不是合法 JSON」', !/不是合法 JSON/.test(drawerText))
          checks.that('抽屉渲染出摘要字段', ['项目编号', '问题总数', '结论', '阶段'].every((k) => drawerText.includes(k)))
          checks.that('抽屉里的项目编号是真值', SEQ.test(drawerText))
          checks.that('抽屉显示引擎版本', drawerText.includes('引擎版本'))

          // 审核信息必须是**右侧抽屉**：固定贴视口右边、占满高度、带遮罩。
          const viewport = page.viewportSize() ?? { width: 1500, height: 1100 }
          const panel = page.locator('[role="dialog"]').first()
          checks.that('有一个对话框角色的抽屉', await panel.count() > 0)
          const box = await panel.boundingBox().catch(() => null)
          checks.that(
            '抽屉贴在视口右侧',
            box !== null && box.x >= viewport.width / 2 && box.x + box.width >= viewport.width - 2,
            box === null ? '拿不到位置' : `x=${Math.round(box.x)} w=${Math.round(box.width)}`,
          )
          checks.that(
            '抽屉占满高度',
            box !== null && box.height >= viewport.height - 2,
            box === null ? '拿不到位置' : `h=${Math.round(box.height)}`,
          )
          checks.that('抽屉带遮罩', await page.locator('.crwu-audit-side-drawer-backdrop').count() === 1)

          const projectLine = page.getByText('项目编号', { exact: false }).first()
          const drawerVisible = (await projectLine.count()) > 0 && await projectLine.isVisible().catch(() => false)
          checks.that('抽屉内容真的可见（不是只在 DOM 里）', drawerVisible)
          if (drawerVisible) {
            await projectLine.scrollIntoViewIfNeeded()
            await page.waitForTimeout(500)
          }
          await page.screenshot({ path: join(out, 'drawer.png') })
          // 一定要把抽屉关掉：它的遮罩盖住整个视口，留着会让后续每个 click 都超时（踩过）。
          const closeButton = page.getByRole('button', { name: '关闭' }).first()
          if (await closeButton.count() > 0) await closeButton.click().catch(() => undefined)
          await page.waitForFunction(
            () => document.querySelectorAll('.crwu-audit-side-drawer-backdrop').length === 0,
            undefined,
            { timeout: 15_000 },
          ).catch(() => undefined)
          checks.that('关闭后抽屉与遮罩一起消失', await page.locator('.crwu-audit-side-drawer-backdrop').count() === 0)
          checks.that('关闭抽屉后回到列表', (await body()).includes('报告审核') || SEQ.test(await body()))
        })

        // ── 翻页不得重复列举 OSS（AGENTS.md §4.4 的硬要求） ────────────────
        await phase('翻页', async () => {
          const before = ossListings()
          const pendingBefore = ops.filter((op) => op === 'pending').length
          const next = page.getByRole('button', { name: '下一页' }).first()
          if (await next.count() === 0 || await next.isDisabled()) {
            checks.that('待审核报告有下一页可点', false, '只有一页，翻页这项无法验证')
            return
          }
          // 加载态是**瞬态**的：真机上 pending 可能几百毫秒就回来了，直接断言会变成看运气。
          // 这里把这一次 pending 人为拖慢，把「翻页时有加载态」变成确定性断言。
          await page.route('**/api/crwu-workbench**', async (route) => {
            const payload = route.request().postData() ?? ''
            if (payload.includes('"op":"pending"')) await new Promise((resolve) => setTimeout(resolve, 3000))
            await route.continue()
          })
          await next.click()
          await page.waitForTimeout(900)
          checks.that('翻页时出现加载进度条', await page.locator('.crwu-audit-load-bar').count() > 0)
          checks.that('翻页时列表被压暗（防手快连点）', await page.locator('.crwu-audit-dim').count() > 0)
          await page.screenshot({ path: join(out, 'paging-loading.png') })
          // 先等被拖慢的那次请求**回来**再撤路由：撤得太早，handler 里那句 continue() 会
          // 撞上「Route is already handled」，把一次验收变成一次崩溃。
          await page.waitForTimeout(6000)
          await page.unroute('**/api/crwu-workbench**')
          await page.waitForFunction(
            () => document.querySelectorAll('.crwu-audit-load-bar').length === 0,
            undefined,
            { timeout: 90_000 },
          ).catch(() => undefined)

          checks.that('翻页真的重新取了那一页', ops.filter((op) => op === 'pending').length > pendingBefore)
          checks.that('翻页不重复列举 OSS', ossListings() === before, `翻页前 ${before} 次、翻页后 ${ossListings()} 次`)
          checks.that('翻页结束后加载态收掉', await page.locator('.crwu-audit-load-bar').count() === 0)
          await page.screenshot({ path: join(out, 'page2.png') })
          // 翻回第一页，别把页面留在第 2 页影响后面的检查。
          const prev = page.getByRole('button', { name: '上一页' }).first()
          if (await prev.count() > 0 && !(await prev.isDisabled())) await prev.click()
          await page.waitForTimeout(2000)
        })

        // ── 切标签不得重复列举 OSS（README/AGENTS §4.4 的硬要求） ──────────
        await phase('标签切换', async () => {
          const before = ossListings()
          for (let i = 0; i < 3; i += 1) {
            await page.getByRole('button', { name: /AI审核结果/ }).first().click()
            await page.waitForTimeout(1200)
            await page.getByRole('button', { name: /待审核报告/ }).last().click()
            await page.waitForTimeout(1200)
          }
          checks.that(
            '来回切标签不重复列举 OSS',
            ossListings() === before,
            `切换前 ${before} 次、切换后 ${ossListings()} 次`,
          )
        })

        // ── AI审核结果页：真实云端对象 ────────────────────────────────────
        await phase('AI审核结果页', async () => {
          await page.getByRole('button', { name: /AI审核结果/ }).first().click()
          await page.waitForFunction(
            (source) => new RegExp(source).test(document.body.innerText),
            SEQ.source,
            { timeout: 90_000 },
          ).catch(() => undefined)
          checks.that('AI审核结果画出真实云端案例', SEQ.test(await body()))
          await page.screenshot({ path: join(out, 'results.png') })
        })

        // ── 「查看会话」：客户端服务晚注册时不许报「服务不可用」 ─────────────
        // 用户实测报过这一条：点「查看会话」得到「客户端 sessions 服务不可用」。根因是插件把
        // 可选客户端服务在 apply() 里快照成普通对象 —— 哪次激活顺序变一下，快照就永久是
        // undefined。这条断言盯两件事：那句话不许再出现；要么真把会话打开（主面板切走），
        // 要么给出**真实**原因（「打开子会话失败：…」）而不是把服务缺失当结论。
        await phase('查看会话', async () => {
          // 「查看会话」在**待审核报告**那一页的行操作里（它绑的是本地审核记录的 childId，
          // 而 AI审核结果那页是 OSS 上的云端对象，没有子会话）。所以先切回去。
          await page.getByRole('button', { name: /待审核报告/ }).last().click()
          await page.waitForFunction(
            (source) => new RegExp(source).test(document.body.innerText),
            SEQ.source,
            { timeout: 90_000 },
          ).catch(() => undefined)
          const openButton = page.getByRole('button', { name: '查看会话' }).first()
          if (await openButton.count() === 0) {
            checks.that('待审核报告里有「查看会话」入口', false, '这一页没有带 childId 的本地审核记录')
            return
          }
          await openButton.click()
          // 打开会话要等会话控制器把子会话拉进清单，别用固定等待充当结论。
          await page.waitForFunction(
            () => {
              const text = document.body.innerText
              return !text.includes('待审核报告') || text.includes('打开子会话失败') || text.includes('缺少父会话 id')
            },
            undefined,
            { timeout: 30_000 },
          ).catch(() => undefined)
          const text = await body()
          checks.that(
            '点「查看会话」不再报「客户端 sessions 服务不可用」',
            !text.includes('客户端 sessions 服务不可用'),
          )
          const leftWorkbench = !text.includes('待审核报告')
          const realError = /打开子会话失败|缺少父会话 id|该记录没有子会话 id/.test(text)
          checks.that(
            '点「查看会话」要么打开会话、要么给出真实原因',
            leftWorkbench || realError,
            text.slice(0, 120).replace(/\s+/g, ' '),
          )
          await page.screenshot({ path: join(out, 'open-session.png') })
          // 打开会话会把主面板切到会话，后面的检查还要用工作台，所以从侧栏再进一次。
          if (leftWorkbench) {
            await entry.click()
            await lamp().waitFor({ state: 'visible', timeout: 30_000 })
            await page.waitForTimeout(1500)
          }
        })

        // ── 切回环境自检仍然正常（状态没被弄坏） ──────────────────────────
        await phase('切回环境自检', async () => {
          if (!envOk) return
          await lamp().click()
          await page.waitForTimeout(3000)
          checks.that('切回环境自检仍然正常渲染', (await body()).includes('命令行工具与运行时'))
        })
      }
    }

    checks.that('浏览器控制台没有报错', consoleErrors.length === 0, consoleErrors.join(' | '))
    // 硬约束：只读验收，绝不能碰到审核发起。
    checks.that('全程没有发出 audit-start', !ops.includes('audit-start'), '脚本不该点「AI 审核」')
  } finally {
    await browser.close()
  }

  console.log(`ops：${[...new Set(ops)].join(' ')}`)
  console.log(`通过 ${checks.passed.length} 条`)
  for (const name of checks.passed) console.log(`  OK   ${name}`)
  for (const name of checks.failures) console.log(`  FAIL ${name}`)
  console.log(`截图：${out}`)
  if (checks.failures.length > 0) process.exitCode = 1
}

await main()
