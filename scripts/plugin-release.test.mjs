import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  nextPatchVersion,
  publishPreflightIssues,
} from './plugin-release.mjs'

test('next patch version increments only the patch component', () => {
  assert.equal(nextPatchVersion('0.0.38'), '0.0.39')
  assert.equal(nextPatchVersion('2.7.9'), '2.7.10')
  assert.throws(() => nextPatchVersion('latest'), /valid semantic version/)
})

test('publish preflight accepts an intentional clean release above npm latest', () => {
  assert.deepEqual(publishPreflightIssues({
    packageName: 'dsh-crwu-workbench',
    localVersion: '0.0.39',
    latestVersion: '0.0.38',
    confirmation: 'dsh-crwu-workbench@0.0.39',
    gitClean: true,
    npmUser: 'maintainer',
  }), [])
})

test('publish preflight rejects ambiguous or unsafe release state', () => {
  const issues = publishPreflightIssues({
    packageName: 'dsh-crwu-workbench',
    localVersion: '0.0.38',
    latestVersion: '0.0.38',
    confirmation: 'yes',
    gitClean: false,
    npmUser: '',
  })

  assert.deepEqual(issues.map((issue) => issue.code), [
    'confirmation-mismatch',
    'dirty-worktree',
    'npm-not-authenticated',
    'version-not-newer',
  ])
})

test('publish preflight rejects a registry other than package publishConfig', () => {
  const issues = publishPreflightIssues({
    packageName: 'dsh-crwu-workbench',
    localVersion: '0.0.39',
    latestVersion: '0.0.38',
    confirmation: 'dsh-crwu-workbench@0.0.39',
    gitClean: true,
    npmUser: 'maintainer',
    registry: 'https://registry.example.com',
    packageRegistry: 'https://registry.npmjs.org',
  })

  assert.deepEqual(issues.map((issue) => issue.code), ['registry-mismatch'])
})

test('Makefile exposes the approved plugin release interface', () => {
  const makefile = readFileSync(new URL('../Makefile', import.meta.url), 'utf8')
  const firstLines = makefile.split(/\r?\n/).slice(0, 12).join('\n')

  assert.match(firstLines, /^PLUGIN\s+\?=\s+dsh-crwu-workbench$/m)
  assert.match(firstLines, /^override NPM_REGISTRY\s+:=\s+https:\/\/registry\.npmjs\.org$/m)
  assert.match(makefile, /^plugin-version:/m)
  assert.match(makefile, /^plugin-version-set:/m)
  assert.match(makefile, /^plugin-npm-login:/m)
  assert.match(makefile, /^plugin-npm-whoami:/m)
  assert.match(makefile, /^plugin-publish-dry-run:/m)
  assert.match(makefile, /^plugin-publish:/m)
  assert.doesNotMatch(makefile, /^skills-install:/m)
  assert.match(makefile, /PLUGIN_RELEASE_VERSION/)
  assert.match(makefile, /CONFIRM_PUBLISH/)
})

test('manual publish targets run preflight before assembling binaries', () => {
  const makefile = readFileSync(new URL('../Makefile', import.meta.url), 'utf8')
  const dryRunRecipe = makefile.match(
    /^plugin-publish-dry-run:([^\n]*)\n((?:\t.*\n)+)/m,
  )
  const publishRecipe = makefile.match(
    /^plugin-publish:([^\n]*)\n((?:\t.*\n)+)/m,
  )

  for (const match of [dryRunRecipe, publishRecipe]) {
    assert.ok(match, 'publish target recipe must exist')
    assert.doesNotMatch(match[1], /plugin-bin/)
    assert.ok(
      match[2].indexOf('plugin-release.mjs preflight') < match[2].indexOf('plugin-bin'),
      'preflight must run before plugin-bin',
    )
  }
})
