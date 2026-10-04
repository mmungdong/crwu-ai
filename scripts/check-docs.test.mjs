import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  checkLocalLinks,
  checkReadmeDynamicFacts,
  extractMarkdownTargets,
} from './check-docs.mjs'

test('local links resolve relative paths with fragments, URL encoding, and angle brackets', () => {
  const content = [
    '[guide](guide.md#usage)',
    '[spaced](<reference/My%20Guide.md>)',
    '![image](images/diagram.png?raw=1)',
  ].join('\n')
  const existing = new Set([
    '/repo/docs/guide.md',
    '/repo/docs/reference/My Guide.md',
    '/repo/docs/images/diagram.png',
  ])

  assert.deepEqual(
    checkLocalLinks({
      filePath: '/repo/docs/index.md',
      content,
      pathExists: (candidate) => existing.has(candidate),
    }),
    [],
  )
})

test('external links, mail links, and same-page anchors are ignored', () => {
  const content = [
    '[web](https://example.com/path)',
    '[protocol relative](//example.com/path)',
    '[mail](mailto:team@example.com)',
    '[anchor](#section)',
  ].join('\n')

  assert.deepEqual(
    checkLocalLinks({
      filePath: '/repo/README.md',
      content,
      pathExists: () => false,
    }),
    [],
  )
})

test('a missing local target reports its document, line, and resolved path', () => {
  const [issue] = checkLocalLinks({
    filePath: '/repo/docs/index.md',
    content: 'See [missing](missing.md).',
    pathExists: () => false,
  })

  assert.equal(issue.filePath, '/repo/docs/index.md')
  assert.equal(issue.line, 1)
  assert.equal(issue.target, 'missing.md')
  assert.equal(issue.resolvedPath, '/repo/docs/missing.md')
})

test('a line limit checks active navigation without rewriting historical body links', () => {
  const issues = checkLocalLinks({
    filePath: '/repo/docs/CHANGELOG.md',
    content: '[current](manual.md)\n\n## History\n[old](removed.md)\n',
    lineLimit: 2,
    pathExists: (candidate) => candidate === '/repo/docs/manual.md',
  })

  assert.deepEqual(issues, [])
})

test('README guard rejects fixed Workbench versions and numeric Skill totals', () => {
  const content = [
    '![Plugin](https://img.shields.io/badge/Workbench-0.0.4-red)',
    'Install `dsh-crwu-workbench@0.0.38`.',
    'The repository contains 44 Skills.',
    '仓库包含 44 个可安装的 Skills。',
  ].join('\n')

  const issues = checkReadmeDynamicFacts({
    filePath: '/repo/README.md',
    content,
  })

  assert.equal(issues.filter((issue) => issue.kind === 'fixed-workbench-version').length, 2)
  assert.equal(issues.filter((issue) => issue.kind === 'fixed-skill-total').length, 2)
})

test('README guard accepts placeholders and non-numeric Skill descriptions', () => {
  const content = [
    'Install `dsh-crwu-workbench@latest`.',
    'Release with `git tag plugin-v<version>`.',
    'Skills are discovered from their directories.',
    'Skills 按目录自动发现。',
  ].join('\n')

  assert.deepEqual(
    checkReadmeDynamicFacts({ filePath: '/repo/README.md', content }),
    [],
  )
})

test('README guard catches common prose forms of dynamic versions and totals', () => {
  const content = [
    'Workbench version 0.0.38',
    '当前工作台版本是 0.0.38。',
    'Skills total: 44',
    '仓库包含 44 个技能。',
  ].join('\n')
  const issues = checkReadmeDynamicFacts({ filePath: '/repo/README.md', content })

  assert.equal(issues.filter((issue) => issue.kind === 'fixed-workbench-version').length, 2)
  assert.equal(issues.filter((issue) => issue.kind === 'fixed-skill-total').length, 2)
})

test('target extraction ignores Markdown code spans', () => {
  const content = '`[example](missing.md)` and [real](present.md)'

  assert.deepEqual(extractMarkdownTargets(content), [
    { line: 1, target: 'present.md' },
  ])
})

test('CI runs checker tests before the repository documentation scan', () => {
  const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
  const testIndex = workflow.indexOf('node --test scripts/*.test.mjs')
  const scanIndex = workflow.indexOf('node scripts/check-docs.mjs')

  assert.ok(testIndex >= 0, 'root Node tests must run in CI')
  assert.ok(scanIndex > testIndex, 'documentation scan must run after its tests')
})
