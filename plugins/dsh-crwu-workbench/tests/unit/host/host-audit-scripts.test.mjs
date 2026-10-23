/**
 * 审核技能脚本的随包依赖位置（`src/host/domains/report-audit/audit-scripts.ts`）。
 *
 * 钉住三件事：
 * 1. 只把 `scripts/<name>.py` 认作审核脚本（OCR 暂存目录有自己的判定，不能串）；
 * 2. `runtime.json` 记的是**安装包里** wheel 目录的绝对路径，模型提交不了；
 * 3. 那个目录里真的有一份可用的 `pypdf`（否则 `prepare_materials.py` 会把每个 PDF
 *    记成 `pypdf-error`，整类推给视觉判读——2026-10-22 现场）。
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const ROOT = new URL('../../../', import.meta.url)
const {
  isAuditScript, auditVendorRoot, auditRuntimeConfig,
} = await import(new URL('src/host/domains/report-audit/audit-scripts.ts', ROOT).href)

test('只认案例内的审核脚本：scripts/<name>.py', () => {
  assert.equal(isAuditScript('scripts/prepare_materials.py'), true)
  assert.equal(isAuditScript('scripts\\prepare_materials.py'), true, 'Windows 反斜杠同样成立')
  assert.equal(isAuditScript('./scripts/prepare_materials.py'), true)
  assert.equal(isAuditScript('ocr-skill/scripts/ocr_prepare.py'), false, 'OCR 暂存目录另有判定')
  assert.equal(isAuditScript('scripts/nested/prepare_materials.py'), false, '不认子目录')
  assert.equal(isAuditScript('scripts/prepare_materials.txt'), false)
  assert.equal(isAuditScript(''), false)
})

test('runtime.json 指向安装包里的 wheel 目录，且那份依赖真的在', () => {
  const vendor = auditVendorRoot()
  assert.notEqual(vendor, '', '包根解析失败时必须是空串（调用方按"没有依赖"记账）')
  assert.equal(existsSync(join(vendor, 'manifest.json')), true, `缺少 manifest：${vendor}`)

  const config = JSON.parse(auditRuntimeConfig())
  assert.equal(config.schemaVersion, 1)
  assert.equal(config.pythonVendor, vendor)

  const manifest = JSON.parse(readFileSync(join(vendor, 'manifest.json'), 'utf8'))
  const entry = manifest.packages.pypdf
  assert.equal(entry.module, 'pypdf')
  assert.equal(existsSync(join(vendor, entry.wheel)), true, `缺少 wheel：${entry.wheel}`)
})

test('runtime.json 只记录依赖位置，不夹带模型可控字段', () => {
  const config = JSON.parse(auditRuntimeConfig())
  assert.deepEqual(Object.keys(config).sort(), ['pythonVendor', 'pythonVendorNote', 'schemaVersion'])
})
