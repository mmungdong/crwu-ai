/**
 * 非 vendored 技能的 **CLI 静态守卫**。
 *
 * 为什么需要它：结构化 Tool 的约束写在提示词里只是「请求」。只要某个技能的正文或自带脚本里
 * 还留着一句「先执行 `crwu h3yun files list …`」，或一段 `subprocess.run(["dws", …])`，
 * 模型就会照着它去拼命令行 —— 于是沙箱、审批与取消全被绕开，Finder 启动的桌面端还会直接
 * `command not found`。
 *
 * 口径（与 `plugins/AGENTS.md` §5.6 一致）：
 * - **扫**：`skills/crwu/**`（自研层）与 `common/skills/**`（公共层，打包前同步进来的那份同源）里的
 *   `.md` / `.py` / `.js` / `.mjs`；
 * - **不扫**：`skills/dws/**`（vendored 上游正文，冲突时以上游为准）；
 * - **正文（`.md`）禁止**：裸 `crwu` / `dws` / `ossutil` 命令、相对路径形式（`./crwu`）、
 *   包内 `bin/…/<业务 CLI>` 路径、`which` / `command -v` 探测、`export PATH=`、`~/bin/<命令>`；
 * - **脚本（`.py` / `.js` / `.mjs`）禁止**：用 `subprocess` / `os.system` / `os.popen` /
 *   `child_process` / `execSync` / `spawn` 等执行原语驱动上述业务 CLI。既抓同一调用里的直接写法，
 *   也抓「可执行字面量写在常量/默认参数里、执行原语在别处」的间接写法 —— 后者是 2026-09-25
 *   真实漏检的形态（`DwsClient(binary="dws")` + `subprocess.run(command)`）。归档与通知只能经
 *   结构化 Tool（`crwu_audit_dingtalk_archive` / `crwu_audit_dingtalk_notify_self`）。
 *   守卫**只禁止业务 CLI**，不禁止一般子进程（`textutil`、`7z`、`sys.executable` 等照常）。
 * - **窄范围豁免**：`legacy-compat` 区块（技能里显式标注的「非 DSH 宿主兼容章节」）、
 *   紧随 `<!-- crwu-cli-guard:exempt-next -->` 标记的单行（历史说明 / 负面示例），以及显式列出的
 *   文件级豁免（每条都要写理由）。**禁止整层/整文件类型豁免**：vendored 层以外的任何技能都必须被扫到。
 *
 * 用法：`node scripts/check-skill-cli-guard.mjs [--json]`
 */
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const REPO = dirname(dirname(ROOT))

/** 受本守卫约束的技能根（相对插件目录）。公共层是源仓里的同一份。 */
const SCAN_ROOTS = [
  { path: join(ROOT, 'skills', 'crwu'), label: 'skills/crwu' },
  { path: join(REPO, 'plugins', 'common', 'skills'), label: 'plugins/common/skills' },
]

/** vendored 上游层：正文以 `dingtalk-workspace-cli` 为准，由 `npm run dws:check` 守。 */
const VENDORED = join(ROOT, 'skills', 'dws')

/** 同步产物目录：它是 `plugins/common/skills` 的拷贝，扫源仓那一份就够（避免重复报错）。 */
const GENERATED = join(ROOT, 'common', 'skills')

/** 受扫描的文件类型：技能正文 + 技能自带脚本（脚本也必须受同一口径约束）。 */
const SCAN_EXTENSIONS = ['.md', '.py', '.js', '.mjs']

/**
 * 文件级豁免：每条都必须写清理由。
 *
 * 判据是「这个文件里出现的 CLI 用法**不是**给审核链路的活跃指令」——
 * 例如示例夹具、或者只描述历史事实的变更纪要。**不得**按目录或文件类型放行。
 */
const FILE_EXEMPTIONS = [
  {
    match: /\/examples?\//,
    reason: '示例夹具：演示的是输入/输出形状，不是运行时步骤',
  },
  {
    match: /\/fixtures?\//,
    reason: '测试夹具',
  },
]

const REGION_START = '<!-- crwu-cli-guard:legacy-compat-start -->'
const REGION_END = '<!-- crwu-cli-guard:legacy-compat-end -->'
const EXEMPT_NEXT = '<!-- crwu-cli-guard:exempt-next -->'

/** DSH 审核链路里的业务 CLI：只能经结构化 Tool 调用，正文与脚本都不得自行执行。 */
const BUSINESS_CLI = '(crwu|dws|ossutil)'

/**
 * 业务 CLI 的**可执行字面量**：写成「要被执行的东西」的形态。
 *
 * 只认真正的字符串定界符 `"` 与 `'`。反引号在中文散文里常被当作引用号
 * （`("bin", "用 `./bin/darwin/crwu` 登录。")`），拿它当定界符会把文档夹具误判成路径字面量。
 * 反例（不得命中）：`crwu-audit`（技能名）、`crwu.kb-catalog.snapshot.v1`（schema 串）、
 * `FakeDws`（类名）、`crwu-dev-audit-skill-maintainer/scripts/kb_tool.py`（别的脚本路径）、
 * `"dws drive +download"`（文档断言文本）。
 */
const CLI_EXECUTABLE_LITERALS = [
  // "dws" / 'crwu'
  new RegExp(`["']${BUSINESS_CLI}["']`),
  // "…/dws"、"./crwu"、"bin/darwin-arm64/crwu"、"…/bin/win32-x64/dws.exe"
  new RegExp(`["'][^"'\\s]*[/\\\\]${BUSINESS_CLI}(?:\\.exe)?["']`),
]

/**
 * **只在「执行窗口」内**成立的命令串形态：被执行的字符串首词就是业务 CLI。
 * 窗口限定是必要的 —— `self.assertIn("dws drive +download", m2)` 这类文档断言
 * 与 `"dws drive +download"` 形状相同，但它不在任何执行调用的实参里。
 */
const CLI_WINDOW_STRINGS = [
  // "dws …" / 'crwu …' / `ossutil …`
  new RegExp(`["'\`]\\s*${BUSINESS_CLI}(?![\\w.-])`),
  // "./crwu …" / "../bin/x/dws …" / `./bin/darwin-arm64/crwu …`
  new RegExp(`["'\`]\\s*(?:\\.\\.?\\/)+(?:[^\\s"'\`]*\\/)?${BUSINESS_CLI}(?![\\w.-])`),
]

/**
 * 进程/命令执行原语（Python 与 Node）。
 * 守卫只用它判断「这段脚本会不会起子进程」，**不**据此单独报错。
 */
const EXEC_PRIMITIVE = new RegExp(
  '\\b(?:subprocess\\.(?:run|Popen|call|check_call|check_output|getoutput|getstatusoutput)' +
    '|os\\.system|os\\.popen|child_process' +
    '|exec|execSync|execFile|execFileSync|spawn|spawnSync|fork)\\b',
)

/** 执行调用的开括号位置，用来框出「这次执行的实参」。 */
const EXEC_CALL_OPEN = new RegExp(
  '\\b(?:subprocess\\.(?:run|Popen|call|check_call|check_output|getoutput|getstatusoutput)' +
    '|os\\.system|os\\.popen|child_process\\.\\w+' +
    '|exec|execSync|execFile|execFileSync|spawn|spawnSync|fork)\\s*\\(',
)

/** 正文（`.md`）行级规则。 */
const DOC_RULES = [
  {
    id: 'bare-cli',
    // 命令名后面必须跟一个「小写拉丁字母 / +」开头的子命令词，才算是命令行用法；
    // 这样 `crwu-audit`、`crwu_h3yun_record_get`、`crwu 技能` 都不会误报。
    pattern: /(^|[^A-Za-z0-9_./-])(crwu|dws|ossutil)\s+\+?[a-z][\w+-]*/,
    message: '活跃指令里出现裸业务 CLI 命令（DSH 环境必须改用结构化 Tool）',
  },
  { id: 'which', pattern: /\bwhich\s+(crwu|dws|ossutil)\b/, message: '禁止让 agent 去 which 查找业务命令' },
  {
    id: 'command-v',
    pattern: /\bcommand\s+-v\s+(crwu|dws|ossutil)\b/,
    message: '禁止让 agent 用 command -v 查找业务命令',
  },
  { id: 'path-export', pattern: /export\s+PATH=/, message: '禁止在技能里给 PATH 注入方式' },
  {
    id: 'plugin-bin',
    pattern: /bin\/(darwin-arm64|win32-x64|linux-x64|\$\{?platform)/,
    message: '禁止在技能里引用插件包内二进制目录',
  },
  {
    id: 'bundled-cli',
    pattern: new RegExp(
      `(^|[^A-Za-z0-9_./-])(?:[^\\s\`"']*\\/)?bin\\/[^\\s\`"']*\\/${BUSINESS_CLI}(?:\\.exe)?(?![A-Za-z0-9_.-])`,
    ),
    message: '禁止在技能里引用包内 `bin/…/<业务 CLI>` 路径',
  },
  {
    id: 'relative-cli',
    pattern: new RegExp(
      `(^|[^A-Za-z0-9_./-])(?:\\.\\.?\\/)+(?:[^\\s\`"']*\\/)?${BUSINESS_CLI}(?![A-Za-z0-9_.-])`,
    ),
    message: '禁止用相对路径调用业务 CLI（`./crwu`、`../bin/…/dws`）',
  },
  { id: 'home-bin', pattern: /~\/bin\/(crwu|dws|ossutil)/, message: '禁止让 agent 往 ~/bin 拷命令副本' },
]

/**
 * 脚本行级规则：与「是否起子进程」无关、单独出现即违规的形态。
 * 其余针对脚本的判定走执行窗口 / 执行原语（见 `scanSkillScript`），
 * 这样夹具字符串（`("bin", "用 \`./bin/darwin/crwu\` 登录。")`）不会被误报。
 */
const SCRIPT_LINE_RULES = DOC_RULES.filter((rule) =>
  ['which', 'command-v', 'path-export', 'home-bin'].includes(rule.id),
)

/** 逐行套用规则；支持 `legacy-compat` 区块与 `exempt-next` 单行豁免（**仅正文**）。 */
function scanLines(lines, rules, file, { allowRegionMarkers = false } = {}) {
  const problems = []
  let inRegion = false
  let exemptNext = false
  lines.forEach((line, index) => {
    const trimmed = line.trim()
    if (allowRegionMarkers) {
      if (trimmed === REGION_START) {
        inRegion = true
        return
      }
      if (trimmed === REGION_END) {
        inRegion = false
        return
      }
      if (trimmed === EXEMPT_NEXT) {
        exemptNext = true
        return
      }
      if (inRegion || exemptNext) {
        exemptNext = false
        return
      }
    }
    for (const rule of rules) {
      if (rule.pattern.test(line)) {
        problems.push({ file, line: index + 1, rule: rule.id, message: rule.message, text: trimmed.slice(0, 160) })
      }
    }
  })
  return problems
}

/** 框出每个执行调用的实参区间（按括号配平，最多向后看 12 行）。 */
function execCallWindows(lines) {
  const windows = []
  for (let index = 0; index < lines.length; index += 1) {
    if (!EXEC_CALL_OPEN.test(lines[index])) continue
    let depth = 0
    let opened = false
    let end = index
    scan: for (let cursor = index; cursor < lines.length && cursor <= index + 12; cursor += 1) {
      for (const char of lines[cursor]) {
        if (char === '(') {
          depth += 1
          opened = true
        } else if (char === ')') {
          depth -= 1
        }
      }
      end = cursor
      if (opened && depth <= 0) break scan
    }
    windows.push({ start: index + 1, end: end + 1 })
  }
  return windows
}

/**
 * 扫一份技能**正文**（`.md`）的文本，返回活跃指令里的违规项。
 *
 * 导出成函数是为了**可测**：守卫自己也要能被证伪（塞一行裸 `crwu h3yun records list`
 * 进去必须变红，塞进 `legacy-compat` 区块里必须变绿），否则它只是"看起来在守"。
 *
 * @param text 文档全文。
 * @param file 仅用于报告的相对路径。
 * @returns 违规项数组（空 = 通过）。
 */
export function scanSkillDoc(text, file = '<memory>') {
  return scanLines(text.split(/\r?\n/), DOC_RULES, file, { allowRegionMarkers: true })
}

/**
 * 扫一份技能**自带脚本**（`.py` / `.js` / `.mjs`）的文本，返回 CLI 旁路。
 *
 * 三类判定：
 * 1. 行级盲规则（`which crwu` / `command -v dws` / `export PATH=` / `~/bin/<命令>`）；
 * 2. **执行窗口**：某次执行的实参里直接出现业务 CLI 的可执行字面量或字符串命令；
 * 3. **执行原语 + 可执行字面量同文件出现**：覆盖「字面量在常量里、执行在别处」的间接旁路。
 *
 * 脚本**不认** `legacy-compat` / `exempt-next` 这两个 HTML 注释标记：它们是给 Markdown 章节用的，
 * 若能作用于脚本，就等于给出一条「用注释关掉检查」的规避通道（脚本侧也不需要这种豁免）。
 *
 * @param text 脚本全文。
 * @param file 仅用于报告的相对路径。
 * @returns 违规项数组（空 = 通过）。
 */
export function scanSkillScript(text, file = '<memory>') {
  const lines = text.split(/\r?\n/)
  const problems = scanLines(lines, SCRIPT_LINE_RULES, file)
  const reported = new Set(problems.map((problem) => problem.line))

  for (const window of execCallWindows(lines)) {
    for (let line = window.start; line <= window.end; line += 1) {
      if (line > lines.length) break
      const body = lines[line - 1] ?? ''
      const carriesCli =
        CLI_EXECUTABLE_LITERALS.some((pattern) => pattern.test(body)) ||
        CLI_WINDOW_STRINGS.some((pattern) => pattern.test(body))
      if (!carriesCli || reported.has(line)) continue
      reported.add(line)
      problems.push({
        file,
        line,
        rule: 'exec-cli-argv',
        message: '脚本用执行原语直接驱动业务 CLI（DSH 环境必须改用结构化 Tool）',
        text: body.trim().slice(0, 160),
      })
    }
  }

  if (EXEC_PRIMITIVE.test(text)) {
    lines.forEach((line, index) => {
      if (!CLI_EXECUTABLE_LITERALS.some((pattern) => pattern.test(line))) return
      const lineNumber = index + 1
      if (reported.has(lineNumber)) return
      reported.add(lineNumber)
      problems.push({
        file,
        line: lineNumber,
        rule: 'exec-cli-literal',
        message: '脚本把业务 CLI 写成可执行字面量，并与执行原语同文件出现（间接旁路）',
        text: line.trim().slice(0, 160),
      })
    })
  }

  return problems.sort((a, b) => a.line - b.line)
}

/** 按扩展名分派：`.md` 走正文规则，其余走脚本规则。 */
export function scanSkillFile(text, file = '<memory>') {
  return file.endsWith('.md') ? scanSkillDoc(text, file) : scanSkillScript(text, file)
}

/** 递归收集受扫描的技能文件（正文 + 脚本）。 */
async function collect(dir, out = []) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (full.startsWith(VENDORED) || full.startsWith(GENERATED)) continue
      await collect(full, out)
      continue
    }
    if (!SCAN_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) continue
    if (full.startsWith(VENDORED) || full.startsWith(GENERATED)) continue
    out.push(full)
  }
  return out
}

function exemptionFor(file) {
  for (const entry of FILE_EXEMPTIONS) {
    if (entry.match.test(file)) return entry.reason
  }
  return ''
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]
const problems = []
const scanned = { docs: 0, scripts: 0 }
const exempted = []

if (isMain) for (const root of SCAN_ROOTS) {
  for (const file of await collect(root.path)) {
    const relativePath = relative(REPO, file)
    if (relativePath.endsWith('.md')) scanned.docs += 1
    else scanned.scripts += 1
    const reason = exemptionFor(file)
    if (reason !== '') {
      exempted.push({ file: relativePath, reason })
      continue
    }
    problems.push(...scanSkillFile(await readFile(file, 'utf8'), relativePath))
  }
}

if (!isMain) {
  // 被 import 时只提供扫描函数，不做 IO、不设退出码。
} else if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ scanned, exempted, problems }, null, 2))
} else if (problems.length === 0) {
  console.log(
    `PASS     技能 CLI 守卫：扫描 ${scanned.docs} 个技能文档与 ${scanned.scripts} 个技能脚本，` +
      '0 处活跃裸 CLI / 旁路执行',
  )
} else {
  console.error(`FAIL     技能 CLI 守卫：${problems.length} 处 CLI 旁路`)
  for (const problem of problems) {
    console.error(`  ${problem.file}:${problem.line}  [${problem.rule}] ${problem.message}`)
    console.error(`      ${problem.text}`)
  }
  console.error('  说明：DSH 环境下业务 CLI 只能经结构化 Tool 调用；非 DSH 兼容章节请用')
  console.error(`  ${REGION_START} / ${REGION_END} 包起来。`)
}

process.exitCode = problems.length === 0 ? 0 : 1
