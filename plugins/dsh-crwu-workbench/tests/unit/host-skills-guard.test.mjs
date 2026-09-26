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
const { scanSkillDoc } = await import(new URL('scripts/check-skill-cli-guard.mjs', `file://${ROOT}/`).href)

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
