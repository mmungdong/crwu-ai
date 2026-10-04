import { readFileSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

function parseVersion(value) {
  const match = String(value).trim().match(/^(\d+)\.(\d+)\.(\d+)$/)
  if (!match) throw new Error(`${value} is not a valid semantic version`)
  return match.slice(1).map(Number)
}

function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index]
  }
  return 0
}

export function nextPatchVersion(version) {
  const [major, minor, patchVersion] = parseVersion(version)
  return `${major}.${minor}.${patchVersion + 1}`
}

export function publishPreflightIssues({
  packageName,
  localVersion,
  latestVersion,
  confirmation,
  gitClean,
  npmUser,
  registry = 'https://registry.npmjs.org',
  packageRegistry = 'https://registry.npmjs.org',
  requireConfirmation = true,
}) {
  const issues = []
  const expectedConfirmation = `${packageName}@${localVersion}`

  if (registry !== packageRegistry) {
    issues.push({
      code: 'registry-mismatch',
      message: `registry ${registry} must match package publishConfig ${packageRegistry}`,
    })
  }
  if (requireConfirmation && confirmation !== expectedConfirmation) {
    issues.push({
      code: 'confirmation-mismatch',
      message: `set CONFIRM_PUBLISH=${expectedConfirmation}`,
    })
  }
  if (!gitClean) {
    issues.push({ code: 'dirty-worktree', message: 'Git worktree is not clean' })
  }
  if (!npmUser) {
    issues.push({ code: 'npm-not-authenticated', message: 'npm login is required' })
  }
  if (compareVersions(localVersion, latestVersion) <= 0) {
    issues.push({
      code: 'version-not-newer',
      message: `local ${localVersion} must be newer than npm ${latestVersion}`,
    })
  }

  return issues
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const detail = options.capture ? String(result.stderr || result.stdout).trim() : ''
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`)
  }
  return options.capture ? String(result.stdout).trim() : ''
}

function parseArguments(argv) {
  const [action, ...rest] = argv
  const values = new Map()
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index]
    const value = rest[index + 1]
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error(`invalid argument near ${key || '<end>'}`)
    }
    values.set(key.slice(2), value)
  }
  return { action, values }
}

function required(values, key) {
  const value = values.get(key)
  if (!value) throw new Error(`--${key} is required`)
  return value
}

function packageFacts(pluginDir, npmCommand, registry) {
  const manifest = JSON.parse(readFileSync(path.join(pluginDir, 'package.json'), 'utf8'))
  const latestVersion = run(
    npmCommand,
    ['view', manifest.name, 'version', `--registry=${registry}`],
    { capture: true },
  )
  return {
    packageName: manifest.name,
    localVersion: manifest.version,
    latestVersion,
    registry,
    packageRegistry: manifest.publishConfig?.registry || '',
  }
}

function printFacts(facts) {
  console.log(`package: ${facts.packageName}`)
  console.log(`local version: ${facts.localVersion}`)
  console.log(`npm latest: ${facts.latestVersion}`)
  console.log(`suggested patch: ${nextPatchVersion(facts.latestVersion)}`)
  console.log(`registry: ${facts.registry}`)
}

function main() {
  const { action, values } = parseArguments(process.argv.slice(2))
  const pluginDir = path.resolve(required(values, 'plugin-dir'))
  const npmCommand = values.get('npm') || 'npm'
  const registry = values.get('registry') || 'https://registry.npmjs.org'
  const facts = packageFacts(pluginDir, npmCommand, registry)

  if (action === 'info') {
    printFacts(facts)
    return
  }

  if (action !== 'preflight') throw new Error(`unknown action: ${action || '<empty>'}`)

  const repoRoot = path.resolve(required(values, 'repo-root'))
  const npmUser = run(npmCommand, ['whoami', `--registry=${registry}`], {
    cwd: pluginDir,
    capture: true,
  })
  const gitState = run('git', ['status', '--short'], { cwd: repoRoot, capture: true })
  const requireConfirmation = values.get('require-confirmation') === 'true'
  const issues = publishPreflightIssues({
    ...facts,
    confirmation: values.get('confirmation') || '',
    gitClean: gitState === '',
    npmUser,
    requireConfirmation,
  })

  printFacts(facts)
  console.log(`npm user: ${npmUser}`)
  if (issues.length > 0) {
    for (const issue of issues) console.error(`${issue.code}: ${issue.message}`)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
