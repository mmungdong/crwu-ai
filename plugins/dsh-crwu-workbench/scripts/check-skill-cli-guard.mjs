/**
 * 非 vendored 技能的 **CLI 静态守卫**。
 *
 * 为什么需要它：结构化 Tool 的约束写在提示词里只是「请求」。只要某个技能的正文里还留着
 * 一句「先执行 `crwu h3yun files list …`」，模型就会照着它去拼命令行 —— 于是沙箱、审批与
 * 取消全被绕开，Finder 启动的桌面端还会直接 `command not found`。
 *
 * 口径（与 `plugins/AGENTS.md` §5.6 一致）：
 * - **扫**：`skills/crwu/**`（自研层）与 `common/skills/**`（公共层，打包前同步进来的那份同源）；
 * - **不扫**：`skills/dws/**`（vendored 上游正文，冲突时以上游为准）；
 * - **活跃指令**里禁止出现：裸 `crwu` / `dws` / `ossutil` 命令、`which`/`command -v` 查命令、
 *   `export PATH=`、包内 `bin/<平台>/` 绝对路径、`~/bin/<命令>` 副本；
 * - **窄范围豁免**：`legacy-compat` 区块（技能里显式标注的「非 DSH 宿主兼容章节」）、
 *   紧随 `{"exempt-next"}` 标记的单行（历史说明 / 负面示例），以及显式列出的文件级豁免
 *   （每条都要写理由）。**禁止整层豁免**：vendored 层以外的任何技能根都必须被扫到。
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

/**
 * 文件级豁免：每条都必须写清理由。
 *
 * 判据是「这个文件里出现的 CLI 用法**不是**给审核链路的活跃指令」——
 * 例如示例夹具、或者只描述历史事实的变更纪要。
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

/** 活跃指令里禁止的形态。每一条都对应一类真实退化。 */
const RULES = [
  {
    id: 'bare-cli',
    // 命令名后面必须跟一个「小写拉丁字母 / +」开头的子命令词，才算是命令行用法；
    // 这样 `crwu-audit`、`crwu_h3yun_record_get`、`crwu 技能` 都不会误报。
    pattern: /(^|[^A-Za-z0-9_./-])(crwu|dws|ossutil)\s+\+?[a-z][\w+-]*/,
    message: '活跃指令里出现裸业务 CLI 命令（DSH 环境必须改用结构化 Tool）',
  },
  { id: 'which', pattern: /\bwhich\s+(crwu|dws|ossutil)\b/, message: '禁止让 agent 去 which 查找业务命令' },
  { id: 'command-v', pattern: /\bcommand\s+-v\s+(crwu|dws|ossutil)\b/, message: '禁止让 agent 用 command -v 查找业务命令' },
  { id: 'path-export', pattern: /export\s+PATH=/, message: '禁止在技能里给 PATH 注入方式' },
  {
    id: 'plugin-bin',
    pattern: /bin\/(darwin-arm64|win32-x64|linux-x64|\$\{?platform)/,
    message: '禁止在技能里引用插件包内二进制目录',
  },
  { id: 'home-bin', pattern: /~\/bin\/(crwu|dws|ossutil)/, message: '禁止让 agent 往 ~/bin 拷命令副本' },
]

/**
 * 扫一份技能文档的文本，返回活跃指令里的违规项。
 *
 * 导出成函数是为了**可测**：守卫自己也要能被证伪（塞一行裸 `crwu h3yun records list`
 * 进去必须变红，塞进 `legacy-compat` 区块里必须变绿），否则它只是"看起来在守"。
 *
 * @param text 文档全文。
 * @param file 仅用于报告的相对路径。
 * @returns 违规项数组（空 = 通过）。
 */
export function scanSkillDoc(text, file = '<memory>') {
  const problems = []
  let inRegion = false
  let exemptNext = false
  text.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim()
    if (trimmed === REGION_START) { inRegion = true; return }
    if (trimmed === REGION_END) { inRegion = false; return }
    if (trimmed === EXEMPT_NEXT) { exemptNext = true; return }
    if (inRegion || exemptNext) { exemptNext = false; return }
    for (const rule of RULES) {
      if (rule.pattern.test(line)) {
        problems.push({ file, line: index + 1, rule: rule.id, message: rule.message, text: trimmed.slice(0, 160) })
      }
    }
  })
  return problems
}

/** 递归收集 `.md`（技能正文与 references）。 */
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
    if (!entry.name.endsWith('.md')) continue
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
const scanned = []
const exempted = []

if (isMain) for (const root of SCAN_ROOTS) {
  for (const file of await collect(root.path)) {
    scanned.push(relative(REPO, file))
    const reason = exemptionFor(file)
    if (reason !== '') {
      exempted.push({ file: relative(REPO, file), reason })
      continue
    }
    problems.push(...scanSkillDoc(await readFile(file, 'utf8'), relative(REPO, file)))
  }
}

if (!isMain) {
  // 被 import 时只提供 `scanSkillDoc`，不做 IO、不设退出码。
} else if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ scanned: scanned.length, exempted, problems }, null, 2))
} else if (problems.length === 0) {
  console.log(`PASS     技能 CLI 守卫：扫描 ${scanned.length} 个技能文档，0 处活跃裸 CLI`)
} else {
  console.error(`FAIL     技能 CLI 守卫：${problems.length} 处活跃裸 CLI`)
  for (const problem of problems) {
    console.error(`  ${problem.file}:${problem.line}  [${problem.rule}] ${problem.message}`)
    console.error(`      ${problem.text}`)
  }
  console.error('  说明：DSH 环境下必须改用结构化 Tool；非 DSH 兼容章节请用')
  console.error(`  ${REGION_START} / ${REGION_END} 包起来。`)
}

process.exitCode = problems.length === 0 ? 0 : 1
