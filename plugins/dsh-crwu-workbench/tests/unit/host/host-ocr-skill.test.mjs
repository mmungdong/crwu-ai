/**
 * `crwu-ocr` 共享能力：Host 暂存 + 审核指令路由。
 *
 * 两个独立约束：
 * 1. 模型只能提交案例内的 `ocr-skill/scripts/*.py`；Host 首次调用时从安装包暂存脚本，
 *    并把随包 wheel 根写进 `runtime.json`（依赖不逐案复制）。
 * 2. 审核指令必须把 PDF/图片判读路由到 `crwu-ocr`，而不是让子代理直接读原始文件。
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const ROOT = new URL('../../../', import.meta.url)
const PACKAGE_DIR = fileURLToPath(new URL('.', ROOT)).replace(/[\\/]$/, '')
const { stageOcrSkill, isOcrSkillScript, ocrCaseArgumentProblem, OCR_RUNTIME_FILES } = await import(
  new URL('src/host/domains/report-audit/ocr-skill.ts', ROOT).href)
const { auditPrompt } = await import(new URL('src/host/domains/report-audit/prompt.ts', ROOT).href)

const SKILL_RELATIVE = ['skills', 'capabilities', 'crwu-ocr']

test('the packaged skill ships its runtime scripts, manifest and wheels', () => {
  const skillRoot = join(PACKAGE_DIR, ...SKILL_RELATIVE)
  assert.equal(existsSync(join(skillRoot, 'SKILL.md')), true, 'crwu-ocr 入口缺失')
  for (const name of OCR_RUNTIME_FILES) {
    assert.equal(existsSync(join(skillRoot, 'scripts', name)), true, `运行时脚本缺失：${name}`)
  }
  assert.equal(existsSync(join(skillRoot, 'vendor', 'wheels', 'manifest.json')), true, '依赖清单缺失')
  const manifest = JSON.parse(readFileSync(join(skillRoot, 'vendor', 'wheels', 'manifest.json'), 'utf8'))
  assert.equal(manifest.packages.pypdf.platforms.includes('any'), true, 'pypdf 必须全平台随包')
  assert.equal(manifest.packages.pypdfium2.platforms.includes('win32-x64'), true, 'Windows 渲染依赖必须随包')
  assert.equal(manifest.runtimeProvided.Pillow.module, 'PIL', 'Pillow 由 DSH 运行时提供')
})

test('stageOcrSkill writes scripts and a runtime config that points at the packaged wheels', async () => {
  const casePath = await mkdtemp(join(tmpdir(), 'crwu-ocr-stage-'))
  try {
    const writes = []
    let ensured = ''
    const result = await stageOcrSkill({
      casePath,
      sourceRoot: PACKAGE_DIR,
      ensureDir: async (path) => { ensured = path; return { ok: true, error: '' } },
      writeText: async (path, content) => { writes.push({ path, content }); return { ok: true, error: '' } },
    })
    assert.equal(result.ok, true, result.error)
    assert.equal(ensured, join(casePath, 'ocr-skill', 'scripts'))
    assert.equal(writes.length, OCR_RUNTIME_FILES.length + 1)
    for (const name of OCR_RUNTIME_FILES) {
      const write = writes.find((item) => item.path.endsWith(name))
      assert.ok(write, `没有暂存 ${name}`)
      assert.ok(write.content.length > 100, `${name} 内容为空`)
    }
    const config = JSON.parse(writes.find((item) => item.path.endsWith('runtime.json')).content)
    assert.equal(config.skill, 'crwu-ocr')
    assert.equal(config.wheelRoot, join(PACKAGE_DIR, ...SKILL_RELATIVE, 'vendor', 'wheels'))
    assert.equal(result.wheelRoot, config.wheelRoot)
  } finally {
    await rm(casePath, { recursive: true, force: true })
  }
})

test('stageOcrSkill fails closed when the package is incomplete', async () => {
  const casePath = await mkdtemp(join(tmpdir(), 'crwu-ocr-stage-missing-'))
  try {
    const result = await stageOcrSkill({
      casePath,
      sourceRoot: join(casePath, 'no-such-package'),
      ensureDir: async () => ({ ok: true, error: '' }),
      writeText: async () => ({ ok: true, error: '' }),
    })
    assert.equal(result.ok, false)
    assert.match(result.error, /crwu-ocr/)
  } finally {
    await rm(casePath, { recursive: true, force: true })
  }
})

test('only the four OCR scripts are staged on demand', () => {
  for (const name of ['ocr_prepare', 'ocr_record', 'ocr_merge', 'ocr_status']) {
    assert.equal(isOcrSkillScript(`ocr-skill/scripts/${name}.py`), true, name)
    assert.equal(isOcrSkillScript(`ocr-skill\\scripts\\${name}.py`), true, `${name} (windows separator)`)
    // 这些写法在 macOS/NTFS 上解析到同一个文件：只认字面串等于给校验留后门。
    assert.equal(isOcrSkillScript(`ocr-skill//scripts/${name}.py`), true, `${name} (double separator)`)
    assert.equal(isOcrSkillScript(`ocr-skill/./scripts/${name}.py`), true, `${name} (dot segment)`)
    assert.equal(isOcrSkillScript(`./ocr-skill/scripts/${name}.py`), true, `${name} (leading dot)`)
    assert.equal(isOcrSkillScript(`OCR-SKILL/scripts/${name}.py`), true, `${name} (case variant)`)
  }
  for (const value of ['ocr-skill/scripts/other.py', 'scripts/ocr_prepare.py', '../ocr-skill/scripts/ocr_prepare.py', '']) {
    assert.equal(isOcrSkillScript(value), false, value)
  }
})

test('OCR scripts may only run against this audit case', () => {
  const casePath = '/tmp/workspace/2026-301705-LX10170/'
  assert.equal(ocrCaseArgumentProblem(['--case', '/tmp/workspace/2026-301705-LX10170'], casePath, 'darwin'), '')
  assert.equal(ocrCaseArgumentProblem(['--case=/tmp/workspace/2026-301705-LX10170/'], casePath, 'darwin'), '')
  assert.match(ocrCaseArgumentProblem([], casePath, 'darwin'), /--case/)
  assert.match(ocrCaseArgumentProblem(['--case', 'relative/path'], casePath, 'darwin'), /绝对路径/)
  assert.match(ocrCaseArgumentProblem(['--case', '/tmp/workspace/other-case'], casePath, 'darwin'), /本轮案例目录/)
  assert.equal(
    ocrCaseArgumentProblem(['--case', 'C:\\Cases\\A'], 'c:\\cases\\a\\', 'win32'), '',
    'Windows 路径比较不区分大小写与结尾分隔符')
  // 重复出现时 Python argparse 取**最后**一个：只看第一个等于让脚本换到别的案例。
  assert.match(
    ocrCaseArgumentProblem(['--case', '/tmp/workspace/2026-301705-LX10170', '--case', '/tmp/other'],
      casePath, 'darwin'),
    /只允许出现一次/)
  assert.match(
    ocrCaseArgumentProblem(['--case=/tmp/workspace/2026-301705-LX10170', '--case', '/tmp/other'],
      casePath, 'darwin'),
    /只允许出现一次/)
})

test('the audit prompt routes PDF and image reading through crwu-ocr', () => {
  const text = auditPrompt({
    objectId: 'obj-1',
    seqNo: '2026-301705-LX10170-BG8746',
    project: '示例项目',
    workspace: '/tmp/workspace',
    isRetry: false,
    snapshot: {
      attemptId: 'a-1', dir: '/tmp/workspace/2026-301705-LX10170-BG8746/输入快照',
      recordPath: '/tmp/workspace/2026-301705-LX10170-BG8746/输入快照/报告记录.json',
      attachmentsPath: '/tmp/workspace/2026-301705-LX10170-BG8746/输入快照/附件清单.json',
      metadataPath: '/tmp/workspace/2026-301705-LX10170-BG8746/输入快照/快照元数据.json',
      digest: 'sha256:0'.padEnd(71, '0'), fieldCount: 1, attachmentCount: 0,
      objectId: 'obj-1', seqNo: '2026-301705-LX10170-BG8746',
    },
    python: { path: '/tmp/python', versionText: '3.12.14', distributions: { openpyxl: '3.1.5' } },
  })
  assert.match(text, /## OCR \/ 图片判读：统一走 crwu-ocr 技能/)
  assert.match(text, /ocr-skill\/scripts\/ocr_prepare\.py/)
  assert.match(text, /ocr-skill\/scripts\/ocr_record\.py/)
  assert.match(text, /ocr-skill\/scripts\/ocr_merge\.py/)
  assert.match(text, /ocr-skill\/scripts\/ocr_status\.py/)
  assert.match(text, /已生成页图 ≠ 已识别/)
  assert.match(text, /未核 ≠ 缺失/)
})

test('audit references route page-level reading through crwu-ocr', async () => {
  const files = [
    'skills/crwu/crwu-audit/references/00-input-and-route-profile.md',
    'skills/crwu/crwu-audit/references/14-orchestration-workflow.md',
    'skills/crwu/crwu-audit-datacheck/references/01-runtime-and-check-catalog.md',
  ]
  for (const file of files) {
    const body = readFileSync(join(PACKAGE_DIR, ...file.split('/')), 'utf8')
    assert.match(body, /crwu-ocr/, `${file} 没有路由到共享 OCR 能力`)
  }
  const workflow = readFileSync(
    join(PACKAGE_DIR, 'skills', 'crwu', 'crwu-audit', 'references', '14-orchestration-workflow.md'), 'utf8')
  assert.match(workflow, /ocr-skill\/scripts\/ocr_prepare\.py/, '编排流程没有给出可执行的 OCR 脚本路径')
  assert.match(workflow, /ocr_record\.py/, '编排流程没有要求记录识别结果')
  assert.match(workflow, /ocr_merge\.py/, '编排流程没有要求合并页序文本')
})
