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
      // 第一次进面板要跑一轮环境自检（工具 / 登录态 / 上传配置 / 外部数据），这几秒里正文
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

        // ── 门禁：通过就直接进报告审核；不通过必须停在环境信息 ────────────
        await phase('自检门禁', async () => {
          // 上一步把模块切到了「报告评估」，这里按结论回到该在的那一页再断言。
          await moduleButton(envOk ? '报告审核' : '环境信息').click()
          await page.waitForTimeout(1200)
          const text = await body()
          if (envOk) {
            checks.that('自检通过就直接进报告审核', text.includes('报告列表'))
          } else {
            checks.that('自检不通过时停在环境信息', text.includes('环境未通过'))
            checks.that('自检不通过时报告审核不出现', !text.includes('报告列表'))
          }
        })

        // ── 第 6 条：环境信息按四层画真实探测结果（同时证明 Host→Client 链路） ──
        //
        // 页面的读者是普通员工：四层结论（工具 / 登录认证 / 上传配置 / 外部数据）+ 每层
        // `x/y 已就绪`；**就绪的层收成一行、没就绪的层默认展开**；维护者信息（清单来源、
        // sha256、会话 id）收在页脚「排查详情」里，默认不展开；
        // 但**授权开关不在那里** —— 它是员工必须点一次的东西，常驻在「③ 登录认证」层头（下面单独断言）。
        await phase('环境信息页', async () => {
          await moduleButton('环境信息').click()
          await page.waitForTimeout(1500)
          const envText = await body()
          checks.that('环境信息显示真实平台', /darwin|linux|win32/.test(envText))
          // 四层结论必须在（分层是这一版的全部意义）。
          checks.that(
            '环境信息按四层给结论',
            envText.includes('② 工具') && envText.includes('③ 登录认证')
              && envText.includes('④ 上传配置') && envText.includes('⑤ 外部数据'),
          )
          checks.that('每层给出「x/y 已就绪」计数', /\d+\/\d+ 已就绪/.test(envText))
          checks.that('环境信息显示氚云与钉钉', envText.includes('氚云') && envText.includes('钉钉'))
          checks.that('环境信息显示 iFinD 密钥状态', envText.includes('iFinD'))
          checks.that('环境信息显示 OSS 上传配置', envText.includes('OSS'))
          checks.that('环境信息显示通过率与阻塞计数', envText.includes('已通过') && envText.includes('未通过'))
          // 复制入口全页只留一处（用户反馈：环境页上的「复制提示词 / 复制」按钮太多且没用）。
          // 授权弹框挡在前面时整页不可达，这时跳过（弹框本身由「授权弹框」那段单独断言）。
          if (!envText.includes('需要一项授权')) {
            const copyEntry = page.getByRole('button', { name: '复制安装提示词' })
            const copyCount = await copyEntry.count()
            checks.that('全页只有一枚「复制安装提示词」按钮', copyCount === 1, `找到 ${copyCount} 个`)
            checks.that('旧的「复制提示词」按钮已删除', await page.getByRole('button', { name: '复制提示词' }).count() === 0)
            checks.that('旧的重生成按钮已删除', await page.getByRole('button', { name: '重新生成' }).count() === 0)
          }
          // ① 只讲插件选定的案例根目录：不该因为"你从哪个会话点进来"而变样。
          checks.that('① 不拿当前会话说事（换会话不会变）', !envText.includes('不是同一个') && !envText.includes('的会话中打开工作台'))
          await page.screenshot({ path: join(out, 'env.png') })

          // 员工视野里不该出现维护者信息：那些只在「排查详情」里。
          const detailsHead = page.locator('.crwu-audit-details-head').first()
          checks.that('页脚有「排查详情」入口', await detailsHead.count() > 0)
          checks.that('排查详情默认不展开', !envText.includes('运行环境信息'), envText.slice(0, 120).replace(/\s+/g, ' '))
          // 授权是**插件级门槛**：没有授权，氚云待办取不到、钉钉也回传不了，所以它用一个弹框
          // 把整页挡住（「同意并继续」/「拒绝」→ 拒绝屏 + 「再次授权」），不再是 ③ 里一个可以
          // 悄悄忽略掉的勾选框（用户 2026-09-22 明确要这种形式）。
          if (envText.includes('需要一项授权')) {
            // 未授权：弹框必须挡住整页（报告页的入口一个都不许露出来），并给出两个明确动作。
            checks.that('未授权时弹框挡住整页（报告页不出现）', !envText.includes('报告列表'))
            checks.that('未授权弹框给出「同意并继续」', envText.includes('同意并继续'))
            checks.that('未授权弹框给出「拒绝」', envText.includes('拒绝'))
            // 没授权时插件不可用：要说「需要授权」，而不是谎报「未登录」。
            checks.that('未授权时状态词不说「未登录」', !envText.includes('钉钉认证｜未登录'))
          } else {
            // 已授权：③ 层头常驻这一行（文案由 client-package.test.mjs 逐字盯着）。
            checks.that('已授权后 ③ 层头常驻「已授权读取本机凭据」', envText.includes('已授权读取本机凭据'))
          }

          // 就绪的层收成一行：层里的路径要点开才出现。逐层点开，核对真实探测值。
          const layerHeads = page.locator('.crwu-audit-layer-head')
          const layerCount = await layerHeads.count()
          checks.that('四层都画出来了', layerCount === 4, `实际 ${String(layerCount)} 层`)
          for (let index = 0; index < layerCount; index += 1) {
            const expanded = String(await layerHeads.nth(index).getAttribute('aria-expanded') ?? '')
            if (expanded === 'false') await layerHeads.nth(index).click()
          }
          await page.waitForTimeout(300)
          const expandedText = await body()
          checks.that('展开后能看到真实二进制路径', expandedText.includes('/Users/') || expandedText.includes('/usr/'))
          checks.that('展开后能看到工具版本', /\d+\.\d+/.test(expandedText))
          // ④ 层里的 AK 表单：员工要填的只有 ID 与 Secret —— STS Token 与 endpoint 由插件
          // 自己处理（用户 2026-09-22 反馈「这两个不需要配置」）。断言按**这一层里的输入框**
          // 数量来，避免被页面上别处的同名字样满足（文本包含式断言踩过）。
          const akCard = page.locator('.crwu-audit-card').filter({ hasText: '填 AccessKey' }).first()
          checks.that('④ 的 AK 表单就在这一层里', await akCard.count() > 0)
          const akInputs = await akCard.locator('input').count()
          checks.that('AK 表单只有 ID 与 Secret 两个输入框', akInputs === 2, `实际 ${String(akInputs)} 个`)
          checks.that(
            'AK 表单不再要 STS Token / endpoint',
            await akCard.getByText(/STS|endpoint/i).count() === 0,
          )
          await page.screenshot({ path: join(out, 'env-layers.png') })

          // 排查详情：点开后才是维护者信息（清单来源、运行环境信息、审核根会话）。
          await detailsHead.click()
          await page.waitForTimeout(300)
          const detailText = await body()
          checks.that('展开排查详情后出现运行环境信息', detailText.includes('运行环境信息'))
          checks.that('运行环境信息里给出审核根会话', detailText.includes('审核根会话'))
          checks.that('排查详情里给出清单来源', detailText.includes('环境清单'))
          checks.that('排查详情里给出工具版本约束', detailText.includes('期望'))
          checks.that('排查详情里不再需要授权开关（它常驻在 ③ 登录认证 层）', !detailText.includes('记住氚云授权'))
          await page.screenshot({ path: join(out, 'env-details.png') })
        })

        // ── 重新自检也要有加载态（用户点下去到结论出来有好几秒）────────────────
        await phase('重新自检加载态', async () => {
          const recheck = page.getByRole('button', { name: '重新自检' }).first()
          if (await recheck.count() === 0) {
            checks.that('环境信息页有「重新自检」按钮', false)
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
              checks.that('不通过时点进去会被拦住（报告页不出现）', !blockedText.includes('报告列表'))
              checks.that('拦住时给出明确说明', blockedText.includes('环境自检未通过'))
              await page.screenshot({ path: join(out, 'gate.png') })
            } else {
              checks.that('环境信息页存在「进入报告审核」入口', false, '按钮都没渲染出来')
            }
            return
          }
          // 从环境信息页回到报告审核（通过时这个按钮就是放行的）。
          const back = page.getByRole('button', { name: '进入报告审核' }).first()
          if (await back.count() > 0) {
            await back.click()
            await page.waitForTimeout(2000)
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
          const risks = await page.$$eval(
            'td.crwu-audit-td-nowrap .crwu-audit-badge',
            (nodes) => nodes.map((node) => (node.textContent ?? '').trim()),
          )
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
          await page.screenshot({ path: join(out, 'pending.png') })
        })

        // ── 报告审核页：一层大圆角框 + 下划线页签 + 小鲸鱼（拉文件 → 气泡 / 直跳） ──
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
          const tabBgs = await page.locator('.crwu-audit-tab').evaluateAll(
            (nodes) => nodes.map((node) => getComputedStyle(node).backgroundColor),
          )
          // 文字型 Workspace Tabs：容器透明无底（不是灰胶囊），选中靠 600 + 品牌色指示条。
          checks.that(
            '页签容器透明（不再是灰色大胶囊）',
            String(await page.locator('.crwu-audit-tabs').first().evaluate((n) => getComputedStyle(n).backgroundColor))
              === 'rgba(0, 0, 0, 0)',
          )
          const ind = await page.locator('.crwu-audit-tab-ind').first().evaluate((n) => {
            const s = getComputedStyle(n)
            return { h: s.height, bg: s.backgroundColor, radius: s.borderRadius, w: Math.round(n.getBoundingClientRect().width) }
          })
          checks.that(
            '选中页签下方有品牌色指示条（2px / 圆角 / 24–40px 宽）',
            ind.h === '2px' && ind.bg === 'rgb(216, 74, 74)' && ind.w >= 24 && ind.w <= 40,
            JSON.stringify(ind),
          )
          checks.that(
            '选中页签加粗（文字型选中态）',
            String(await page.locator('.crwu-audit-tab-on').first().evaluate((n) => getComputedStyle(n).fontWeight)) === '600',
          )
          const tabText = (await page.locator('.crwu-audit-tabs').innerText()).replace(/\s+/g, ' ')
          checks.that(
            '两个页签就叫「报告列表 / AI 审核列表」',
            tabText.includes('报告列表') && tabText.includes('AI 审核列表'),
            tabText,
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
            String(await lastAction.getAttribute('aria-label') ?? '') === '与Deepseek一起讨论这份报告',
            String(await lastAction.getAttribute('aria-label') ?? ''),
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
            const bubble = page.locator('.crwu-audit-ai-ask').first()
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
              await page.locator('.crwu-audit-ai-ask-backdrop').first().click()
              await page.waitForFunction(
                () => document.querySelector('.crwu-audit-ai-ask') === null,
                undefined,
                { timeout: 10_000 },
              ).catch(() => undefined)
              checks.that('点遮罩能关掉气泡', await page.locator('.crwu-audit-ai-ask').count() === 0)
            }
            checks.that('拉文件只列举、不下载对象内容（没有 oss-result）', !ops.includes('oss-result'), ops.join(','))
          }
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
          await page.screenshot({ path: join(out, 'results.png') })
        })

        // ── 按流水号查云端交付件（**「AI审核结果」页自己的工具条**）─────────────
        // 用户要求：输入报告流水号 → 点查找 → 拼该流水号去 OSS 找交付件。这里盯五条：
        // 工具条在、输入过程不列举 OSS（只在点「查找」时发一次）、不存在的流水号明确说「没有」、
        // 命中的流水号真的列出交付件、点「清空」回到全量且不重新列举。
        await phase('按流水号查找', async () => {
          const search = page.getByPlaceholder(/输入报告流水号/).first()
          checks.that('「AI审核结果」页里有「按流水号」查找框', await search.count() === 1)
          // 位置也是需求的一部分（用户 2026-09-22 纠正过）：它是**这一页自己的工具条**，
          // 必须长在「AI审核结果」那张卡片里，而不是浮在两个标签之上。
          // 报告页**不再套 Card**（用户口径：减少 Card/Header/Container 层级），
          // 所以这只查找框的归属判据改成"在 AI 审核列表这一页的正文里、且是唯一的一只"。
          // 后面几段还要用它取"结果行"（列表正文区）。报告页不再套 Card，所以正文区就是它。
          const resultCard = page.locator('.crwu-audit-pane-main')
          checks.that(
            '查找框在 AI 审核列表这一页的正文里（且全页只有一只）',
            await page.locator('.crwu-audit-pane-main input').count() === 1,
            `正文里输入框 ${await page.locator('.crwu-audit-pane-main input').count()} 个`,
          )

          // 真流水号必须从**这一页的表格行**里取，不能扫整页文本：
          //   - 搜索之后页面上多了「正在看：流水号 … 的交付件」，里面装的正是刚输入的假流水号，
          //     正则会把它当成"真"的（踩过 —— 命中用例一直在查一个不存在的号）；
          //   - 左侧会话列表里现在还会出现「报告讨论 · <流水号>」这样的会话名（工作台 2026-09-22
          //     的讨论会话），整页扫描会先把**氚云待审核的**流水号捞出来，而它根本不在云端清单里
          //     （踩过 —— 命中用例假红，看起来像查找功能坏了）。
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

          // 条件等待**这一次**应答落地（状态行换成这个流水号），不要抢在应答之前断言：
          // 请求在飞的时候页面还画着全量清单，那时断言命中等于是断言旧的列表。
          const watching = (seqNo) => `正在看：流水号 ${seqNo} 的交付件`
          await page.getByRole('button', { name: '查找' }).first().click()
          await page.waitForFunction(
            (text) => document.body.innerText.includes(text),
            watching(fake),
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
            await page.getByRole('button', { name: '查找' }).first().click()
            await page.waitForFunction(
              (text) => document.body.innerText.includes(text) && document.body.innerText.includes('查看报告'),
              watching(realSeq),
              { timeout: 60_000 },
            ).catch(() => undefined)
            // 同样只看**结果行**：整页断言会被左侧那条同名会话（报告讨论 · <流水号>）满足。
            const hit = await resultCard.locator('tbody tr').first().innerText()
            checks.that('存在的流水号能列出交付件与「查看报告」', hit.includes(realSeq) && hit.includes('查看报告'), hit.replace(/\s+/g, ' ').slice(0, 120))
            checks.that('查找命中也只发一次列举', ossListings() === before + 2, `现在 ${ossListings()} 次`)
            await page.screenshot({ path: join(out, 'cloud-search-hit.png') })

            // 「清空」只是一个视图切回全量：不许把已经取到的云端清单丢掉，也不许重新列举 OSS。
            await page.getByRole('button', { name: '清空' }).first().click()
            await page.waitForFunction(
              () => document.body.innerText.includes('正在看：全部云端交付件'),
              undefined,
              { timeout: 30_000 },
            ).catch(() => undefined)
            const cleared = await body()
            checks.that(
              '点「清空」回到全量云端清单',
              cleared.includes('正在看：全部云端交付件') && cleared.includes('查看报告'),
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
          checks.that('切回环境信息仍然正常渲染', (await body()).includes('② 工具'))
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
