import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import test from 'node:test'

import {
  describeFailure,
  dshHome,
  resolveDshPython,
  runtimeCandidates,
  runtimeDirs,
} from './resolve-dsh-python.mjs'

/** 在临时目录里搭一个假的 DSH home，返回根路径。 */
function fakeHome(runtimes) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-python-'))
  for (const [name, files] of Object.entries(runtimes)) {
    const pythonRoot = join(home, 'dsh-runtimes', name, 'dependencies', 'python')
    mkdirSync(join(pythonRoot, 'bin'), { recursive: true })
    for (const [relative, content] of Object.entries(files)) {
      const target = join(pythonRoot, ...relative.split('/'))
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, content)
      if (!process.platform.startsWith('win')) chmodSync(target, 0o755)
    }
  }
  return home
}

test('DSH_HOME 覆盖缺省 ~/.dsh', () => {
  assert.equal(dshHome({ DSH_HOME: '/opt/dsh' }), '/opt/dsh')
  assert.equal(dshHome({ DSH_HOME: '  ' }), dshHome({}))
  assert.ok(dshHome({}).endsWith('.dsh'))
})

test('运行时目录：主运行时优先，其余按名字排序', () => {
  const home = fakeHome({ 'rt-b': {}, 'dsh-primary-runtime': {}, 'rt-a': {} })
  try {
    assert.deepEqual(
      runtimeDirs(home).map((dir) => dir.split(/[\\/]/).pop()),
      ['dsh-primary-runtime', 'rt-a', 'rt-b'],
    )
    assert.deepEqual(runtimeDirs(join(home, 'missing')), [])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('候选解释器：固定入口在前，带版本号的按版本从高到低', () => {
  const home = fakeHome({ 'dsh-primary-runtime': {} })
  try {
    const pythonRoot = join(home, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python')
    for (const name of ['python3.9', 'python3.12', 'python3.11']) {
      writeFileSync(join(pythonRoot, 'bin', name), '')
    }
    const names = runtimeCandidates(join(home, 'dsh-runtimes', 'dsh-primary-runtime'))
      .map((candidate) => candidate.split(/[\\/]/).pop())
    assert.equal(names[0], 'python3')
    assert.deepEqual(names.slice(-3), ['python3.12', 'python3.11', 'python3.9'])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('同一运行时里跳过不可执行 / 探测失败的候选，取第一个可用的', () => {
  const home = fakeHome({
    'dsh-primary-runtime': { 'bin/python3': '' },
    'rt-b': { 'bin/python3': '' },
  })
  try {
    const probed = []
    const result = resolveDshPython({
      home,
      probe: (path) => {
        probed.push(path.includes('dsh-primary-runtime') ? 'primary' : 'other')
        return path.includes('dsh-primary-runtime')
          ? { ok: false, reason: "ModuleNotFoundError: No module named 'PIL'" }
          : { ok: true, versionText: '3.12.14 12.3.0' }
      },
    })
    assert.equal(result.ok, true)
    assert.ok(result.path.includes('rt-b'))
    assert.deepEqual(probed, ['primary', 'other'])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('没有任何可用解释器时给出逐条原因，并明确不退回系统 python3', () => {
  const home = fakeHome({ 'dsh-primary-runtime': { 'bin/python3': '' } })
  try {
    const result = resolveDshPython({
      home,
      probe: () => ({ ok: false, reason: "ModuleNotFoundError: No module named 'PIL'" }),
    })
    assert.equal(result.ok, false)
    assert.equal(result.failures.length, 1)
    const text = describeFailure(result)
    assert.match(text, /不退回系统 python3/)
    assert.match(text, /bin\/python3/)
    assert.match(text, /ModuleNotFoundError/)
    assert.match(text, /DSH_PYTHON=/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('真实探测：能 import Pillow 的入口才被选中', { skip: process.platform === 'win32' }, () => {
  const home = fakeHome({
    'dsh-primary-runtime': {
      'bin/python3': '#!/bin/sh\nif [ "$1" = "-c" ]; then echo "3.99.0 9.9.9"; exit 0; fi\nexit 2\n',
    },
  })
  try {
    const result = resolveDshPython({ home })
    assert.equal(result.ok, true)
    assert.equal(result.versionText, '3.99.0 9.9.9')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('真实探测：缺包时失败原因带出解释器的 stderr', { skip: process.platform === 'win32' }, () => {
  const home = fakeHome({
    'dsh-primary-runtime': {
      'bin/python3': '#!/bin/sh\necho "ModuleNotFoundError: No module named \'PIL\'" >&2\nexit 1\n',
    },
  })
  try {
    const result = resolveDshPython({ home })
    assert.equal(result.ok, false)
    assert.match(result.failures[0].reason, /No module named 'PIL'/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
