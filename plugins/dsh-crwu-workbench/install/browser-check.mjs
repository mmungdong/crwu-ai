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
  // 侧栏底部（Settings 上方）常驻的工作台入口。环境结论就写在它右端那枚标记上：
  // 通过 = 绿勾，不通过 = 红点。它常年可见，所以「环境行不行」随时问得到。
  const entry = () => page.locator('.crwu-audit-side-card').first()
  const envMark = () => entry().locator('.crwu-audit-side-entry-mark').first()
  /** 侧栏分组卡上的一行子项（报告评估 / 报告审核 / 环境信息）。 */
  const moduleButton = (label) => entry().locator('.crwu-audit-module').filter({ hasText: label }).first()
  const ossListings = () => ops.filter((op) => op === 'oss-index').length
  /** 列表的"上下文"（关抽屉前后必须逐字相同）：当前页签 + 页码 + 搜索框内容 + 滚动位置。 */
  const listContext = async () => {
    const tab = await page.locator('.crwu-audit-tab-on').first().innerText().catch(() => '')
    const pageNo = await page.locator('.crwu-audit-pager-page-on').first().innerText().catch(() => '')
    const query = await page.locator('.crwu-audit-search input').first().inputValue().catch(() => '')
    const scroll = await page.locator('.crwu-audit-pane-main').first().evaluate((node) => Math.round(node.scrollTop)).catch(() => -1)
    return { tab: tab.replace(/\s+/g, ' ').trim(), pageNo: pageNo.trim(), query, scroll }
  }
  /** 技术详情里有没有引擎版本那一行（标签来自 locales，这里只认"引擎版本"字样）。 */
  const techIncludesEngine = (text) => /引擎版本/.test(text)

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

    // ── 第 5 条：侧栏底部入口出现 ──────────────────────────────────────────
    const hasEntry = await phase('侧栏底部出现「中瑞世联工作台」入口', async () => {
      await entry().waitFor({ state: 'visible', timeout: 45_000 })
      const text = await entry().innerText()
      checks.that('侧栏底部入口写着工作台名字', text.includes('中瑞世联工作台'), text)
      // 「常驻在侧栏下方」是可观察的几何事实，不是文案：入口必须在左列、且落在下半屏。
      const box = await entry().boundingBox()
      const viewport = await page.evaluate(() => window.innerHeight)
      checks.that('入口在左侧栏（不是中间/右侧）', box !== null && box.x < 240, `x=${String(box?.x)}`)
      checks.that('入口常驻在侧栏下方', box !== null && box.y > viewport / 2, `y=${String(box?.y)} 视口=${String(viewport)}`)
      checks.that('入口右端有环境标记', await envMark().count() > 0)
      // 卡头是纯标题，不是第四个可选项（用户口径：「中瑞世联工作台这个本身不应该能选中」）。
      const head = await entry().locator('.crwu-audit-side-card-head').evaluate((node) => ({
        tag: node.tagName,
        cursor: getComputedStyle(node).cursor,
      }))
      checks.that(
        '卡头不是可点控件（div + 不是手型光标）',
        head.tag === 'DIV' && head.cursor !== 'pointer',
        JSON.stringify(head),
      )
      checks.passed.push('侧栏底部出现「中瑞世联工作台」入口')
    })
    if (!hasEntry) {
      // 面板都没出现，后面的检查没有意义 —— 但上面的失败已经记录了。
      await page.screenshot({ path: join(out, 'no-panel.png') })
    } else {
      // 第一次进面板要跑一轮环境自检（包内组件 / DSH 运行时 / 登录态 / OSS / 外部数据），这几秒里正文
      // 应该只有那一页统一等待页。它是**瞬态**的（真机上几秒），所以把这一次 env 拖慢，
      // 把「有没有统一等待页」变成确定性断言 —— 与后面「重新自检加载态」同一条手法。
      await page.route('**/api/crwu-workbench**', async (route) => {
        const payload = route.request().postData() ?? ''
        if (payload.includes('"op":"env"')) await new Promise((resolve) => setTimeout(resolve, 3500))
        await route.continue()
      })
      await entry().click()
      await phase('首次进入是统一的等待页（品牌标记 + 进度条）', async () => {
        const pane = page.locator('.crwu-audit-loading-pane').first()
        await pane.waitFor({ state: 'visible', timeout: 20_000 })
        const text = (await pane.innerText()).replace(/\s+/g, ' ')
        checks.that('等待页有「正在自检环境」', text.includes('正在自检环境'), text)
        checks.that('等待页有一句在等什么的说明', text.includes('正在检查'), text)
        // 「好看的 svg」：等待页里那枚品牌标记（四个色块）在，而且真的挂着动画。
        const mark = await pane.evaluate((node) => {
          const svg = node.querySelector('svg')
          if (svg === null) return null
          const polygons = [...svg.querySelectorAll('polygon')]
          const animation = getComputedStyle(polygons[0]).animationName
          const box = svg.getBoundingClientRect()
          return { polygons: polygons.length, animation, size: `${Math.round(box.width)}x${Math.round(box.height)}` }
        })
        checks.that(
          '等待页用的是品牌标记（4 个色块）且带呼吸动画',
          mark !== null && mark.polygons === 4 && mark.animation !== 'none',
          JSON.stringify(mark),
        )
        checks.that('等待页底部有不确定进度条', await pane.locator('.crwu-audit-load-bar').count() === 1)
        await page.screenshot({ path: join(out, 'first-loading.png') })
        // 等它自己收掉（那说明被拖慢的 env 回来了、面板已切到该在的那一页）再撤路由，
        // 撤早了 handler 里的 continue() 会撞上「Route is already handled」。
        await page.waitForFunction(
          () => document.querySelector('.crwu-audit-loading-pane') === null,
          undefined,
          { timeout: 90_000 },
        ).catch(() => undefined)
        await page.unroute('**/api/crwu-workbench**')
      })
      // 打开面板后**没有**页内「环境自检」标签页了：三个模块由侧栏那张分组卡上的子项切换，
      // 自检期间显示统一等待页，出结论后要么直接进报告审核（通过），要么停在环境信息（不通过）。
      let envOk = false
      const opened = await phase('点进去后工作台渲染出面板头，自检结论落到侧栏标记上', async () => {
        await page.locator('.crwu-audit-version').first().waitFor({ state: 'visible', timeout: 30_000 })
        // 自检要跑 shell 与网络（探二进制、问氚云/钉钉、列一次 OSS），给足时间；等的是
        // **侧栏子项上那枚标记的结论色**，不是正文里那句话：自检一旦通过，面板会直接跳到
        // 「报告审核」，带「环境就绪」字样的环境信息页只是一闪而过（常常根本不出现）——
        // 靠它等结论是概率性的，之前就在这里假失败过一次。
        await page.waitForFunction(() => {
          const mark = document.querySelector('.crwu-audit-side-card .crwu-audit-side-entry-mark')
          if (mark === null) return false
          const cls = String(mark.className)
          return cls.includes('crwu-audit-side-entry-mark-ok') || cls.includes('crwu-audit-side-entry-mark-bad')
        }, undefined, { timeout: 120_000 })
        checks.passed.push('点进去后工作台渲染出面板头，自检结论落到侧栏标记上')
      })
      if (opened) {
        // ── 侧栏入口上的环境标记：绿=通过（对勾）、红=不通过，颜色必须与结论一致 ──
        await phase('侧栏入口上的环境标记', async () => {
          const classes = String(await envMark().getAttribute('class') ?? '')
          const ok = classes.includes('crwu-audit-side-entry-mark-ok')
          const bad = classes.includes('crwu-audit-side-entry-mark-bad')
          envOk = ok
          checks.that('环境标记有结论色（绿或红）', ok || bad, `class=${classes}`)
          checks.that('环境标记颜色与自检结论一致', ok !== bad, `绿=${String(ok)} 红=${String(bad)}`)
          // 用户要的是「环境通过时后面有个正常工作的标志」，2026-09-22 又要求重新设计观感：
          // 现在是 iOS 设置风的小圆徽标 = 实心状态色圆底 + 白字形。这里量真实计算样式。
          if (ok) {
            const badge = await envMark().evaluate((node) => {
              const style = getComputedStyle(node)
              return {
                radius: style.borderRadius,
                bg: style.backgroundColor,
                ink: style.color,
                glyph: node.querySelector('svg') !== null,
              }
            })
            checks.that(
              '通过时是实心绿圆徽标 + 白勾',
              badge.radius === '50%' && badge.bg !== 'rgba(0, 0, 0, 0)'
                && badge.ink === 'rgb(255, 255, 255)' && badge.glyph,
              JSON.stringify(badge),
            )
          }
          const title = String(await entry().getAttribute('title') ?? '')
          checks.that('入口悬停文案给出环境结论', /环境信息：(已通过|未通过|自检中|尚未自检)/.test(title), title)
          await page.screenshot({ path: join(out, 'sidebar-entry.png') })
        })

        // ── 侧栏那张分组卡：一个模块 + 三个子项（报告评估 / 报告审核 / 环境信息） ──
        await phase('侧栏分组卡', async () => {
          const rows = entry().locator('.crwu-audit-module')
          const count = await rows.count()
          checks.that('分组卡上三个子项都在', count === 3, `找到 ${String(count)} 行`)
          const cardText = await entry().innerText()
          checks.that(
            '三个子项就是报告评估 / 报告审核 / 环境信息，且顺序固定',
            /报告评估[\s\S]*报告审核[\s\S]*环境信息/.test(cardText),
            cardText.replace(/\s+/g, ' '),
          )
          // 「开发中」是一枚**灰色小 tag**（用户 2026-09-22 先要图标、看过之后又改回文字标签：
          // 「那个 svg 不要了，太难看了，加一个灰色的小 tag【开发中】」）。
          const devTag = moduleButton('报告评估').locator('.crwu-audit-module-tag')
          checks.that(
            '还没开发的子项挂着一枚「开发中」小标签',
            await devTag.count() === 1 && (await devTag.innerText()).trim() === '开发中',
            (await devTag.innerText().catch(() => '')).trim(),
          )
          checks.that('那枚标签里没有图标（只要文字）', await devTag.locator('svg').count() === 0)
          // 「看起来是一个模块」的可观察判据：三行子项都落在**同一张卡**的几何范围内，
          // 而且是上下叠着排的 —— 不是三个各占一行的独立入口。
          const cardBox = await entry().boundingBox()
          const rowBoxes = await rows.evaluateAll((nodes) => nodes.map((node) => {
            const rect = node.getBoundingClientRect()
            return { x: rect.x, y: rect.y, w: rect.width, h: rect.height }
          }))
          checks.that(
            '三行子项都在同一张卡里（像一个模块，不是三个入口）',
            cardBox !== null && rowBoxes.length === 3
              && rowBoxes.every((row) => row.x >= cardBox.x - 1 && row.x + row.w <= cardBox.x + cardBox.width + 1),
            JSON.stringify({ card: cardBox, rows: rowBoxes }),
          )
          checks.that(
            '三行子项自上而下排列',
            rowBoxes.length === 3 && rowBoxes[0].y < rowBoxes[1].y && rowBoxes[1].y < rowBoxes[2].y,
            JSON.stringify(rowBoxes),
          )
          // 入口只有这一处：面板里不再有自己的模块条（`.crwu-audit-module` 总数 = 卡上这三行）。
          const all = await page.locator('.crwu-audit-module').count()
          checks.that('模块入口只在侧栏那一处（面板里不再有模块条）', all === count, `全页 ${String(all)} 处 / 卡上 ${String(count)} 行`)
          // 报告评估：点得开，但整页只写「开发中」；同时那一行要变成选中态。
          await moduleButton('报告评估').click()
          await page.waitForTimeout(500)
          const evalBodyText = await body()
          // 用户 2026-09-22 口径：「该页面整体写一个开发中就可以了」——
          // 所以占位页正文**只有这四个字**，先前那些说明与计划事项都不该再出现。
          // 报告评估是一页**正式的 Coming Soon**（用户 2026-09-22 重新设计）：
          // 模块名 / 一句将来做什么 / 最短说明 / `● 开发中` 状态 / 去报告审核的路；
          // 不编功能清单、不做假进度、不写营销语。
          const evalPaneText = (await page.locator('.crwu-audit-eval').innerText()).replace(/\s+/g, ' ')
          checks.that(
            '报告评估是 Coming Soon（模块名 + 将来做什么 + 说明 + 状态）',
            evalPaneText.includes('报告评估') && evalPaneText.includes('AI 辅助资产评估工作流')
              && evalPaneText.includes('正在开发中') && evalPaneText.includes('开发中'),
            evalPaneText.slice(0, 120),
          )
          checks.that('报告评估给出下一步：去「报告审核」', evalPaneText.includes('报告审核'))
          checks.that('报告评估不编功能清单 / 不造假进度', !/[0-9]+%|进度|敬请期待/.test(evalPaneText))

          checks.that('报告评估不画报告列表', !evalBodyText.includes('报告列表'))
          // 「报告审核」旁边不再标具体报告数（用户 2026-09-22 口径），那一行只有名字。
          const auditRowText = (await moduleButton('报告审核').innerText()).replace(/\s+/g, '')
          checks.that('报告审核旁边不标报告数', auditRowText === '报告审核', JSON.stringify(auditRowText))
          const evalClass = String(await moduleButton('报告评估').getAttribute('class') ?? '')
          checks.that('点过的子项是选中态', evalClass.includes('crwu-audit-module-on'), evalClass)
          // 环境标记**只属于「环境信息」那一行**（用户 2026-09-22：其余子项右侧的绿勾去掉）。
          const marksPerRow = await rows.evaluateAll((nodes) => nodes.map(
            (node) => node.querySelector('.crwu-audit-side-entry-mark') !== null,
          ))
          checks.that(
            '环境标记只长在「环境信息」那一行',
            JSON.stringify(marksPerRow) === JSON.stringify([false, false, true]),
            JSON.stringify(marksPerRow),
          )
          checks.that(
            '整页只有那一枚环境标记（别的子项右侧留空）',
            await page.locator('.crwu-audit-side-card .crwu-audit-side-entry-mark').count() === 1,
          )
          // 悬停与选中的底色必须一眼分得开（用户报过「悬停别的子项时和激活那条一样」）：
          // 这里量的是**真实计算样式**，不是文案或类名。
          const readBg = (locator) => locator.evaluate((node) => getComputedStyle(node).backgroundColor)
          const evalRow = moduleButton('报告评估')
          const auditRow = moduleButton('报告审核')
          const onBg = await readBg(evalRow)
          await auditRow.hover()
          const hoverBg = await readBg(auditRow)
          await evalRow.hover()
          const onHoverBg = await readBg(evalRow)
          await page.mouse.move(4, 4)
          checks.that(
            '悬停别的子项时底色与选中那条不同',
            hoverBg !== onBg,
            `悬停=${hoverBg} 选中=${onBg}`,
          )
          checks.that(
            '悬停选中那条不会把它的选中底色换掉',
            onHoverBg === onBg,
            `悬停选中=${onHoverBg} 选中=${onBg}`,
          )
          await page.screenshot({ path: join(out, 'sidebar-modules.png') })
        })

        // ── 收起侧栏（56px 轨道）：只留品牌标记，不画环境标记 ──────────────
        // 用户 2026-09-22 口径：「左侧栏收起来的时候不应展示绿色的标记」。轨道是"入口"不是"状态牌"，
        // 常亮的绿勾收起来后只是噪音；结论不丢 —— 仍然写在按钮的 title 上，悬停可读。
        await phase('收起侧栏后轨道上不画环境标记', async () => {
          // DSH 侧栏自带的收起 / 展开按钮，靠 aria-label 认（文案来自 DSH 的 zh-CN 语言包）。
          await page.locator('button[aria-label="收起侧边栏"]').first().click()
          const rail = page.locator('.crwu-audit-side-entry-rail').first()
          await rail.waitFor({ state: 'visible', timeout: 20_000 })
          const svgCount = await rail.locator('svg').count()
          checks.that('轨道上只剩下品牌标记这一枚图形', svgCount === 1, `svg=${String(svgCount)}`)
          checks.that(
            '收起后不再画环境标记（那枚绿勾也没有）',
            await rail.locator('.crwu-audit-side-entry-mark').count() === 0,
          )
          const railTitle = String(await rail.getAttribute('title') ?? '')
          checks.that(
            '轨道按钮的悬停文案仍给出环境结论（结论没丢）',
            /环境信息：(已通过|未通过|自检中|尚未自检)/.test(railTitle),
            railTitle,
          )
          await page.screenshot({ path: join(out, 'sidebar-rail.png') })
          // 还原成展开态：后面所有断言都建立在分组卡上。
          await page.locator('button[aria-label="打开侧边栏"]').first().click()
          await entry().waitFor({ state: 'visible', timeout: 20_000 })
          checks.that('再展开又回到那张分组卡', await entry().locator('.crwu-audit-module').count() === 3)
        })

        // ── 浮层：DeepSeek Tooltip + 操作列 ••• 菜单（同一套 Floating Layer）──────
        await phase('浮层：Tooltip 与 ••• 菜单', async () => {
          // 这一段自带前置：清掉上一段可能留下的浮层/Dialog，并确保站在**报告列表**上。
          await page.keyboard.press('Escape')
          await page.locator('.crwu-audit-page-title').first().click().catch(() => undefined)
          await page.getByRole('button', { name: /报告列表/ }).last().click().catch(() => undefined)
          await page.waitForTimeout(300)
          const firstRow = page.locator('.crwu-audit-tbody-row').first()
          await firstRow.waitFor({ state: 'visible', timeout: 30_000 })
          const rowHeightBefore = (await firstRow.boundingBox().catch(() => null))?.height ?? 0
          // 1) 悬停小鲸鱼 → 立刻出现浮层 Tooltip（带箭头、不在表格里、不改变行高）
          await firstRow.locator('.crwu-audit-ai-row-btn').first().hover()
          const tip = page.locator('.crwu-audit-float-tip').first()
          await tip.waitFor({ state: 'visible', timeout: 5_000 })
          checks.that('悬停小鲸鱼立刻出现 Tooltip', await tip.count() === 1)
          checks.that('Tooltip 带箭头', await tip.locator('.crwu-audit-float-arrow').count() === 1)
          checks.that(
            'Tooltip 渲染在表格之外（不被滚动容器裁切）',
            await page.locator('.crwu-audit-table-wrap .crwu-audit-float-tip').count() === 0,
          )
          const tipBox = await tip.boundingBox().catch(() => null)
          const whaleBox = await firstRow.locator('.crwu-audit-ai-row-btn').first().boundingBox().catch(() => null)
          checks.that(
            'Tooltip 在按钮上方、间距 6–14px',
            tipBox !== null && whaleBox !== null && whaleBox.y - (tipBox.y + tipBox.height) >= 6
              && whaleBox.y - (tipBox.y + tipBox.height) <= 14,
            JSON.stringify({ tip: tipBox, whale: whaleBox }),
          )
          checks.that(
            '浮层不改变行高',
            Math.abs(((await firstRow.boundingBox().catch(() => null))?.height ?? 0) - rowHeightBefore) < 0.5,
          )
          await page.screenshot({ path: join(out, 'float-tip.png') })
          await page.mouse.move(4, 4)

          // 2) ••• 菜单：真正的浮层（不在表格里）、唯一打开、行保持 selected
          const menuButtons = page.locator('.crwu-audit-tbody-row .crwu-audit-menu')
          const total = await menuButtons.count()
          if (total === 0) {
            checks.passed.push('当前列表没有带次级动作的行（••• 浮层这段跳过）')
            return
          }
          const withMenu = page.locator('.crwu-audit-tbody-row').filter({ has: page.locator('.crwu-audit-menu') })
          const rowA = withMenu.nth(0)
          const rowB = withMenu.nth(total > 1 ? 1 : 0)
          await rowA.locator('.crwu-audit-menu').first().click()
          const menu = page.locator('.crwu-audit-float-menu').first()
          await menu.waitFor({ state: 'visible', timeout: 5_000 })
          checks.that('点 ••• 出现浮层菜单（role=menu）', await menu.getAttribute('role') === 'menu')
          checks.that('菜单项是 menuitem 且非空', await menu.locator('[role="menuitem"]').count() >= 1)
          checks.that(
            '菜单渲染在表格之外（不被 overflow 裁切）',
            await page.locator('.crwu-audit-table-wrap .crwu-audit-float-menu').count() === 0,
          )
          checks.that(
            '••• 按钮处于展开态（aria-expanded）',
            String(await rowA.locator('.crwu-audit-menu').first().getAttribute('aria-expanded')) === 'true',
          )
          checks.that(
            '开菜单那一行保持 selected',
            String(await rowA.getAttribute('class') ?? '').includes('crwu-audit-tbody-row-on'),
          )
          const menuBox = await menu.boundingBox().catch(() => null)
          const btnBox = await rowA.locator('.crwu-audit-menu').first().boundingBox().catch(() => null)
          checks.that(
            '菜单右边缘与 ••• 对齐、间距 6–14px',
            menuBox !== null && btnBox !== null && Math.abs((btnBox.x + btnBox.width) - (menuBox.x + menuBox.width)) <= 8
              && menuBox.y - (btnBox.y + btnBox.height) >= 6 && menuBox.y - (btnBox.y + btnBox.height) <= 14,
            JSON.stringify({ menu: menuBox, btn: btnBox }),
          )
          await page.screenshot({ path: join(out, 'float-menu.png') })

          // 3) 全页同时只允许一个菜单（切到另一行时上一行自动关）
          if (total > 1) {
            await rowB.locator('.crwu-audit-menu').first().click()
            await page.waitForTimeout(260)
            checks.that('切到另一行后仍只有一个浮层菜单', await page.locator('.crwu-audit-float-menu').count() === 1)
            checks.that(
              '上一行不再保持 selected',
              !String(await rowA.getAttribute('class') ?? '').includes('crwu-audit-tbody-row-on'),
            )
          }
          // 4) Escape 关闭
          await page.keyboard.press('Escape')
          await page.waitForFunction(
            () => document.querySelector('.crwu-audit-float-menu') === null,
            undefined,
            { timeout: 5_000 },
          ).catch(() => undefined)
          checks.that('Escape 关闭菜单', await page.locator('.crwu-audit-float-menu').count() === 0)
          // 5) 点外部关闭
          await rowA.locator('.crwu-audit-menu').first().click()
          await page.waitForTimeout(200)
          await page.locator('.crwu-audit-page-title').first().click()
          await page.waitForTimeout(220)
          checks.that('点击外部关闭菜单', await page.locator('.crwu-audit-float-menu').count() === 0)
          // 6) 滚动列表关闭
          if ((await rowA.locator('.crwu-audit-menu').count()) > 0) {
            await rowA.locator('.crwu-audit-menu').first().click()
            await page.waitForTimeout(200)
            await page.locator('.crwu-audit-pane-main').first().evaluate((node) => { node.scrollTop = node.scrollTop + 60 })
            await page.waitForTimeout(220)
            checks.that('滚动列表关闭浮层', await page.locator('.crwu-audit-float-menu').count() === 0)
          }
        })

        // ── 自检只跑一次：切页、关掉再打开都不重跑 ────────────────────────
        // 用户 2026-09-22 口径：「这个钉钉 cli 环境监测一遍就可以了，不需要每次切换页面都去调，
        // 本质就是从环境信息把这个人的信息拿到」。所以这里量的是**真实请求次数**。
        await phase('自检只跑一次（切页 / 关掉再打开都不重跑）', async () => {
          const envCalls = () => ops.filter((op) => op === 'env').length
          const before = envCalls()
          checks.that('进面板只跑过一次自检', before === 1, `env ${String(before)} 次`)
          for (const label of ['报告审核', '环境信息', '报告评估']) {
            await moduleButton(label).click()
            await page.waitForTimeout(400)
          }
          checks.that('切模块不重跑自检', envCalls() === before, `env ${String(before)} → ${String(envCalls())}`)
          // 关掉面板（点侧栏「新会话」把主面板切走）再点回工作台：面板会重新挂载。
          await page.locator('button:has-text("新会话")').first().click()
          await page.waitForTimeout(800)
          await moduleButton('报告评估').click()
          await page.waitForTimeout(800)
          checks.that(
            '关掉再打开面板也不重跑自检',
            envCalls() === before,
            `env ${String(before)} → ${String(envCalls())}`,
          )
          checks.that('全程没有 whoami 这个操作（身份跟着自检走）', !ops.includes('whoami'), ops.join(','))
        })

        // ── 选中会话之后，工作台不许还高亮着 ──────────────────────────────
        // 用户 2026-09-22 报的 bug：在左侧栏点开自己的会话之后，工作台那张卡里上一次那个子项
        // 还亮着，看起来像工作台还在前台。选中态只认「工作台面板正开着」。
        await phase('选中会话时工作台不再高亮', async () => {
          const selected = () => page.locator('.crwu-audit-side-card .crwu-audit-module-on').count()
          checks.that('前置条件：工作台面板开着时有一行选中', await selected() === 1, `选中 ${String(await selected())} 行`)
          // 用 `button:has-text` 而不是 `getByRole('button', { name: /新会话/ })`：实测后者在
          // 这个侧栏按钮上匹配不到（可访问名取不到），而前者稳。
          const newChat = page.locator('button:has-text("新会话")').first()
          if (await newChat.count() === 0) {
            checks.that('侧栏里有「新会话」入口', false, '没找到新会话按钮，无法验证')
            return
          }
          await newChat.click()
          await page.waitForFunction(
            () => document.querySelector('.crwu-audit-side-card .crwu-audit-module-on') === null,
            undefined,
            { timeout: 20_000 },
          ).catch(() => undefined)
          checks.that('选中会话之后那一行不再高亮', await selected() === 0, `还有 ${String(await selected())} 行亮着`)
          checks.that(
            '选中会话之后整张卡也不再是选中态',
            await page.locator('.crwu-audit-side-card.crwu-audit-side-card-on').count() === 0,
          )
          await page.screenshot({ path: join(out, 'session-selected.png') })
          // 点回工作台：记忆还在（先前停在报告评估），而且重新亮起来。
          await moduleButton('报告评估').click()
          await page.waitForTimeout(800)
          checks.that('点回工作台后重新高亮', await selected() === 1, `选中 ${String(await selected())} 行`)
        })

        // ── 品牌标记 + 「dev 还是具体版本」标签 ───────────────────────────────
        await phase('品牌标记与版本标签', async () => {
          // 侧栏入口与面板头部那枚图形必须是品牌标记（四个色块），不是通用图标。
          checks.that('侧栏入口画的是品牌标记（4 个色块）', await entry().locator('svg polygon').count() === 4)
          checks.that('面板头部也画了品牌标记', await page.locator('.crwu-audit-header svg polygon').count() === 4)
          // 头部右侧那一格：永远是「问候，姓名」，姓名来自宿主的钉钉 CLI（`whoami`）。
          // 等一下 whoami（一次 dws 冷启动），别用固定等待当结论。
          await page.waitForFunction(
            () => /(凌晨好|早上好|上午好|中午好|下午好|晚上好)，\S+/.test(document.querySelector('.crwu-audit-header')?.textContent ?? ''),
            undefined,
            { timeout: 60_000 },
          ).catch(() => undefined)
          const headerText = (await page.locator('.crwu-audit-header').innerText()).replace(/\s+/g, ' ')
          checks.that(
            '头部右侧是「问候，姓名」（姓名来自钉钉 CLI）',
            /(凌晨好|早上好|上午好|中午好|下午好|晚上好)，\S+/.test(headerText),
            headerText,
          )
          // 模块名从头部去掉了：在哪一页由侧栏那张分组卡的高亮说了算。
          checks.that(
            '头部不再显示模块名',
            !/报告评估|报告审核|环境信息/.test(headerText),
            headerText,
          )
          // 背景水印试过一版（超大单色 logo + 「中瑞世联」字样），用户看过之后决定不要：
          // 「算了不要背景色这个标记了」。这里钉住它不许回来。
          checks.that(
            '页面背景不再画水印',
            await page.locator('.crwu-audit-watermark').count() === 0
              && await page.locator('.crwu-audit-watermark-text').count() === 0,
          )
          const chip = page.locator('.crwu-audit-version').first()
          checks.that('名字/标题旁有版本标签', await chip.count() > 0)
          const text = (await chip.innerText().catch(() => '')).trim()
          // 用户口径：要么写 dev（本地源码检出），要么写他直接安装的那个具体版本。
          checks.that('标签写的是 dev 或具体版本号', /^(dev|v\d+\.\d+\.\d+|未知)$/.test(text), text)
          const title = String(await chip.getAttribute('title') ?? '')
          checks.that('悬停说清运行形态', /本地源码检出|已安装的插件包|还没问过宿主/.test(title), title)
          await page.screenshot({ path: join(out, 'brand.png') })
        })

        // ── **全局环境门禁**：所有入口走同一条导航，被拦时落到环境页 ────────
        //
        // 用户口径：「把门禁从 WorkbenchPanel 的 audit 页面特判上提到统一导航层」。
        // 这里用 `page.route` 把环境应答**人为降级**（只有 iFinD 缺失 → degraded），
        // 再把环境应答本身也改写成"阻塞"，把瞬态的门禁行为变成确定性断言。
        // 全程**不点「AI 审核」**，末尾那条「没有 audit-start」的断言照旧成立。
        await phase('全局环境门禁', async () => {
          const blockedEnv = (body) => {
            const json = JSON.parse(body)
            if (json.state === undefined) return body
            json.state = {
              ...json.state,
              status: 'action-required',
              proceed: false,
              allOk: false,
              capabilities: { global: false, auditCore: false, delivery: true, externalData: true },
              issues: [{ id: 'workspace', owner: 'user', blocking: true, scope: 'global', action: '选择案例根目录', message: '未找到工作空间，请手动选择' }],
              blocked: ['未找到工作空间，请手动选择'],
            }
            return JSON.stringify(json)
          }
          await page.route('**/api/crwu-workbench**', async (route) => {
            const payload = route.request().postData() ?? ''
            if (!payload.includes('"op":"env"')) { await route.continue(); return }
            const response = await route.fetch()
            const body = await response.text()
            await route.fulfill({ response, body: blockedEnv(body) })
          })
          // 触发一次重新检查，让被改写的应答生效。
          const recheck = page.getByRole('button', { name: /重新检查|重新自检/ }).first()
          if (await recheck.count() > 0) await recheck.click()
          await page.waitForTimeout(1500)
          // 环境不通过时点「报告审核」：不许进入目标页。
          await moduleButton('报告审核').click()
          await page.waitForTimeout(800)
          const afterBlocked = await body()
          checks.that('环境不通过时点报告审核，不进入报告页', !afterBlocked.includes('报告列表'), afterBlocked.slice(0, 120))
          checks.that('被拦住时落到环境页', afterBlocked.includes('账号连接'))
          checks.that('被拦住时显示目标页名', /进入【报告审核】前/.test(afterBlocked), afterBlocked.slice(0, 160))
          checks.that('被拦住时给出「重新检查」', await page.getByRole('button', { name: /重新检查|重新自检/ }).count() > 0)
          await page.screenshot({ path: join(out, 'env-gate-blocked.png') })
          // 环境页**始终可进**。
          await moduleButton('环境信息').click()
          await page.waitForTimeout(500)
          checks.that('环境页始终可进', (await body()).includes('账号连接'))
          // 撤掉改写：再检查一次就该恢复（并通过 pendingTarget 自动回到报告审核）。
          await page.unroute('**/api/crwu-workbench**')
          const recheckAgain = page.getByRole('button', { name: /重新检查|重新自检/ }).first()
          if (await recheckAgain.count() > 0) await recheckAgain.click()
          await page.waitForFunction(
            () => document.body.innerText.includes('报告列表'),
            undefined,
            { timeout: 60_000 },
          ).catch(() => undefined)
          checks.that('检查通过后自动继续到刚才被拦的目标页', (await body()).includes('报告列表'))
          await page.screenshot({ path: join(out, 'env-gate-recovered.png') })
        })

        // ── 门禁：通过就直接进报告审核；不通过必须停在环境信息 ────────────
        await phase('自检门禁', async () => {
          // 上一步把模块切到了「报告评估」，这里按结论回到该在的那一页再断言。
          await moduleButton(envOk ? '报告审核' : '环境信息').click()
          await page.waitForTimeout(1200)
          const text = await body()
          if (envOk) {
            checks.that('自检通过就直接进报告审核', text.includes('报告列表'))
          } else {
            // 不通过时的文案在顶部状态卡里（「还需完成 N 项」/ 系统故障那句），不再有旧的
            // 「环境未通过」大标题。
            checks.that('自检不通过时停在环境信息', /还需完成 \d+ 项|发现系统故障|环境检查没有完成/.test(text), text.slice(0, 160))
            checks.that('自检不通过时报告审核不出现', !text.includes('报告列表'))
          }
        })

        // ── 第 6 条：环境信息 = 紧凑状态摘要 + 引导式配置工作区（证明 Host→Client 链路） ──
        //
        // 页面结构（2026-09-26 重排，读者是普通员工）：
        // 1. 顶部**状态摘要**：一句结论 + 已完成 N/N + 最近检查 / 最近**真实验证**时间 +
        //    **唯一**主动作「重新检查」（**没有**「进入报告审核」按钮）；
        // 2. **配置工作区**：左侧步骤导航（1 账号连接 / 2 阿里云 OSS / 3 iFinD / 4 工作空间，
        //    各带已完成 / 待处理），右侧当前步骤的用途说明 + 表单；
        // 3. **维护者诊断**（默认收起）：包内组件 / DSH Runtime / 平台 / Tool 可见性 + 技术细节。
        //
        // 三条不许回退的边界：员工视野里没有「安装二进制 / 装 Python / 改 PATH」；
        // 技术细节只在维护者诊断里；密钥只提交、不回显。
        await phase('环境信息页', async () => {
          await moduleButton('环境信息').click()
          await page.waitForTimeout(1500)
          const envText = await body()
          checks.that('顶部状态摘要给出结论', /环境已就绪|还需完成 \d+ 项|需要管理员处理|发现系统故障|环境检查没有完成|正在检查环境/.test(envText))
          checks.that('摘要给出完成数量与最近验证时间', /\d+\/\d+/.test(envText) && /最近检查|最近真实验证/.test(envText))
          // **顶部没有「进入报告审核」按钮**（用户口径：只做提示，跳转走左侧栏）。
          const enterButtons = await page.getByRole('button', { name: '进入报告审核' }).count()
          checks.that('顶部不再有「进入报告审核」按钮', enterButtons === 0, `实际 ${String(enterButtons)} 个`)
          // 就绪时只给一句提示（那句话里允许出现"报告审核"四个字，但不是一个按钮）。
          if (envText.includes('环境已就绪')) {
            checks.that('就绪时提示可以从左侧进入报告审核', envText.includes('配置已完成。你可以从左侧进入报告审核。'))
          }
          // 四个步骤都在左侧导航里，且**顺序**固定（用页面文本下标核对）。
          const steps = ['账号连接', '阿里云 OSS', 'iFinD', '工作空间']
          for (const step of steps) checks.that(`步骤导航有「${step}」`, envText.includes(step))
          const stepIndex = steps.map((step) => envText.indexOf(step))
          checks.that('步骤顺序 = 用户操作顺序', stepIndex.every((value, index) => value >= 0 && (index === 0 || value > stepIndex[index - 1])),
            JSON.stringify(stepIndex))
          const navItems = await page.locator('[data-crwu-env-step]').count()
          checks.that('左侧步骤项恰好四个', navItems === 4, `实际 ${String(navItems)} 个`)
          const states = await page.locator('[data-crwu-env-step]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-state')))
          checks.that('每个步骤都带状态（done / todo / doing）', states.every((state) => state === 'done' || state === 'todo' || state === 'doing'), JSON.stringify(states))
          const activeStep = await page.locator('[data-crwu-env-step][aria-current="step"]').count()
          checks.that('默认有一项是当前步骤', activeStep === 1, `实际 ${String(activeStep)} 个`)
          checks.that('当前步骤的面板画出来了', await page.locator('[data-crwu-env-step-panel]').count() === 1)
          // 员工视野里**不许**出现他修不了的处置。
          checks.that('不为包内组件提示安装命令', !/安装\s*(crwu|dws|ossutil)|请先安装/.test(envText))
          checks.that('不提示员工安装系统 Python 或改 PATH', !/安装(系统)?\s*Python|export\s+PATH|command -v/.test(envText))
          checks.that('技术细节（包根 / 清单）默认不可见', !envText.includes('包内清单') && !envText.includes('包根'))
          checks.that('① 不拿当前会话说事（换会话不会变）', !envText.includes('不是同一个') && !envText.includes('的会话中打开工作台'))
          await page.screenshot({ path: join(out, 'env.png') })

          // 切换步骤：手动选过之后（这里点 OSS 与 iFinD）各自的表单必须出来。
          const pick = async (id) => {
            const item = page.locator(`[data-crwu-env-step="${id}"]`).first()
            await item.click()
            await page.waitForTimeout(220)
            return page.locator(`[data-crwu-env-step-panel="${id}"]`).first()
          }

          // 账号连接：一次性授权**不使用模态层**，是这一步里可见的一行。
          const accounts = await pick('accounts')
          const consent = accounts.locator('[data-crwu-env-item="consent"]').first()
          checks.that('授权是「账号连接」步骤里可见的一行（不是模态层）', await consent.count() > 0)
          checks.that('页面上没有遮住整页的授权弹框', await page.locator('.crwu-audit-auth-mask').count() === 0)
          const accountsText = await accounts.innerText()
          if (accountsText.includes('同意并继续')) {
            checks.that('未授权时给「同意并继续」', accountsText.includes('同意并继续'))
          } else {
            checks.that('已授权后给出「已授权读取本机凭据」', accountsText.includes('已授权读取本机凭据'))
          }
          checks.that('账号步骤里给出氚云与钉钉', accountsText.includes('氚云') && accountsText.includes('钉钉'))

          // OSS 步骤：两个字段各自有真实 <label>、Secret 是 password、不要 STS / endpoint。
          const ossPanel = await pick('oss')
          const ossCard = ossPanel.locator('[data-crwu-oss-card="1"]').first()
          checks.that('OSS 凭据表单在 OSS 步骤里', await ossCard.count() > 0)
          const ossInputs = await ossCard.locator('input').count()
          checks.that('OSS 表单只有 ID 与 Secret 两个输入框', ossInputs === 2, `实际 ${String(ossInputs)} 个`)
          const ossLabels = await ossCard.locator('label').allInnerTexts()
          checks.that('OSS 字段用真实 <label> 而不是只用 placeholder',
            ossLabels.length === 2 && ossLabels.join('|').includes('AccessKey ID') && ossLabels.join('|').includes('AccessKey Secret'),
            JSON.stringify(ossLabels))
          checks.that('OSS 表单不再要 STS Token / endpoint', await ossCard.getByText(/STS Token|endpoint/i).count() === 0)
          checks.that('OSS 表单的 Secret 输入是 password', await ossCard.locator('input[type="password"]').count() === 1)
          checks.that('OSS 主按钮是「保存并验证」', (await ossCard.innerText()).includes('保存并验证'))
          checks.that('OSS 说明向管理员获取 AK', (await ossCard.innerText()).includes('向管理员获取'))

          // iFinD 步骤：只用「API-Key」这个词，且明说不要让 Agent 代填。
          const ifindPanel = await pick('ifind')
          const ifindCard = ifindPanel.locator('[data-crwu-ifind-card="1"]').first()
          checks.that('iFinD 卡片在 iFinD 步骤里', await ifindCard.count() > 0)
          const ifindText = await ifindCard.innerText()
          checks.that('iFinD 卡片给出状态结论（已认证 / 未通过验证 / 未填写 / 无效 / 不可达）',
            /已认证|未通过验证|未填写|API-Key 无效|服务不可达/.test(ifindText), ifindText.slice(0, 120))
          checks.that('iFinD 统一叫 API-Key', ifindText.includes('API-Key'))
          checks.that('iFinD 面向用户的文案里不再出现「SK」', !/(^|[^A-Za-z])SK([^A-Za-z]|$)/.test(ifindText), ifindText.slice(0, 120))
          checks.that('iFinD 卡片明说不要让 Agent 代填', ifindText.includes('不要让 Agent 代填'))
          checks.that('iFinD 卡片说明从哪里获得', ifindText.includes('从哪里获得'))
          checks.that('iFinD 卡片不展示验证工具名与数据样本（已移入维护者诊断）',
            !ifindText.includes('验证工具') && !ifindText.includes('取数样本') && !ifindText.includes('取数摘要'))
          const ifindLink = ifindCard.locator('a').first()
          checks.that('iFinD 官方入口是链接', await ifindLink.count() > 0)
          checks.that('官方入口指向 mcp.51ifind.com',
            String(await ifindLink.getAttribute('href') ?? '').includes('mcp.51ifind.com'))
          const ifindPassword = await ifindCard.locator('input[type="password"]').count()
          const ifindInputs = await ifindCard.locator('input').count()
          checks.that('iFinD 输入框是 password 类型或已保存时收起', ifindInputs === 0 || ifindPassword === 1)

          // 工作空间步骤：就绪时是一行摘要（有「更换」入口）。
          const wsPanel = await pick('workspace')
          checks.that('工作空间步骤里有案例根目录', (await wsPanel.innerText()).includes('案例根目录'))
          checks.that('工作空间就绪时压成摘要（有「更换」入口）', (await wsPanel.innerText()).includes('更换'))
          await page.screenshot({ path: join(out, 'env-config.png') })

          // 维护者诊断：点开后才是技术细节（包根、清单、字节数、运行时、Tool 可见性、验证工具名）。
          await pick('ifind')
          const maintenanceHead = page.locator('.crwu-audit-details-head').filter({ hasText: '维护者诊断' }).first()
          checks.that('有「维护者诊断」折叠区', await maintenanceHead.count() > 0)
          await maintenanceHead.click()
          await page.waitForTimeout(300)
          const detailText = await body()
          checks.that('维护者诊断展开后有包内组件 / DSH Runtime / 平台 / Tool 可见性',
            ['包内组件', 'DSH Runtime', '平台', 'Tool 可见性'].every((item) => detailText.includes(item)))
          checks.that('技术细节里有包根与包内清单', detailText.includes('包根') && detailText.includes('包内清单'))
          checks.that('技术细节里有 DSH 运行时路径', detailText.includes('运行时路径') || detailText.includes('/'))
          checks.that('维护者诊断里不再需要授权开关', !detailText.includes('记住氚云授权'))
          await page.screenshot({ path: join(out, 'env-details.png') })
        })

        // ── 重新自检也要有加载态（用户点下去到结论出来有好几秒）────────────────
        await phase('重新自检加载态', async () => {
          const recheck = page.getByRole('button', { name: /重新检查|重新自检/ }).first()
          if (await recheck.count() === 0) {
            checks.that('环境信息页有「重新检查」按钮', false)
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
            // 不通过时的门禁：环境页**没有**「进入报告审核」按钮（2026-09-26 口径），
            // 所以从**侧栏子项**进报告审核 —— 它必须被统一导航拦回来，并当场给出拦截说明
            // （说明读的是导航层记下的 `gateReason`，不是等用户再点一次「重新检查」）。
            await moduleButton('报告审核').click()
            await page.waitForTimeout(1200)
            const blockedText = await body()
            checks.that('不通过时点侧栏「报告审核」被拦住（报告页不出现）', !blockedText.includes('报告列表'))
            checks.that('拦住后停在环境信息页', /环境已就绪|还需完成|需要管理员处理|发现系统故障|环境检查没有完成/.test(blockedText))
            checks.that('拦截说明当场出现（不用再点一次重新检查）',
              await page.locator('[data-crwu-env-gate="blocked"]').count() > 0)
            const gateText = await page.locator('[data-crwu-env-gate="blocked"]').first().innerText()
            checks.that('拦截说明指向被拦的那一页', gateText.includes('报告审核'), gateText.slice(0, 120))
            checks.that('环境页仍然可进（它自己就是修复入口）', await page.locator('[data-crwu-env-stepnav="1"]').count() > 0)
            await page.screenshot({ path: join(out, 'gate.png') })
            return
          }
          await page.getByRole('button', { name: /报告列表/ }).last().click()
          // 氚云查询真机上十几秒是常态：等真正画出流水号（或明确报错）再断言，别用固定等待。
          await page.waitForFunction(
            (source) => new RegExp(source).test(document.body.innerText),
            SEQ.source,
            { timeout: 90_000 },
          ).catch(() => undefined)
          const pendingText = await body()
          checks.that('待审核报告画出真实流水号行', SEQ.test(pendingText))
          // 「按流水号查**云端交付件**」那只工具条属于 AI 审核列表页，不该出现在报告列表页。
          // （报告列表页自己那只搜索框的占位**就是**「输入报告流水号」，两者不是一回事。）
          checks.that(
            '报告列表页没有「查云端交付件」的工具条',
            await page.getByPlaceholder(/交付件|审核结果/).count() === 0,
          )
          checks.that('待审核报告显示复核级次', pendingText.includes('初审'))
          // 风险等级要透出来：这一列是用户要求加的（真实取值 A/B/C）。
          checks.that('待审核报告有「风险等级」列', pendingText.includes('风险等级'))
          // 风险等级是「小圆点 + 字母」（低噪音 Status Indicator），不再是彩色矩形 Tag。
          const riskTexts = await page.locator('.crwu-audit-risk').allInnerTexts()
          checks.that(
            '风险等级渲染成「圆点 + 字母」',
            riskTexts.length > 0 && riskTexts.every((text) => /^[ABC]$/.test(text.trim()) || text.trim() === '—'),
            riskTexts.slice(0, 6).join(' / '),
          )
          checks.that('风险等级不再是彩色矩形 Tag', await page.locator('.crwu-audit-td .crwu-audit-badge').count() === 0)
          checks.that(
            '风险圆点用低饱和的专用色',
            await page.locator('.crwu-audit-risk-dot').count() === riskTexts.length,
          )
          // 列宽分工：流水号/风险/时间这几列一律不换行，否则会被从中间折断、挤成一团。
          checks.that(
            '窄列不换行（不再被折断）',
            await page.$$eval('td.crwu-audit-td-nowrap', (nodes) => nodes.length > 0
              && nodes.every((node) => getComputedStyle(node).whiteSpace === 'nowrap')),
          )
          // 业务时间必须带完整年份（用户 2026-09-23 口径：这是审核留痕系统，禁止「昨天 / 09-20」）。
          const narrowCells = await page.locator('td.crwu-audit-td-nowrap').allInnerTexts()
          checks.that(
            '更新时间渲染成 YYYY-MM-DD HH:mm（保留完整年份）',
            narrowCells.some((text) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(text.trim())),
            narrowCells.map((t) => t.trim()).join(' | ').slice(0, 140),
          )
          checks.that(
            '列表里不再出现相对时间 / 省略年份的时间',
            !/(昨天|今天|前天|天前|小时前)/.test(pendingText)
              && !/(?:^|\s)\d{2}-\d{2} \d{2}:\d{2}/.test(narrowCells.join(' ')),
          )
          await page.screenshot({ path: join(out, 'pending.png') })
        })

        // ── 报告审核页：Workspace Surface + Segmented 页签 + 小鲸鱼（拉文件 → 气泡 / 直跳） ──
        // 用户 2026-09-22 口径：「除了 header 部分，其他都是 border…用一个圆角的大背景框住」；
        // 「这里不设计右侧对话框了，去掉吧，只会增加负担」；「点击小鲸鱼时如果有绑定的对话，
        // 需要有个气泡框询问用户是针对这个报告建立新对话还是继续上次聊天，如果没有的话就直接
        // 通过 crwu 拉取文件信息后直接跳转到新对话就可以了」。
        await phase('报告审核页：大圆角框 + 小鲸鱼讨论入口', async () => {
          const surface = page.locator('.crwu-audit-surface').first()
          await surface.waitFor({ state: 'visible', timeout: 20_000 })
          const frame = await surface.evaluate((node) => {
            const style = getComputedStyle(node)
            return { radius: style.borderRadius, border: style.borderTopWidth }
          })
          checks.that(
            '正文只有一层大圆角框（圆角 + 描边）',
            frame.radius !== '0px' && Number.parseFloat(frame.border) > 0,
            JSON.stringify(frame),
          )
          // 轻量 Segmented Workspace Tabs（用户 2026-09-23 口径）：**槽才有底**、选中项是浮起的白片。
          // 文字型 + 品牌色下划线那套已撤（不要红色 underline、不要底色 + 下划线双重选中）。
          const trackStyle = await page.locator('.crwu-audit-tabs').first().evaluate((n) => {
            const s = getComputedStyle(n)
            return { bg: s.backgroundColor, radius: s.borderRadius, pad: s.paddingTop }
          })
          checks.that(
            '页签容器是浅槽（Segmented，不再是透明文字页签）',
            trackStyle.bg === 'rgb(242, 243, 245)' && Number.parseFloat(trackStyle.radius) >= 8,
            JSON.stringify(trackStyle),
          )
          const onStyle = await page.locator('.crwu-audit-tab-on').first().evaluate((n) => {
            const s = getComputedStyle(n)
            return {
              bg: s.backgroundColor,
              weight: s.fontWeight,
              shadow: s.boxShadow,
              h: Math.round(n.getBoundingClientRect().height),
            }
          })
          checks.that(
            '选中页签是浮起的白片（白底 + 600 + 一层轻投影，高 34px）',
            onStyle.bg === 'rgb(255, 255, 255)' && onStyle.weight === '600'
              && onStyle.shadow !== 'none' && onStyle.h === 34,
            JSON.stringify(onStyle),
          )
          checks.that(
            '页签不再有下划线指示条',
            await page.locator('.crwu-audit-tab-ind').count() === 0,
            String(await page.locator('.crwu-audit-tab-ind').count()),
          )
          const tabText = (await page.locator('.crwu-audit-tabs').innerText()).replace(/\s+/g, ' ')
          checks.that(
            '两个页签就叫「报告列表 / AI 审核列表」',
            tabText.includes('报告列表') && tabText.includes('AI 审核列表'),
            tabText,
          )
          // 列表工具条：搜索 + 刷新**同一行**（刷新不再挂页面右上角），刷新是 Ghost（透明底）。
          const toolbar = page.locator('.crwu-audit-toolbar').first()
          checks.that(
            '刷新在列表工具条里（与搜索同一行）',
            await toolbar.locator('.crwu-audit-ghost').count() === 1,
            String(await toolbar.locator('.crwu-audit-ghost').count()),
          )
          const ghostStyle = await toolbar.locator('.crwu-audit-ghost').first().evaluate((n) => {
            const s = getComputedStyle(n)
            return { bg: s.backgroundColor, h: Math.round(n.getBoundingClientRect().height) }
          })
          checks.that(
            '刷新是 36px 高的次级控件（与操作列的小鲸鱼 / ••• 同一套中性底）',
            ghostStyle.bg !== 'rgba(0, 0, 0, 0)' && ghostStyle.h === 36,
            JSON.stringify(ghostStyle),
          )
          checks.that(
            '分页支持首页 / 末页 / 跳至指定页',
            await page.getByRole('button', { name: '首页' }).count() === 1
              && await page.getByRole('button', { name: '末页' }).count() === 1
              && await page.locator('.crwu-audit-pager-jump-input').count() === 1,
          )
          // 右侧自绘对话框已经撤掉：页面上不该再有那套面板的任何痕迹。
          checks.that(
            '右侧不再有自绘对话框（面板已按用户口径移除）',
            await page.locator('.crwu-audit-ai-panel, .crwu-audit-ai-ribbon, .crwu-audit-ai-input').count() === 0,
          )

          // 操作列（用户 2026-09-22 口径）：**一个主操作 + 小鲸鱼 + 必要时一个 •••**，
          // 不再排开一堆按钮。官方 DeepSeek 标记 + 用户原话的悬停文案。
          const actionButtons = page.locator('.crwu-audit-tbody-row').first().locator('.crwu-audit-td-action button')
          const whale = page.locator('.crwu-audit-tbody-row').first().locator('.crwu-audit-ai-row-btn')
          const lastAction = whale.first()
          checks.that('操作列只有一枚小鲸鱼入口', await whale.count() === 1, String(await whale.count()))
          checks.that(
            '操作列不再排开一堆按钮（≤ 主操作 + 鲸鱼 + •••）',
            await actionButtons.count() <= 4,
            `按钮 ${await actionButtons.count()} 个`,
          )
          checks.that(
            '超过一个动作时收进 ••• 菜单',
            await page.locator('.crwu-audit-tbody-row').first().locator('.crwu-audit-menu').count() <= 1,
          )
          checks.that(
            '入口画的是 DeepSeek 官方标记（用户给的 SVG）',
            await lastAction.locator('svg[viewBox="0 0 23.16 17.04"]').count() === 1,
          )
          checks.that(
            '小鲸鱼有可访问名（不用原生 title）',
            String(await lastAction.getAttribute('aria-label') ?? '') === '与 DeepSeek 讨论报告',
            String(await lastAction.getAttribute('aria-label') ?? ''),
          )
          // 小鲸鱼是**浅中性底的 Icon Button**（不是第二个实心按钮），32×32。
          const whaleStyle = await lastAction.evaluate((n) => {
            const s = getComputedStyle(n)
            return { bg: s.backgroundColor, w: Math.round(n.getBoundingClientRect().width), h: Math.round(n.getBoundingClientRect().height) }
          })
          checks.that(
            '小鲸鱼是 32×32 的次级控件（不是实心主色）',
            whaleStyle.w === 32 && whaleStyle.h === 32 && whaleStyle.bg !== 'rgba(0, 0, 0, 0)',
            JSON.stringify(whaleStyle),
          )
          // **同一个行里三个控件必须只有两种底**：主操作一套、其余次级控件同一套。
          // 用户 2026-09-23 报的就是「操作列的按钮颜色不一致，还有刷新按钮」。
          const actionBgs = await page.locator('.crwu-audit-tbody-row').first().locator('.crwu-audit-td-action button')
            .evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).backgroundColor))
          const distinctActionBgs = [...new Set(actionBgs)]
          checks.that(
            '操作列里同类控件底色一致（主操作一套 + 次级控件一套）',
            distinctActionBgs.length <= 2 && !distinctActionBgs.includes('rgba(0, 0, 0, 0)'),
            JSON.stringify(actionBgs),
          )
          checks.that(
            '次级控件（刷新 / 小鲸鱼 / •••）与工具条刷新共用同一套中性底',
            whaleStyle.bg === ghostStyle.bg,
            `小鲸鱼 ${whaleStyle.bg} vs 刷新 ${ghostStyle.bg}`,
          )

          // **只挑已经有绑定会话的那份报告来点**：没有绑定会话时点它 = 建会话 + 真发一次
          // 上下文（一次真实 AI 回合），验收脚本不该烧这个钱、也不该往用户的会话库里写东西。
          // 拿不到这类报告（干净环境）就如实跳过这一整段。
          const sideText = await page.locator('body').innerText()
          const discussed = [...new Set(
            [...sideText.matchAll(new RegExp('报告讨论 · (\\d{4}-\\d{5,7}-[A-Z0-9]{3,}-[A-Z0-9]{3,})', 'g'))]
              .map((match) => match[1]),
          )]
          const row = discussed.length === 0
            ? null
            : page.locator('.crwu-audit-tbody-row').filter({ hasText: discussed[0] }).first()
          if (row === null || await row.count() === 0) {
            checks.passed.push('这份报告还没有绑定会话（"直跳新对话"那条要真发一次上下文，验收脚本不触发）')
          } else {
            // 拉文件要跑 OSS 列举与 crwu 读附件（几秒到几十秒）：把这一次拖慢，
            // 才能把"整块正文里出现过中瑞世联等待页"变成确定性断言。
            await page.route('**/api/crwu-workbench**', async (route) => {
              const payload = route.request().postData() ?? ''
              if (payload.includes('"op":"report-files"')) await new Promise((resolve) => setTimeout(resolve, 3000))
              await route.continue()
            })
            await row.locator('.crwu-audit-ai-row-btn').first().click()
            const waiting = page.locator('.crwu-audit-ai-mask .crwu-audit-loading-pane').first()
            await waiting.waitFor({ state: 'visible', timeout: 20_000 })
            checks.that(
              '拉文件时**整块正文**是中瑞世联的等待页（品牌标记 + 进度条）',
              await waiting.locator('svg polygon').count() === 4
                && await waiting.locator('.crwu-audit-load-bar').count() === 1,
            )
            await page.screenshot({ path: join(out, 'ai-pulling.png') })
            // 等被拖慢的这次查询真的回来再撤路由（撤早了 handler 里的 continue() 会撞上
            // 「Route is already handled」）。
            await page.waitForFunction(
              () => document.querySelector('.crwu-audit-ai-mask') === null,
              undefined,
              { timeout: 90_000 },
            ).catch(() => undefined)
            await page.unroute('**/api/crwu-workbench**')
            const bubble = page.locator('.crwu-audit-ai-dialog').first()
            await bubble.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => undefined)
            if (await bubble.count() === 0) {
              checks.that('已有绑定会话时应当弹气泡问「新建 / 继续」', false, '气泡没出现')
            } else {
              const bubbleText = await bubble.innerText()
              checks.that(
                '气泡问的是「新建对话 / 继续上次聊天」',
                bubbleText.includes('新建对话') && bubbleText.includes('继续上次聊天'),
                bubbleText.replace(/\s+/g, ' ').slice(0, 120),
              )
              await page.screenshot({ path: join(out, 'ai-ask.png') })
              // 关掉气泡（点遮罩）：不该顺手建任何会话。
              await page.locator('.crwu-audit-ai-dialog-backdrop').first().click()
              await page.waitForFunction(
                () => document.querySelector('.crwu-audit-ai-dialog') === null,
                undefined,
                { timeout: 10_000 },
              ).catch(() => undefined)
              checks.that('点遮罩能关掉气泡', await page.locator('.crwu-audit-ai-dialog').count() === 0)
            }
            checks.that('拉文件只列举、不下载对象内容（没有 oss-result）', !ops.includes('oss-result'), ops.join(','))
          }
        })
        // ── 「审核信息」抽屉：读一个**真实** OSS 对象并渲染摘要 ────────────
        // 这条盯的是第 26 轮修掉的那个缺陷：`ossutil` 把 `<n>(s) elapsed` 写到 stdout，
        // 严格 JSON.parse 必失败，界面上就是「审核信息」永远报「不是合法 JSON」。
        // 只有点开真实对象才能证明它真的好了。
        await phase('审核信息抽屉：AI 审核质量与问题摘要', async () => {
          // 浮层菜单项带 `role="menuitem"`：`getByRole('button')` 永远匹配不到（踩过）。
          const button = page.locator('.crwu-audit-float-item', { hasText: '查看审核信息' }).first()
          if (await button.count() === 0) {
            // 数据条件，不是代码缺陷：没有"已完成并上云 + 带 JSON 摘要"的记录时这一整段无从验证。
            checks.passed.push('当前没有带审核摘要的云端记录（抽屉这一段跳过，属于数据条件）')
            return
          }
          const before = ops.filter((op) => op === 'oss-result').length
          await button.click()
          // 读一条真实对象要跑一次 ossutil（真机几秒到几十秒）：等「读到内容 / 明确报错」再断言。
          // 固定等待会假红，而且会连锁 —— 抽屉没关掉时它的遮罩会挡住后面所有点击。
          await page.waitForFunction(
            () => /复核命中率|不是合法 JSON|没有审核结果 JSON/.test(document.body.innerText),
            undefined,
            { timeout: 90_000 },
          ).catch(() => undefined)
          const drawerText = await body()
          checks.that('点开审核信息会去读一个对象', ops.filter((op) => op === 'oss-result').length === before + 1)
          checks.that('抽屉不再报「不是合法 JSON」', !/不是合法 JSON/.test(drawerText))

          // ── 尺寸 / 遮罩 / 动画 ─────────────────────────────────────────────
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
          checks.that(
            '抽屉宽度 560–620（不再变成半屏 Dashboard）',
            box !== null && box.width >= 560 && box.width <= 620,
            box === null ? '拿不到位置' : `w=${Math.round(box.width)}`,
          )
          checks.that('抽屉带遮罩', await page.locator('.crwu-audit-side-drawer-backdrop').count() === 1)
          const overlay = await page.locator('.crwu-audit-side-drawer-backdrop').first().evaluate((node) => {
            const style = getComputedStyle(node)
            return { bg: style.backgroundColor, blur: style.backdropFilter || style.webkitBackdropFilter }
          })
          const overlayAlpha = Number((/rgba?\([^)]*?([\d.]+)\s*\)$/.exec(overlay.bg) ?? [])[1] ?? '1')
          checks.that(
            '遮罩是 .30–.34 的黑 + blur 2px（关掉后还看得出从哪一行打开）',
            overlayAlpha >= 0.3 && overlayAlpha <= 0.34
              && /blur\((\d+(\.\d+)?)px\)/.test(overlay.blur)
              && Number(/(\d+(\.\d+)?)px/.exec(overlay.blur)[1]) <= 2,
            JSON.stringify(overlay),
          )
          const drawerAnim = String(await panel.evaluate((node) => getComputedStyle(node).animationName))
          checks.that('抽屉有开/关动画（不是硬切）', drawerAnim !== 'none', drawerAnim)

          // ── Header：标题 + 一行等宽流水号 + ×（不再有「关闭」文字按钮）──────────
          const headSub = page.locator('.crwu-audit-side-drawer-sub').first()
          checks.that('标题下面只有一行流水号', await headSub.count() === 1, String(await headSub.count()))
          const subMono = await headSub.evaluate((node) => getComputedStyle(node).fontFamily)
          checks.that('流水号是等宽小字', /mono|Menlo|Mono/i.test(subMono), subMono)
          checks.that(
            '头部删除「关闭」文字按钮、换成 × 图标按钮',
            await page.locator('.crwu-audit-side-drawer-head button', { hasText: '关闭' }).count() === 0
              && await page.locator('.crwu-audit-side-drawer-close').count() === 1,
          )

          // ── 第一屏：命中率最大、AI 检出与已提未改同级、**没有结论大卡** ──────────
          const km = page.locator('.crwu-audit-km').first()
          checks.that('第一块是核心指标（不是审核摘要卡）', await km.count() === 1)
          const headText = (await page.locator('.crwu-audit-side-drawer-head').first().innerText()).replace(/\s+/g, ' ')
          checks.that('头部保持安静：不出现结论 / 复核状态', !/(未通过|通过|已执行|审核完成)/.test(headText), headText)
          const kmText = (await km.innerText()).replace(/\s+/g, ' ')
          checks.that('核心指标里有复核命中率', kmText.includes('复核命中率'), kmText.slice(0, 120))
          const rate = await page.locator('.crwu-audit-rate-value').first().evaluate((n) => ({
            text: (n.textContent ?? '').trim(), size: parseFloat(getComputedStyle(n).fontSize),
          }))
          checks.that('命中率是第一视觉重点（30–34px）', rate.size >= 30 && rate.size <= 34, JSON.stringify(rate))
          checks.that('命中率只展示易读值（不带公式）', /^[\d.]+%$|^不适用$|^—$/.test(rate.text), rate.text)
          checks.that('核心指标里有 AI 检出 / 已提未改', kmText.includes('AI 检出') && kmText.includes('已提未改'))
          checks.that(
            '第一屏不再出现「未通过」大状态',
            !/(未通过)/.test(kmText),
            kmText.slice(0, 120),
          )
          const kmValues = await page.locator('.crwu-audit-km-value').allInnerTexts()
          checks.that(
            'AI 检出 / 已提未改 各给一个「N 条」',
            kmValues.length === 2 && kmValues.every((text) => /条$/.test(text.trim())),
            JSON.stringify(kmValues),
          )
          await page.screenshot({ path: join(out, 'drawer.png') })

          // ── AI 检出问题列表：直接给标题与简述 ──────────────────────────────
          const issueRows = page.locator('.crwu-audit-issue-row')
          const issueCount = await issueRows.count()
          checks.that('抽屉里有 AI 检出的具体问题列表', issueCount > 0, `共 ${String(issueCount)} 行`)
          if (issueCount > 0) {
            const firstRow = issueRows.first()
            const rowText = (await firstRow.innerText()).replace(/\s+/g, ' ')
            checks.that('问题行给出严重程度', /(高|中|低)/.test(rowText), rowText.slice(0, 80))
            checks.that('问题行给出标题与简述', rowText.length > 8, rowText.slice(0, 120))
            checks.that(
              '问题默认折叠（data-open=false 且正文高度 0）',
              (await firstRow.getAttribute('data-open')) === 'false'
                && await firstRow.locator('.crwu-audit-acc-body').evaluate((n) => Math.round(n.getBoundingClientRect().height)) === 0,
            )
            checks.that('默认不显示内部编号', !/ISS-\d/.test(rowText), rowText.slice(0, 80))
            // 点开第一条：位置 + 建议
            await firstRow.locator('.crwu-audit-issue-head').first().click()
            await page.waitForFunction(
              () => document.querySelector('.crwu-audit-issue-row')?.getAttribute('data-open') === 'true',
              undefined,
              { timeout: 10_000 },
            ).catch(() => undefined)
            const openText = (await issueRows.first().innerText()).replace(/\s+/g, ' ')
            checks.that('点开问题给「位置」与「建议」', openText.includes('位置') && openText.includes('建议'), openText.slice(0, 140))
            checks.that(
              '点开问题只给"是什么/在哪/怎么改"，不给规则证据链',
              !/(ruleEvidence|materialEvidence|RULE-|知识库)/.test(openText),
              openText.slice(0, 140),
            )
            await page.screenshot({ path: join(out, 'drawer-issue.png') })
            await issueRows.first().locator('.crwu-audit-issue-head').first().click()
            await page.waitForTimeout(240)
          }

          // ── 已提未改：默认折叠 + 展开给"人工说了什么 / AI 现在仍发现什么" ─────
          const raised = page.locator('.crwu-audit-raised').first()
          if (await raised.count() === 0) {
            checks.passed.push('这份审核结果没有「已提未改」（数据条件，跳过展开验证）')
          } else {
            checks.that('已提未改默认折叠', (await raised.getAttribute('data-open')) === 'false')
            checks.that('已提未改带数量 badge', await raised.locator('.crwu-audit-raised-count').count() === 1)
            await raised.locator('.crwu-audit-raised-head').first().click()
            await page.waitForFunction(
              () => document.querySelector('.crwu-audit-raised')?.getAttribute('data-open') === 'true',
              undefined,
              { timeout: 10_000 },
            ).catch(() => undefined)
            const raisedText = (await raised.innerText()).replace(/\s+/g, ' ')
            checks.that('展开后给出人工当时提出的问题', /人工复核：/.test(raisedText), raisedText.slice(0, 140))
            checks.that('展开后给出 AI 当前仍然发现的', /AI 检出：/.test(raisedText), raisedText.slice(0, 140))
            await page.screenshot({ path: join(out, 'drawer-raised.png') })
            await raised.locator('.crwu-audit-raised-head').first().click()
            await page.waitForTimeout(240)
          }

          // ── 折叠区：报告信息 / 技术详情默认收起 ────────────────────────────
          const folds = page.locator('.crwu-audit-fold')
          const foldCount = await folds.count()
          checks.that('报告信息与技术详情是折叠小节', foldCount >= 2, `共 ${String(foldCount)} 个`)
          const openStates = await folds.evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-open')))
          checks.that('所有折叠小节默认都是收起的', openStates.every((state) => state === 'false'), JSON.stringify(openStates))
          // 展开最后一个（技术详情）：原始 JSON / ISO 时间 / 引擎版本都在里面
          const techFold = folds.nth(foldCount - 1)
          await techFold.locator('.crwu-audit-fold-head').first().click()
          await page.waitForFunction(
            () => {
              const all = [...document.querySelectorAll('.crwu-audit-fold')]
              return all[all.length - 1]?.getAttribute('data-open') === 'true'
            },
            undefined,
            { timeout: 10_000 },
          ).catch(() => undefined)
          const techText = await techFold.innerText()
          checks.that('展开技术详情后有原始字段（引擎版本 / JSON / ISO 时间之一）',
            /(引擎版本|\{)/.test(techText) && techText.length > 40, techText.replace(/\s+/g, ' ').slice(0, 120))
          await techFold.locator('.crwu-audit-tech-json').first().evaluate((n) => n.scrollIntoView({ block: 'center' })).catch(() => undefined)
          await page.waitForTimeout(300)
          await page.screenshot({ path: join(out, 'drawer-tech.png') })
          await techFold.locator('.crwu-audit-fold-head').first().click()
          await page.waitForTimeout(240)

          // 关闭前记下上下文：关掉抽屉不该动列表（Tab / 页码 / 搜索条件 / 滚动位置）。
          const contextBefore = await listContext()
          // 一定要把抽屉关掉：它的遮罩盖住整个视口，留着会让后续每个 click 都超时（踩过）。
          const closeButton = page.locator('.crwu-audit-side-drawer-close').first()
          if (await closeButton.count() > 0) await closeButton.click().catch(() => undefined)
          await page.waitForFunction(
            () => document.querySelectorAll('.crwu-audit-side-drawer-backdrop').length === 0,
            undefined,
            { timeout: 15_000 },
          ).catch(() => undefined)
          checks.that('关闭后抽屉与遮罩一起消失', await page.locator('.crwu-audit-side-drawer-backdrop').count() === 0)
          // §30：关掉抽屉不动列表 —— Tab / 页码 / 搜索条件 / 滚动位置都保持原样。
          const contextAfter = await listContext()
          checks.that(
            '关闭 Drawer 后列表上下文不变（Tab / 页码 / 搜索 / 滚动）',
            JSON.stringify(contextAfter) === JSON.stringify(contextBefore),
            `${JSON.stringify(contextBefore)} → ${JSON.stringify(contextAfter)}`,
          )
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
          // 加载态**只盖列表数据区**：工具条与已有列表都还在（不清空、不白屏、不 Layout Shift）。
          checks.that(
            '翻页时工具条与搜索框仍然可见（只盖列表数据区）',
            await page.locator('.crwu-audit-toolbar').first().isVisible()
              && await page.locator('.crwu-audit-search').first().isVisible(),
          )
          checks.that('翻页时已有列表保持显示（不清空、不白屏）', await page.locator('.crwu-audit-tbody-row').count() > 0)
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
            await page.getByRole('button', { name: /AI 审核列表/ }).first().click()
            await page.waitForTimeout(1200)
            await page.getByRole('button', { name: /报告列表/ }).last().click()
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
          await page.getByRole('button', { name: /AI 审核列表/ }).first().click()
          await page.waitForFunction(
            (source) => new RegExp(source).test(document.body.innerText),
            SEQ.source,
            { timeout: 90_000 },
          ).catch(() => undefined)
          checks.that('AI审核结果画出真实云端案例', SEQ.test(await body()))
          // 统一的 DeepSeek 入口（与「报告列表」同一枚图标/同一套 Icon Button）：
          // 列表里只多这一枚按钮，不加文字按钮、不加「可分析 / AI ready」这类噪音 Tag。
          const aiWhale = page.locator('.crwu-audit-tbody-row').first().locator('.crwu-audit-ai-row-btn').first()
          checks.that('AI审核列表增加统一的 DeepSeek 入口', await aiWhale.count() === 1, String(await aiWhale.count()))
          checks.that(
            '入口画的是同一个 DeepSeek 官方标记',
            await aiWhale.locator('svg[viewBox="0 0 23.16 17.04"]').count() === 1,
          )
          checks.that(
            '入口的可访问名是「与 DeepSeek 分析审核结果」',
            String(await aiWhale.getAttribute('aria-label') ?? '') === '与 DeepSeek 分析审核结果',
            String(await aiWhale.getAttribute('aria-label') ?? ''),
          )
          const aiRowText = (await page.locator('.crwu-audit-tbody-row').first().innerText()).replace(/\s+/g, ' ')
          checks.that(
            '没有新增「AI分析 / 可分析 / AI ready / 已同步」这类噪音',
            !/(AI分析|可分析|AI ready|已同步|上下文完整)/.test(aiRowText),
            aiRowText.slice(0, 120),
          )
          await aiWhale.hover()
          const aiTip = page.locator('.crwu-audit-float-tip').first()
          await aiTip.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined)
          checks.that(
            '悬停给浮动 Tooltip「与 DeepSeek 分析审核结果」',
            (await aiTip.count()) === 1 && (await aiTip.innerText()).includes('与 DeepSeek 分析审核结果'),
            await aiTip.innerText().catch(() => ''),
          )
          await page.mouse.move(4, 4)
          await page.screenshot({ path: join(out, 'results.png') })
        })

        // ── 按流水号查云端交付件（**「AI审核列表」页自己的工具条**）─────────────
        // 用户 2026-09-23 口径：和报告列表**共用同一个 Search 组件**，只认流水号，
        // **按 Enter 才发起查询**（没有「查找 / 清空」两个按钮，清空是输入框右侧那个 ×）。
        // 这里盯五条：工具条在、输入过程不列举 OSS、不存在的流水号明确说「没有」、
        // 命中的流水号真的列出交付件、点 × 回到全量且不重新列举。
        await phase('按流水号查找', async () => {
          const search = page.getByLabel('按流水号查找交付件').first()
          checks.that('「AI审核列表」页里有「按流水号」查找框', await search.count() === 1)
          // 位置也是需求的一部分：它是**这一页自己的工具条**，必须长在 AI 审核列表这一页的正文里。
          const resultCard = page.locator('.crwu-audit-pane-main')
          checks.that(
            '查找框在 AI 审核列表这一页的正文里（且全页只有一只）',
            await page.locator('.crwu-audit-pane-main input').count() === 1,
            `正文里输入框 ${await page.locator('.crwu-audit-pane-main input').count()} 个`,
          )
          checks.that(
            '搜索框旁边没有「查找 / 清空」按钮（Enter 发起、× 清空）',
            await page.locator('.crwu-audit-toolbar button', { hasText: /查找|清空/ }).count() === 0,
          )

          // 真流水号必须从**这一页的表格行**里取，不能扫整页文本：
          // 左侧会话列表里会出现「报告讨论 · <流水号>」这样的会话名，整页扫描会先把**氚云待审核的**
          // 流水号捞出来，而它根本不在云端清单里（踩过 —— 命中用例假红，看起来像查找功能坏了）。
          const fake = '2099-999999-ZZZZZZ-ZZZZZZ'
          const realSeq = (await resultCard.locator('tbody tr td:first-child').allInnerTexts())
            .map((text) => text.trim())
            .find((text) => /^\d{4}-\d{5,7}-[A-Z0-9]{3,}-[A-Z0-9]{3,}$/.test(text)) ?? ''

          const before = ossListings()
          await search.fill(fake)
          await page.waitForTimeout(800)
          checks.that(
            '输入流水号的过程不列举 OSS',
            ossListings() === before,
            `输入前 ${before} 次、输入后 ${ossListings()} 次`,
          )

          // 按 Enter 发起（条件等待这次应答落地：请求在飞的时候页面还画着全量清单）。
          await search.press('Enter')
          await page.waitForFunction(
            () => document.body.innerText.includes('OSS 上没有这个流水号的交付件'),
            undefined,
            { timeout: 60_000 },
          ).catch(() => undefined)
          const afterMissing = await body()
          checks.that('不存在的流水号明确说「OSS 上没有这个流水号的交付件」', afterMissing.includes('OSS 上没有这个流水号的交付件'))
          checks.that('查找不存在的流水号只发一次列举', ossListings() === before + 1, `现在 ${ossListings()} 次`)
          await page.screenshot({ path: join(out, 'cloud-search-missing.png') })

          // 已存在的流水号：拿真实的那一条（拿不到就如实跳过，不编造）。
          if (realSeq === '') {
            checks.passed.push('云端清单里暂无可验证的流水号（跳过命中用例）')
          } else {
            await search.fill(realSeq)
            await search.press('Enter')
            await page.waitForFunction(
              (text) => document.body.innerText.includes(text) && document.body.innerText.includes('查看报告'),
              realSeq,
              { timeout: 60_000 },
            ).catch(() => undefined)
            // 同样只看**结果行**：整页断言会被左侧那条同名会话（报告讨论 · <流水号>）满足。
            const hit = await resultCard.locator('tbody tr').first().innerText()
            checks.that('存在的流水号能列出交付件与「查看报告」', hit.includes(realSeq) && hit.includes('查看报告'), hit.replace(/\s+/g, ' ').slice(0, 120))
            // 交付件按业务语义呈现：不出现 OSS 路径、不出现 .html/.json。
            checks.that(
              '交付件按业务语义呈现（审核报告 / 审核数据，不暴露 OSS 路径）',
              hit.includes('审核报告') && !/crwu\/audit|\.html|\.json/.test(hit),
              hit.replace(/\s+/g, ' ').slice(0, 160),
            )
            checks.that('查找命中也只发一次列举', ossListings() === before + 2, `现在 ${ossListings()} 次`)
            await page.screenshot({ path: join(out, 'cloud-search-hit.png') })

            // × 只是一个视图切回全量：不许把已经取到的云端清单丢掉，也不许重新列举 OSS。
            await page.locator('.crwu-audit-search-clear').first().click()
            await page.waitForFunction(
              (text) => !document.body.innerText.includes(text),
              'OSS 上没有这个流水号的交付件',
              { timeout: 30_000 },
            ).catch(() => undefined)
            const cleared = await body()
            checks.that(
              '点 × 回到全量云端清单',
              !cleared.includes('OSS 上没有这个流水号的交付件') && cleared.includes('查看报告'),
            )
            checks.that('清空不重新列举 OSS', ossListings() === before + 2, `现在 ${ossListings()} 次`)
          }
        })

        // ── 「查看会话」：客户端服务晚注册时不许报「服务不可用」 ─────────────
        // 用户实测报过这一条：点「查看会话」得到「客户端 sessions 服务不可用」。根因是插件把
        // 可选客户端服务在 apply() 里快照成普通对象 —— 哪次激活顺序变一下，快照就永久是
        // undefined。这条断言盯两件事：那句话不许再出现；要么真把会话打开（主面板切走），
        // 要么给出**真实**原因（「打开子会话失败：…」）而不是把服务缺失当结论。
        await phase('查看会话', async () => {
          // 「查看会话」在**待审核报告**那一页的行操作里（它绑的是本地审核记录的 childId，
          // 而 AI审核结果那页是 OSS 上的云端对象，没有子会话）。所以先切回去。
          await page.getByRole('button', { name: /报告列表/ }).last().click()
          await page.waitForFunction(
            (source) => new RegExp(source).test(document.body.innerText),
            SEQ.source,
            { timeout: 90_000 },
          ).catch(() => undefined)
          const openButton = page.getByRole('button', { name: '查看会话' }).first()
          if (await openButton.count() === 0) {
            // 用户 2026-09-22 口径：「查看会话」文字按钮已删除（与小鲸鱼是同一个去处）。
            checks.passed.push('「查看会话」已按口径删除，统一走小鲸鱼（这一页没有该按钮）')
            return
          }
          await openButton.click()
          // 打开会话要等会话控制器把子会话拉进清单，别用固定等待充当结论。
          await page.waitForFunction(
            () => {
              const text = document.body.innerText
              return !text.includes('报告列表') || text.includes('打开子会话失败') || text.includes('缺少父会话 id')
            },
            undefined,
            { timeout: 30_000 },
          ).catch(() => undefined)
          const text = await body()
          checks.that(
            '点「查看会话」不再报「客户端 sessions 服务不可用」',
            !text.includes('客户端 sessions 服务不可用'),
          )
          const leftWorkbench = !text.includes('报告列表')
          const realError = /打开子会话失败|缺少父会话 id|该记录没有子会话 id/.test(text)
          checks.that(
            '点「查看会话」要么打开会话、要么给出真实原因',
            leftWorkbench || realError,
            text.slice(0, 120).replace(/\s+/g, ' '),
          )
          await page.screenshot({ path: join(out, 'open-session.png') })
          // 打开会话会把主面板切到会话，后面的检查还要用工作台，所以从侧栏再进一次。
          if (leftWorkbench) {
            await entry().click()
            await page.locator('.crwu-audit-version').first().waitFor({ state: 'visible', timeout: 30_000 })
            await page.waitForTimeout(1500)
          }
        })

        // ── 切回环境信息仍然正常（状态没被弄坏） ──────────────────────────
        await phase('切回环境信息', async () => {
          if (!envOk) return
          await moduleButton('环境信息').click()
          await page.waitForTimeout(3000)
          checks.that('切回环境信息仍然正常渲染', (await body()).includes('② 插件内置组件'))
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
