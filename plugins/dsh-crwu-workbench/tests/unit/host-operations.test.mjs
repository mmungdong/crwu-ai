/**
 * 宿主操作清单的**冻结护栏**。
 *
 * 第 26 轮把裸数字换成冻结名单时想的是"别让清单悄悄变少"，结果 `install-prompt` 被删掉之后
 * 需要有人**显式**把名单改小 —— 这份用例就是那个提醒：数量、名字与「哪些操作故意不给客户端」
 * 都在一处声明（`tests/helpers/frozen-inventory.mjs`），改动必须是有意识的。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../', import.meta.url)
const { FROZEN_OPERATIONS, FROZEN_OPERATION_COUNT } = await import(
  new URL('tests/helpers/frozen-inventory.mjs', ROOT).href)
const { OPERATION_OF } = await import(new URL('src/client/features/report-audit/api.ts', ROOT).href)

test('冻结名单自身自洽：无重复、全小写连字符、数量对得上', () => {
  assert.equal(FROZEN_OPERATIONS.length, FROZEN_OPERATION_COUNT)
  assert.equal(new Set(FROZEN_OPERATIONS).size, FROZEN_OPERATIONS.length, '名单里不许有重复项')
  for (const operation of FROZEN_OPERATIONS) {
    assert.match(operation, /^[a-z][a-z-]*$/, operation)
  }
})

test('install-prompt 已被删除，且不会再回到名单里', () => {
  // 那套「复制安装提示词发给 Agent」在二进制随包发布、登录与密钥都在界面上完成之后
  // 没有任何运行时用途。回到名单 = 环境页上又会出现一个把员工指去绕路的入口。
  assert.equal(FROZEN_OPERATIONS.includes('install-prompt'), false)
})

test('门面覆盖除 HOST_ONLY 之外的全部操作（少一个的表现是点下去 404）', () => {
  // 长期 HOST_ONLY **只有**这两个：`ping`（宿主链路自检）与 `audit-release`（应急释放占用锁）。
  //
  // Task 4 曾把四个 `update-*` 临时列在这里（当时 Client 门面还没实现）。Task 5 的门面已经接上，
  // 四项临时豁免已删除 —— 再往这里加回任何 `update-*`，就等于承认客户端少了一个入口。
  const HOST_ONLY = ['ping', 'audit-release']
  const facade = new Set(Object.values(OPERATION_OF))
  const missing = FROZEN_OPERATIONS.filter((name) => !facade.has(name) && !HOST_ONLY.includes(name))
  assert.deepEqual(missing, [], `Host 有但门面没有：${missing.join(' ')}`)
  const extra = [...facade].filter((name) => !FROZEN_OPERATIONS.includes(name))
  assert.deepEqual(extra, [], `门面声明了但冻结名单没有：${extra.join(' ')}`)
})
