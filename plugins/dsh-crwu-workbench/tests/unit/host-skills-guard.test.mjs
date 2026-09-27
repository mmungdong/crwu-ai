/**
 * 技能侧的门禁测试。
 *
 * 两条独立的约束：
 *
 * 1. **非 vendored 技能的活跃指令里不许再出现裸业务 CLI**（`crwu` / `dws` / `ossutil`）、
 *    `which` / `command -v` / `export PATH=` / 包内 `bin/<平台>/` 路径；
 *    这一条由 `scripts/check-skill-cli-guard.mjs` 守，测试既验证它现在通过，也**证伪**它
 *    （塞一行裸命令必须变红、放进兼容区块必须变绿）。
 * 2. **vendored `skills/dws/**` 原样保留**：正文与 provenance 都不属于本次改写范围，
 *    由 `npm run dws:check` 按 provenance 摘要守。
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'

const run = promisify(execFile)
const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
// 用命名空间导入：新增的 `scanSkillScript` 在旧实现里不存在时，
// 只有「用到它」的用例会红，而不是整个文件在导入期就挂掉（RED 更精确）。
const guard = await import(new URL('scripts/check-skill-cli-guard.mjs', `file://${ROOT}/`).href)
const { scanSkillDoc } = guard

test('the CLI guard rejects a bare business command in an active instruction', () => {
  // 证伪：把旧文案原样塞回去，必须被抓住。规则要是永远绿，它就不是门禁。
  for (const line of [
    '源材料只经单附件定向下载：`crwu h3yun file get --id <FileId> --out <材料-源/…>`。',
    '先执行 dws profile list --format json 解析组织。',
    '然后用 ossutil cp -f 交付件上传。',
    '`crwu` 是 Go 二进制，可用 `which crwu` 验证。',
    '用 `command -v dws` 确认命令存在。',
    '在同一条命令里先 `export PATH="/plug/bin/darwin-arm64:$PATH"`。',
    '把命令拷到 `~/bin/ossutil` 再调用。',
    '二进制真实位置：`<包根>/bin/win32-x64/dws.exe`。',
  ]) {
    assert.equal(scanSkillDoc(line).length > 0, true, `必须抓住这一行：${line}`)
  }
})

test('the CLI guard does not fire on tool names, prose or the compatibility region', () => {
  assert.deepEqual(scanSkillDoc('调用 `crwu_h3yun_record_get({ caseDir, seqNo })` 取记录。'.replace('seqNo', 'objectId')), [])
  assert.deepEqual(scanSkillDoc('本链路只允许使用 CRWU 结构化 Tool（硬约束）。'), [])
  assert.deepEqual(scanSkillDoc('改走 crwu-h3yun-query 技能继续查询。'), [])
  const region = [
    '<!-- crwu-cli-guard:legacy-compat-start -->',
    '## 非 DSH 宿主兼容层（legacy CLI）',
    'crwu h3yun session login',
    'dws profile list --format json',
    '<!-- crwu-cli-guard:legacy-compat-end -->',
    '这一行是活跃指令，必须干净。',
  ].join('\n')
  assert.deepEqual(scanSkillDoc(region), [])
  const single = ['<!-- crwu-cli-guard:exempt-next -->', '（历史记录：当时用 `dws doc read` 取正文）'].join('\n')
  assert.deepEqual(scanSkillDoc(single), [])
  // 区块结束后必须重新开始检查：这是「窄范围豁免」与「整文件豁免」的分界。
  const afterRegion = [
    '<!-- crwu-cli-guard:legacy-compat-start -->',
    'dws wiki +node-list --workspace <ID>',
    '<!-- crwu-cli-guard:legacy-compat-end -->',
    'dws wiki +node-list --workspace <ID>',
  ].join('\n')
  const problems = scanSkillDoc(afterRegion)
  assert.equal(problems.length, 1)
  assert.equal(problems[0].line, 4)
})

test('the guard passes over the whole non-vendored skill corpus', async () => {
  const { stdout } = await run(process.execPath, [join(ROOT, 'scripts', 'check-skill-cli-guard.mjs')], { cwd: ROOT })
  assert.match(stdout, /0 处活跃裸 CLI/)
  const count = Number(/扫描 (\d+) 个技能文档/.exec(stdout)?.[1] ?? '0')
  assert.ok(count > 100, `扫描到的技能文档太少（${count}），扫描根可能没生效`)
})

test('the audit main path has no CLI compatibility region at all', async () => {
  // 自动审核主路径（router 技能 + 提示词指向的两份 reference）**不引用**兼容层：
  // 它必须是纯粹的 Tool 编排，否则模型会照抄兼容层里的命令。
  for (const relative of [
    'skills/crwu/crwu-audit/SKILL.md',
    'skills/crwu/crwu-audit/references/00-input-and-route-profile.md',
    'skills/crwu/crwu-audit/references/13-dingtalk-result-publish.md',
  ]) {
    const text = await readFile(join(ROOT, relative), 'utf8')
    assert.equal(text.includes('crwu-cli-guard:legacy-compat'), false, `${relative} 不许引用兼容层`)
    assert.deepEqual(scanSkillDoc(text, relative), [], `${relative} 里仍有活跃裸 CLI`)
  }
})

test('the shared H3Yun / DWS skills tell the two hosts apart explicitly', async () => {
  const nodes = [
    ['plugins/common/skills/crwu-dws/SKILL.md', /DSH 环境/, /非 DSH 宿主兼容层/],
    ['plugins/common/skills/crwu-h3yun-login/SKILL.md', /DSH 环境/, /非 DSH 宿主兼容层/],
    ['plugins/common/skills/crwu-h3yun-query/SKILL.md', /DSH 环境/, /非 DSH 宿主兼容层/],
  ]
  for (const [relative, dsh, compat] of nodes) {
    const text = await readFile(join(dirname(dirname(ROOT)), relative), 'utf8')
    assert.match(text, dsh, `${relative} 必须写明 DSH 形态`)
    assert.match(text, compat, `${relative} 必须把非 DSH CLI 方式独立成兼容章节`)
    assert.match(text, /crwu_audit_capabilities|crwu_h3yun_record_get|crwu_audit_knowledge_materialize/, `${relative} 要指出 DSH 的 Tool 入口`)
    assert.match(text, /capability gap/, `${relative} 要写清能力缺失时如实报告、不降级成 shell 查找`)
  }
})

// ---------------------------------------------------------------------------
// 2026-09-25 扩展：守卫必须覆盖技能自带脚本（`.py` / `.js` / `.mjs`），而不只是 Markdown。
//
// 背景（真实退化）：`crwu-audit/scripts/upload_audit_result.py` 用
// `DwsClient(binary="dws")` + `subprocess.run(command)` 直接驱动 `dws`，绕开了
// 审批/沙箱/取消管道；旧守卫只收 `.md`，所以整类旁路完全漏检。
// 口径：不允许 installable Skill 内的脚本以 subprocess / child_process / shell /
// 裸命令调用 `crwu` / `dws` / `ossutil`；归档与通知只能走结构化 Tool。
// ---------------------------------------------------------------------------

test('the CLI guard rejects a Python script that shells out to a business CLI', () => {
  const cases = [
    ['argv-list', 'completed = subprocess.run(["dws", "wiki", "+space-list", "--format", "json"])'],
    ['popen', 'process = subprocess.Popen(["crwu", "h3yun", "records", "list"])'],
    ['shell-true', 'subprocess.run("dws doc +export --node " + node_id, shell=True)'],
    ['os-system', 'os.system("ossutil cp -f 审核意见.html oss://protected/")'],
    ['os-popen', 'os.popen("dws profile list --format json").read()'],
    ['check-output', 'subprocess.check_output("crwu h3yun apps list", shell=True)'],
  ]
  for (const [label, line] of cases) {
    const problems = guard.scanSkillScript(`${line}\n`, `probe-${label}.py`)
    assert.ok(problems.length > 0, `必须抓住 .py 里对业务 CLI 的执行（${label}）：${line}`)
  }
})

test('the CLI guard rejects the indirection that hid the real bypass', () => {
  // 真实形态：可执行字面量在常量/默认参数里，执行原语在另一个函数里，两者不在同一行。
  // 只做「同一行内匹配」的守卫抓不住它 —— 这正是旧实现漏掉的那一类。
  const source = [
    'import subprocess',
    '',
    'class DwsClient:',
    '    def __init__(self, binary: str = "dws"):',
    '        self.binary = binary',
    '',
    '    def run_json(self, args):',
    '        command = [self.binary, *list(args)]',
    '        return subprocess.run(command, text=True, check=False)',
  ].join('\n')
  const problems = guard.scanSkillScript(source, 'upload_audit_result.py')
  assert.ok(problems.length > 0, '常量里的 "dws" 与 subprocess 同时出现时必须被抓住')
})

test('the CLI guard rejects Node child_process calls to a business CLI', () => {
  const cases = [
    ['.mjs', "import { execSync } from 'node:child_process'\nexecSync('dws doc +export --node ' + nodeId)\n"],
    ['.mjs', "const { spawn } = require('child_process')\nspawn('crwu', ['h3yun', 'records', 'list'])\n"],
    ['.js', "const cp = require('node:child_process')\ncp.execFileSync('ossutil', ['cp', '-f', src, dst])\n"],
    ['.js', 'execSync(`dws wiki +space-list --format json`)\n'],
  ]
  for (const [ext, source] of cases) {
    const problems = guard.scanSkillScript(source, `probe${ext}`)
    assert.ok(problems.length > 0, `必须抓住 ${ext} 里对业务 CLI 的 child_process 调用：${source.trim()}`)
  }
})

test('the CLI guard rejects relative and bundled command paths', () => {
  const docs = [
    '直接调用 `./crwu h3yun session login` 即可。',
    '用 `../crwu` 或 `./bin/darwin/crwu` 都能跑。',
    '二进制真实位置：`bin/darwin-arm64/crwu`。',
    '包内 `bin/<平台>/dws` 直连。',
  ]
  for (const line of docs) {
    assert.ok(guard.scanSkillDoc(line).length > 0, `必须抓住正文里的相对/捆绑路径：${line}`)
  }
  const scripts = [
    'subprocess.run(["./crwu", "h3yun", "records", "list"])',
    'subprocess.run(["./bin/darwin-arm64/dws", "wiki", "+space-list"])',
    'child_process.execSync("./crwu h3yun apps list")',
  ]
  for (const line of scripts) {
    assert.ok(guard.scanSkillScript(`${line}\n`, 'probe.py').length > 0, `必须抓住脚本里的相对/捆绑路径：${line}`)
  }
})

test('the extended guard stays silent on prose, fixtures and non-business subprocess', () => {
  // 正文侧反例：工具名 / 技能名 / schema 串 / 纯散文。
  assert.deepEqual(guard.scanSkillDoc('本仓是 crwu / dws 两层。'), [])
  assert.deepEqual(guard.scanSkillDoc('schema 为 `crwu.kb-catalog.snapshot.v1`。'), [])
  assert.deepEqual(guard.scanSkillDoc('调用 `crwu_audit_capabilities` 自检。'), [])
  assert.deepEqual(guard.scanSkillDoc('用 crwu-h3yun-query 技能继续查询。'), [])
  // 脚本侧反例：非业务 CLI 的 subprocess / 只做断言的字符串 / 测试夹具数据。
  assert.deepEqual(guard.scanSkillScript('result = subprocess.run([sys.executable, str(CHECKER), "validate"])\n'), [])
  assert.deepEqual(guard.scanSkillScript('self.assertIn("dws drive +download", reference_text)\n'), [])
  assert.deepEqual(guard.scanSkillScript('("bin", "用 `./bin/darwin/crwu` 登录。")\n'), [])
  assert.deepEqual(guard.scanSkillScript('path = skill_path("crwu-dev-audit-skill-maintainer/scripts/kb_tool.py")\n'), [])
  assert.deepEqual(guard.scanSkillScript('r = subprocess.run(["textutil", "-convert", "docx", path])\n'), [])
})

test('the compatibility markers cannot switch the guard off inside a script', () => {
  // `legacy-compat` / `exempt-next` 是给 Markdown 章节用的 HTML 注释；若它们能作用于脚本，
  // 就等于给出一条「用注释关掉检查」的规避通道。脚本侧只认代码本身。
  const source = [
    '# <!-- crwu-cli-guard:legacy-compat-start -->',
    'subprocess.run(["dws", "wiki", "+space-list"])',
    '# <!-- crwu-cli-guard:legacy-compat-end -->',
    '# <!-- crwu-cli-guard:exempt-next -->',
    'os.system("crwu h3yun records list")',
  ].join('\n')
  const problems = guard.scanSkillScript(source, 'probe.py')
  assert.ok(problems.length >= 2, '脚本里的兼容注释不得豁免任何检查')
  assert.deepEqual([...new Set(problems.map((p) => p.line))].sort((a, b) => a - b), [2, 5])
})

test('the runtime skill tree ships no script that shells out to a business CLI', async () => {
  // 回归锁：真实旁路脚本及其契约测试都不得再出现在 installable Skill 里。
  for (const relative of [
    'skills/crwu/crwu-audit/scripts/upload_audit_result.py',
    'skills/crwu/crwu-audit/scripts/test_upload_audit_result.py',
  ]) {
    await assert.rejects(readFile(join(ROOT, relative), 'utf8'), `${relative} 不得随技能安装`)
  }
})

test('the guard scans skill scripts as well as skill docs, with no blanket exemption', async () => {
  const { stdout } = await run(
    process.execPath,
    [join(ROOT, 'scripts', 'check-skill-cli-guard.mjs'), '--json'],
    { cwd: ROOT },
  )
  const report = JSON.parse(stdout)
  assert.equal(report.problems.length, 0, `技能树里仍有 CLI 旁路：${JSON.stringify(report.problems, null, 2)}`)
  assert.ok(report.scanned.docs > 100, `扫描到的技能文档太少（${report.scanned.docs}），扫描根可能没生效`)
  assert.ok(report.scanned.scripts > 15, `扫描到的技能脚本太少（${report.scanned.scripts}），脚本类型没被收进扫描面`)
  for (const entry of report.exempted) {
    assert.match(entry.file, /(examples?|fixtures?)\//, `豁免必须落在 examples/fixtures：${entry.file}`)
    assert.ok(entry.reason.length > 0, `豁免必须写理由：${entry.file}`)
  }
  const source = await readFile(join(ROOT, 'scripts', 'check-skill-cli-guard.mjs'), 'utf8')
  const block = /const FILE_EXEMPTIONS = \[([\s\S]*?)\n\]/.exec(source)?.[1] ?? ''
  assert.ok(!/scripts\/|\.py|\.mjs|\.js\b|skills\//.test(block), '文件级豁免不得按目录或文件类型放行')
})

test('the vendored dws layer is untouched and still gated by its provenance', async () => {
  const dwsRoot = join(ROOT, 'skills', 'dws')
  const provenance = JSON.parse(await readFile(join(dwsRoot, 'provenance.json'), 'utf8'))
  assert.equal(typeof provenance, 'object')
  const skills = (await readdir(dwsRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  assert.ok(skills.length >= 14, `vendored 层技能数偏少（${skills.length}）`)
  // 守卫必须明确排除这一层：它的正文是上游 `dingtalk-workspace-cli` 的原样拷贝，
  // 冲突时以上游为准（口径见 `skills/README.md`）。
  const guard = await readFile(join(ROOT, 'scripts', 'check-skill-cli-guard.mjs'), 'utf8')
  assert.match(guard, /VENDORED/, '守卫必须显式排除 vendored 层')
  const { stdout } = await run('npm', ['run', 'dws:check'], { cwd: ROOT })
  assert.match(`${stdout}`, /provenance|dws/i)
})
