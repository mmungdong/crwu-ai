/**
 * 钉钉设备流输出的解析判据（协议 32）。
 *
 * 为什么这些断言值得单独存在：解析的是 `dws` 的**人类可读输出**（上游二进制，没有结构化契约），
 * 所以三件事都必须钉死 —— ① 正常形态能解析出授权码；② 首选链接必须是「已填入授权码」那一版
 * （打开后员工只需点确认，而不是把码抄进去）；③ URL 白名单不能被后缀伪装骗过（面板会把解析出来的
 * URL 交给系统浏览器打开）。解析失败**不许**抛错：`tail` 永远把原文交给员工。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../', import.meta.url)
const { parseDwsDeviceAuthorization, deviceUrlAllowed } = await import(
  new URL('src/host/system/device-login.ts', ROOT).href)

test('解析出短 URL 与连字符大写授权码，并去掉紧跟的标点', () => {
  const out = '请在浏览器中打开以下链接，并输入授权码：\nhttps://s.dingtalk.com/abc。\n  ABCD-EFGH  '
  assert.deepEqual(parseDwsDeviceAuthorization(out), {
    url: 'https://s.dingtalk.com/abc', urlManual: '', userCode: 'ABCD-EFGH',
  })
})

test('认「授权码: xxxx」这种标签写法（码没有连字符）', () => {
  const out = 'please open https://s.dingtalk.com/xyz and enter user code: 9F2K7QW1'
  assert.deepEqual(parseDwsDeviceAuthorization(out), {
    url: 'https://s.dingtalk.com/xyz', urlManual: '', userCode: '9F2K7QW1',
  })
})

test('解析不出来不抛错，回空值（tail 永远兜底）', () => {
  assert.deepEqual(parseDwsDeviceAuthorization('请求设备授权码...'), { url: '', urlManual: '', userCode: '' })
})

test('白名单只认 https 的钉钉域及其子域，且不认后缀伪装', () => {
  assert.equal(deviceUrlAllowed('https://s.dingtalk.com/abc'), true)
  assert.equal(deviceUrlAllowed('https://login.dingtalk.io/x'), true)
  assert.equal(deviceUrlAllowed('http://s.dingtalk.com/abc'), false)
  assert.equal(deviceUrlAllowed('https://dingtalk.com.evil.tld/x'), false)
  assert.equal(deviceUrlAllowed('https://evil.tld/dingtalk.com'), false)
  assert.equal(deviceUrlAllowed('not a url'), false)
})

test('解析器只回白名单内的 URL（域外链接当没解析出来）', () => {
  assert.deepEqual(parseDwsDeviceAuthorization('open https://evil.tld/a now'), {
    url: '', urlManual: '', userCode: '',
  })
})

test('重发之后取最后一个链接与授权码（旧码此刻已经无效）', () => {
  const out = [
    '打开 https://s.dingtalk.com/one 并输入 ABCD-EFGH',
    '授权码已过期，正在重新发起设备授权流程...',
    '打开 https://s.dingtalk.com/two 并输入 ZZZZ-YYYY',
  ].join('\n')
  assert.deepEqual(parseDwsDeviceAuthorization(out), {
    url: 'https://s.dingtalk.com/two', urlManual: '', userCode: 'ZZZZ-YYYY',
  })
})

test('dws 打印两个链接时，首选「已填入授权码」那一版（打开后只要点确认）', () => {
  // 真实输出形态（上游 `dfPrintDeviceAuthorization`）：完整链接在前、手动链接在后。
  // 「取最后一个 URL」在这里恰好会选错 —— 那正是让员工把码抄一遍的那个链接。
  const out = [
    '  授权码: ABCD-EFGH',
    '  授权码将在 600 秒后过期。',
    '',
    '  授权链接（已填入授权码）：',
    '  https://login.dingtalk.com/oauth2/device/verify?user_code=ABCD-EFGH',
    '',
    '  手动输入授权码的链接：',
    '  https://login.dingtalk.com/oauth2/device/verify',
  ].join('\n')
  assert.deepEqual(parseDwsDeviceAuthorization(out), {
    url: 'https://login.dingtalk.com/oauth2/device/verify?user_code=ABCD-EFGH',
    urlManual: 'https://login.dingtalk.com/oauth2/device/verify',
    userCode: 'ABCD-EFGH',
  })
})

test('loopback 的输出：唯一那个链接就是授权页（标签在上一行）', () => {
  const out = [
    '🔐 登录钉钉',
    '',
    '请在浏览器中完成扫码授权。',
    '如果浏览器未自动打开，请手动访问:',
    '  https://login.dingtalk.com/oauth2/auth?client_id=x&redirect_uri=y',
    '',
    '⏳ 等待授权中...',
  ].join('\n')
  assert.deepEqual(parseDwsDeviceAuthorization(out), {
    url: 'https://login.dingtalk.com/oauth2/auth?client_id=x&redirect_uri=y',
    urlManual: '', userCode: '',
  })
})

test('只有「手动输入授权码」那个链接时，它也当首选（否则一颗按钮都没有可打开的）', () => {
  const out = '  手动输入授权码的链接：\n  https://login.dingtalk.com/oauth2/device/verify'
  assert.deepEqual(parseDwsDeviceAuthorization(out), {
    url: 'https://login.dingtalk.com/oauth2/device/verify', urlManual: '', userCode: '',
  })
})
