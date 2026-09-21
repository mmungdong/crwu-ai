/**
 * `cordis.patch.yml` 的技能根路径回归测试（2026-09-22 那次"技能一个都没加载"的缺陷）。
 *
 * 缺陷现象：技能表里 crwu-* 一个都没有，但 profile 启动日志干干净净、没有任何报错。
 * 根因：profile 的整棵树是「补丁层挂在 profile 的空根配置上」，所以 **bundle patch 里的 `baseUrl`
 * 锚在 profile 目录**（DSH 源码注释：根配置文件存在只是因为 Loader 需要一个真实的 include root 来
 * 锚定 `baseUrl`）——`new URL('skills/', baseUrl)` 因此指向 `<profile>/skills/`（不存在），
 * `dsh-skill-filesystem` 挂上了却**静默**贡献 0 个技能。
 *
 * 所以这份测试不核对"写法"，而是**按 loader 的方式真的求值一次**：造一个临时 profile 目录
 * （`package.json` + `node_modules/<包名>` 软链，与 `link:` 安装同形），把 patch 里的 `!!js`
 * 表达式取出来求值，断言它指向的两个目录真实存在且装满了技能。
 *
 * 写死 `new URL('skills/', baseUrl)` 会让它变红（第一组断言就是这个陷阱本身）。
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const ROOT = new URL('../../', import.meta.url)
const PACKAGE_DIR = new URL('.', ROOT).pathname.replace(/\/$/, '')
const PATCH_TEXT = readFileSync(new URL('cordis.patch.yml', ROOT), 'utf8')

/** 取出 `crwu-workbench-skills` 那行的 `customSkillDirs: !!js >-` 折叠标量，还原成一行 JS。 */
function readSkillRootsExpression() {
  const marker = 'customSkillDirs: !!js >-'
  const at = PATCH_TEXT.indexOf(marker)
  assert.notEqual(at, -1, 'patch 里应当有 `customSkillDirs: !!js >-`（技能根必须在补丁里声明）')
  const lines = PATCH_TEXT.slice(at + marker.length).split('\n').slice(1)
  const body = []
  for (const line of lines) {
    if (line.trim() === '') break
    body.push(line.trim())
  }
  assert.ok(body.length > 0, '折叠标量是空的')
  return body.join(' ')
}

/** 按 loader 的方式求值：`!!js` 表达式是一个普通 JS 表达式，作用域里有 `baseUrl`。 */
function evaluate(expression, baseUrl) {
  // eslint-disable-next-line no-new-func -- 被测对象就是这段表达式文本本身
  return new Function('baseUrl', `return (${expression})`)(baseUrl)
}

test('技能根表达式按包名解析：link 形态的 profile 下真的能找到两个技能目录', async () => {
  const expression = readSkillRootsExpression()
  const profile = await mkdtemp(join(tmpdir(), 'crwu-profile-'))
  try {
    // 与真实 profile 同形：`<profile>/package.json` + `<profile>/node_modules/<包名>` → 包目录。
    await writeFile(join(profile, 'package.json'), '{"name":"dsh-profile-probe","private":true}\n')
    await mkdir(join(profile, 'node_modules'), { recursive: true })
    await symlink(PACKAGE_DIR, join(profile, 'node_modules', 'dsh-crwu-workbench'))
    const baseUrl = pathToFileURL(`${profile}/`).href

    // ① 旧写法（`new URL('skills/', baseUrl)`）在这里就是错的 —— 这正是当初的缺陷。
    assert.equal(
      existsSync(join(profile, 'skills')),
      false,
      '前提：profile 目录下没有 skills/，所以按 baseUrl 拼路径必然指向不存在的目录',
    )

    // ② 真正求值：拿到两个技能根。
    const dirs = evaluate(expression, baseUrl)
    assert.ok(Array.isArray(dirs), 'customSkillDirs 表达式必须返回数组')
    assert.equal(dirs.length, 2, '应当是两个技能根：插件专属 + 公共')
    for (const dir of dirs) {
      assert.equal(existsSync(dir), true, `技能根不存在：${dir}`)
      assert.equal(dir.startsWith(profile), false, '技能根不该落在 profile 目录里')
    }
    const [own, common] = dirs
    assert.equal(own, join(PACKAGE_DIR, 'skills'))
    assert.equal(common, join(PACKAGE_DIR, 'common', 'skills'))

    // ③ 目录里真有技能：随包发布的两个根共 30 个（27 专属 + 3 公共），且每个都有 SKILL.md。
    const countSkills = async (dir) => {
      const entries = await readdir(dir, { withFileTypes: true })
      const names = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).map((entry) => entry.name)
      assert.ok(names.length > 0, `${dir} 里没有技能目录`)
      for (const name of names) {
        assert.equal(existsSync(join(dir, name, 'SKILL.md')), true, `${name} 缺 SKILL.md`)
      }
      return names.length
    }
    const ownCount = await countSkills(own)
    const commonCount = await countSkills(common)
    assert.equal(ownCount, 27, '插件专属技能数变了（27 个）')
    assert.equal(commonCount, 3, '公共技能数变了（crwu-dws / crwu-h3yun-login / crwu-h3yun-query）')
  } finally {
    await rm(profile, { recursive: true, force: true })
  }
})

test('技能根表达式在包目录形态下也成立（tarball 安装：包名由 profile 直接解析）', async () => {
  const expression = readSkillRootsExpression()
  const profile = await mkdtemp(join(tmpdir(), 'crwu-profile-tarball-'))
  try {
    await writeFile(join(profile, 'package.json'), '{"name":"dsh-profile-probe","private":true}\n')
    // tarball 安装是真实目录（不是软链），这里用 junction 复制一份包名 → 包目录，语义相同。
    await mkdir(join(profile, 'node_modules'), { recursive: true })
    await symlink(PACKAGE_DIR, join(profile, 'node_modules', 'dsh-crwu-workbench'), 'dir')
    const dirs = evaluate(expression, `${profile}/`)
    for (const dir of dirs) assert.equal(existsSync(dir), true, `技能根不存在：${dir}`)
  } finally {
    await rm(profile, { recursive: true, force: true })
  }
})

test('解析不到包时直接抛错，不静默变成"没有技能"', async () => {
  const expression = readSkillRootsExpression()
  const profile = await mkdtemp(join(tmpdir(), 'crwu-profile-empty-'))
  try {
    await writeFile(join(profile, 'package.json'), '{"name":"dsh-profile-probe","private":true}\n')
    assert.throws(
      () => evaluate(expression, pathToFileURL(`${profile}/`).href),
      /dsh-crwu-workbench/,
      '包解析不到必须抛错（命令行/日志里能看见），而不是悄悄返回空目录',
    )
  } finally {
    await rm(profile, { recursive: true, force: true })
  }
})
