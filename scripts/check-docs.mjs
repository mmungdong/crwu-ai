import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const CHECKED_DOCUMENTS = [
  { path: 'AGENTS.md' },
  { path: 'plugins/AGENTS.md' },
  { path: 'plugins/dsh-crwu-workbench/AGENTS.md' },
  { path: 'plugins/dsh-crwu-workbench/README.md' },
  { path: 'plugins/dsh-crwu-workbench/docs/releasing.md' },
  { path: 'README.md', readme: true },
  { path: 'README.zh-CN.md', readme: true },
  { path: 'docs/skills.md' },
  { path: 'docs/agent-skill-dirs.md' },
  { path: 'docs/v0.0.1/cli-manual.md' },
  { path: 'docs/v0.0.1/cli-command-contract.md' },
  { path: 'docs/v0.0.1/CHANGELOG.md', lineLimit: 8 },
  { path: 'docs/review-crwu-audit-skills.md', lineLimit: 8 },
  { path: 'docs/v0.0.1/2026-09-11-crwu-audit-backlog.md', lineLimit: 8 },
  { path: 'docs/superpowers/plans/2026-09-21-plugin-yaml-config.md', lineLimit: 8 },
  { path: 'docs/superpowers/plans/2026-09-28-crwu-plugin-self-update.md', lineLimit: 8 },
  { path: 'docs/superpowers/specs/2026-09-28-crwu-plugin-self-update-design.md', lineLimit: 8 },
  { path: 'docs/v0.0.1/superpowers/plans/2026-09-03-h3y-dingtalk-login.md', lineLimit: 8 },
  { path: 'docs/v0.0.1/superpowers/plans/2026-09-03-repository-restructure.md', lineLimit: 8 },
  { path: 'docs/v0.0.1/superpowers/plans/2026-09-08-dws-source-and-download-contract.md', lineLimit: 8 },
  { path: 'docs/v0.0.1/superpowers/plans/2026-09-09-crwu-audit-multiaxis-router.md', lineLimit: 8 },
  { path: 'docs/v0.0.1/superpowers/plans/2026-09-10-crwu-audit-skill-maintainer.md', lineLimit: 8 },
  { path: 'docs/v0.0.1/superpowers/plans/2026-09-15-crwu-audit-optimize-gap-analysis.md', lineLimit: 8 },
  { path: 'docs/v0.0.1/superpowers/plans/2026-09-16-readme-redesign.md', lineLimit: 8 },
  { path: 'docs/v0.0.1/superpowers/plans/2026-09-17-audit-report-readability.md', lineLimit: 8 },
  { path: 'docs/v0.0.1/superpowers/specs/2026-09-03-repository-restructure-design.md', lineLimit: 8 },
  { path: 'docs/v0.0.1/superpowers/specs/2026-09-08-dws-source-and-download-contract-design.md', lineLimit: 8 },
  { path: 'docs/v0.0.1/superpowers/specs/2026-09-09-crwu-audit-multiaxis-router-design.md', lineLimit: 8 },
  { path: 'docs/v0.0.1/superpowers/specs/2026-09-10-crwu-audit-skill-maintainer-design.md', lineLimit: 8 },
  { path: 'docs/v0.0.1/superpowers/specs/2026-09-15-crwu-audit-optimize-gap-analysis-design.md', lineLimit: 8 },
  { path: 'docs/v0.0.1/superpowers/specs/2026-09-17-audit-report-readability-design.md', lineLimit: 8 },
  { path: 'plugins/dsh-crwu-workbench/docs/acceptance-0.0.34.md', lineLimit: 8 },
  { path: 'plugins/dsh-crwu-workbench/docs/desktop-acceptance-0.0.15.md', lineLimit: 8 },
  { path: 'plugins/dsh-crwu-workbench/docs/handoff-0.0.15.md', lineLimit: 8 },
  { path: 'plugins/dsh-crwu-workbench/docs/review-0.0.15.md', lineLimit: 8 },
]

const EXTERNAL_TARGET = /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i
const LINK_PATTERN = /!?\[[^\]]*\]\(\s*(<[^>]+>|[^)\s]+)(?:\s+["'][^"']*["'])?\s*\)/g
const FIXED_WORKBENCH_VERSIONS = [
  /(?:dsh-crwu-workbench@|\bWorkbench\b(?:\s+(?:version|is|currently|at))*\s*[-:：]?|工作台(?:当前)?(?:版本)?(?:是|为|[:：-])?\s*)\d+\.\d+\.\d+/gi,
  /\d+\.\d+\.\d+\s*(?:is\s+the\s+current\s+)?(?:\bWorkbench\b|工作台)/gi,
]
const FIXED_SKILL_TOTALS = [
  /AI%20Skills-\d+/gi,
  /\b\d+\s+(?:(?:independently\s+installable|portable)\s+)?(?:AI\s+)?Skills\b/gi,
  /\d+\s*个[^\n]{0,32}\bSkills\b/gi,
  /\bSkills?\b\s*(?:(?:total|count)\s*)?[:：为是]?\s*\d+/gi,
  /技能\s*(?:(?:总数|数量)\s*)?[:：为是]?\s*\d+/g,
  /\d+\s*个\s*(?:(?:可独立安装|可安装)的?\s*)?技能/g,
]

function withoutInlineCode(line) {
  return line.replace(/(`+)(.*?)\1/g, '')
}

export function extractMarkdownTargets(content, { lineLimit } = {}) {
  const targets = []
  const lines = content.split(/\r?\n/)
  let fence = null

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1
    if (lineLimit && lineNumber > lineLimit) break

    const trimmed = lines[index].trimStart()
    const fenceMatch = trimmed.match(/^(```+|~~~+)/)
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1][0]
      else if (fence === fenceMatch[1][0]) fence = null
      continue
    }
    if (fence) continue

    const line = withoutInlineCode(lines[index])
    for (const match of line.matchAll(LINK_PATTERN)) {
      const rawTarget = match[1]
      const target = rawTarget.startsWith('<') && rawTarget.endsWith('>')
        ? rawTarget.slice(1, -1)
        : rawTarget
      targets.push({ line: lineNumber, target })
    }
  }

  return targets
}

function decodeTarget(target) {
  try {
    return decodeURIComponent(target)
  } catch {
    return target
  }
}

export function checkLocalLinks({
  filePath,
  content,
  rootDir,
  lineLimit,
  pathExists = existsSync,
}) {
  const issues = []

  for (const link of extractMarkdownTargets(content, { lineLimit })) {
    if (EXTERNAL_TARGET.test(link.target)) continue

    const fileTarget = decodeTarget(link.target.split('#', 1)[0].split('?', 1)[0])
    if (!fileTarget) continue

    const resolvedPath = fileTarget.startsWith('/') && rootDir
      ? path.resolve(rootDir, `.${fileTarget}`)
      : path.resolve(path.dirname(filePath), fileTarget)

    if (!pathExists(resolvedPath)) {
      issues.push({
        kind: 'missing-local-link',
        filePath,
        line: link.line,
        target: link.target,
        resolvedPath,
      })
    }
  }

  return issues
}

export function checkReadmeDynamicFacts({ filePath, content }) {
  const issues = []
  const lines = content.split(/\r?\n/)

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const lineNumber = index + 1

    for (const pattern of FIXED_WORKBENCH_VERSIONS) {
      for (const match of line.matchAll(pattern)) {
        issues.push({
          kind: 'fixed-workbench-version',
          filePath,
          line: lineNumber,
          value: match[0],
        })
      }
    }

    for (const pattern of FIXED_SKILL_TOTALS) {
      for (const match of line.matchAll(pattern)) {
        issues.push({
          kind: 'fixed-skill-total',
          filePath,
          line: lineNumber,
          value: match[0],
        })
      }
    }
  }

  return issues
}

export function checkRepository(rootDir) {
  const issues = []

  for (const document of CHECKED_DOCUMENTS) {
    const filePath = path.join(rootDir, document.path)
    if (!existsSync(filePath)) {
      issues.push({ kind: 'missing-active-document', filePath, line: 1 })
      continue
    }

    const content = readFileSync(filePath, 'utf8')
    issues.push(...checkLocalLinks({
      filePath,
      content,
      rootDir,
      lineLimit: document.lineLimit,
    }))
    if (document.readme) {
      issues.push(...checkReadmeDynamicFacts({ filePath, content }))
    }
  }

  return issues
}

function formatIssue(issue, rootDir) {
  const location = `${path.relative(rootDir, issue.filePath)}:${issue.line}`
  if (issue.kind === 'missing-local-link') {
    return `${location} missing local link ${issue.target} -> ${path.relative(rootDir, issue.resolvedPath)}`
  }
  if (issue.kind === 'fixed-workbench-version') {
    return `${location} fixed Workbench version is not allowed: ${issue.value}`
  }
  if (issue.kind === 'fixed-skill-total') {
    return `${location} fixed Skill total is not allowed: ${issue.value}`
  }
  return `${location} active document is missing`
}

function main() {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const issues = checkRepository(rootDir)
  if (issues.length === 0) {
    console.log(`docs check passed (${CHECKED_DOCUMENTS.length} document entry points)`)
    return
  }

  for (const issue of issues) console.error(formatIssue(issue, rootDir))
  process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main()
}
