import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const load = () => import('../../../src/host/integrations/valuation-workflow/native-pdf.ts')
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJtkAAAAASUVORK5CYII=', 'base64')
async function fixture(t, patch = {}) {
  const root = await mkdtemp(join(tmpdir(), 'crwu-native-pdf-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const casePath = join(root, 'case')
  await mkdir(join(casePath, '提取结果'), { recursive: true })
  const path = join(casePath, '合成.pdf')
  const bytes = Buffer.from('%PDF-1.7\nsynthetic\n%%EOF')
  await writeFile(path, bytes)
  const node = join(root, 'node')
  const cli = join(root, 'office-cli.js')
  await writeFile(node, 'synthetic executable')
  await writeFile(cli, 'synthetic CLI')
  const digest = createHash('sha256').update(bytes).digest('hex')
  const calls = { tools: [], shell: [] }
  const execution = { token: Symbol('actual-control'), rootCallId: 'root-control', agent: { id: 'parent', session: { id: 'parent' } }, signal: new AbortController().signal }
  const ctx = { get: (name) => name === 'tools' ? { execute: async (input) => {
    calls.tools.push(input)
    return { isError: false, value: { name: 'office-render', provider: patch.provider ?? 'dsh-office',
      content: 'Host supplied rendering instructions\n\n## Installed LibreOffice Kit\n\nUse these absolute paths for every LibreOffice Kit command. Pass the CLI entry as the first argument to Node.\n\n' + JSON.stringify({ libreofficeKit: { node, cli } }) } }
  } } : undefined }
  const access = { authorize: () => ({ ok: patch.denied !== true, error: '合成拒绝' }), note() {}, runShell: async (call, command) => {
    calls.shell.push({ call, command })
    if (command.includes('capabilities')) return { ok: true, stdout: JSON.stringify({ imageRendering: { inputs: patch.noPdf ? ['docx'] : ['pdf'], output: 'png', pdfBackend: 'pdfium' } }), stderr: '', exitCode: 0 }
    const match = /--output-dir\s+(?:'([^']+)'|"([^"]+)"|([^\s]+))/.exec(command)
    assert.ok(match, 'native render must use a fresh case-local output directory')
    const out = match[1] ?? match[2] ?? match[3]
    await mkdir(out)
    const image = join(out, 'page-0000.png')
    await writeFile(image, patch.invalidPng ? Buffer.from('invalid') : PNG)
    const manifest = { schemaVersion: 1, backend: 'native', rasterEngine: 'pdfium', source: 'saved', inputPath: path,
      sourceSha256: patch.changedDigest ? '0'.repeat(64) : digest, dpi: 144, pageCount: 1,
      images: [{ index: patch.indexOne ? 1 : 0, page: 1, path: patch.escape ? join(root, 'outside.png') : image, width: 1, height: 1, byteLength: PNG.length }], missingFonts: [] }
    await writeFile(join(out, 'manifest.json'), JSON.stringify(manifest))
    return { ok: true, stdout: JSON.stringify(manifest), stderr: '', exitCode: 0 }
  } }
  const { createDshWorkflowPdfRenderer } = await load()
  const renderer = createDshWorkflowPdfRenderer({ ctx, access, world: { platform: async () => 'darwin-arm64' }, execution })
  return { renderer, calls, execution, input: { casePath, path, fileName: '合成.pdf', digest: 'sha256:' + digest, signal: execution.signal } }
}

test('native PDF images come from the official scoped skill runtime and verified source manifest', async (t) => {
  const f = await fixture(t)
  const result = await f.renderer.render(f.input)
  assert.equal(result.ok, true, result.error)
  assert.equal(f.calls.tools[0].name, 'skill')
  assert.deepEqual(f.calls.tools[0].arguments, { name: 'office-render' })
  assert.equal(f.calls.tools[0].parent, f.execution.token)
  assert.equal(f.calls.tools[0].rootCallId, f.execution.rootCallId)
  assert.equal(f.calls.tools[0].agent, f.execution.agent)
  assert.equal(f.calls.shell.length, 2, 'probe before the first render')
  assert.equal(result.extracted.pageCount, 1)
  assert.equal(result.extracted.images.length, 1)
  assert.match(result.extracted.images[0].description, /第1页/)
  assert.equal(result.extracted.text, '')
  assert.equal(result.extracted.pagesWithText, undefined, 'rendering does not prove native text-layer availability')
  assert.equal(result.extracted.capabilities.pdfRender, true)
  assert.deepEqual(await readFile(join(f.input.casePath, '提取结果', result.extracted.images[0].path)), PNG,
    'the existing visual reader resolves page locators from the extraction root')
})
for (const patch of [{ provider: 'workspace-override' }, { noPdf: true }, { changedDigest: true }, { escape: true }, { invalidPng: true }]) {
  test('native PDF admission refuses ' + JSON.stringify(patch), async (t) => {
    const f = await fixture(t, patch)
    const result = await f.renderer.render(f.input)
    assert.equal(result.ok, false)
    assert.equal(result.extracted, undefined)
    if (patch.provider) assert.equal(f.calls.shell.length, 0)
    if (patch.noPdf) assert.equal(f.calls.shell.length, 1)
  })
}
test('denied PDF rendering never resolves a skill or starts a command', async (t) => {
  const f = await fixture(t, { denied: true })
  assert.equal((await f.renderer.render(f.input)).ok, false)
  assert.equal(f.calls.tools.length, 0)
  assert.equal(f.calls.shell.length, 0)
})


test('native manifest page identity is independent of zero or one based image ordinals', async (t) => {
  const f = await fixture(t, { indexOne: true })
  const result = await f.renderer.render(f.input)
  assert.equal(result.ok, true, result.error)
  assert.match(result.extracted.images[0].description, /第1页/)
})
