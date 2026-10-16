/**
 * 登录状态检查的两条通道（协议 37 · 用户 2026-10-14 口径）。
 *
 * 现场：门禁每次进房地产页都会 **打开一个可见浏览器窗口并load受保护页**，员工只看到窗口一闪。
 * 凭据本身已经带着答案（在不在、什么时候过期），所以：
 *
 * 1. 门禁预检走 `crwu browser status`（**只读凭据**，CLI 侧不加载页面、不起可见窗口）；
 * 2. 只有"登录窗口本来就开着"的登录链路才走 `--verify-page` 拿页面判定，
 *    它是区分「登录失败」与「已登录但页面要人机验证」的唯一依据；
 * 3. 门禁的逐站展示直接吃 CLI 报回来的**到期时间**（人话原因里就带）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { registerTsxLoader } from '../../helpers/tsx-loader.mjs'

registerTsxLoader()

const ROOT = new URL('../../../', import.meta.url)
const { createBrowserClient, statusFromEnvelope } = await import(
  new URL('src/host/domains/report-evaluation/browser/cli-client.ts', ROOT).href)
const { createLoginJobs } = await import(
  new URL('src/host/domains/report-evaluation/browser/login-jobs.ts', ROOT).href)
const { createProfileQueue } = await import(
  new URL('src/host/domains/report-evaluation/browser/profile-queue.ts', ROOT).href)
const { createValuationAuthOperations } = await import(
  new URL('src/host/operations/report-evaluation/auth.ts', ROOT).href)

const SITES = '/pkg/sites.json'
const WORKDIR = '/cases/session'

const AUTHENTICATED_WITH_EXPIRY = JSON.stringify({
  ok: true,
  data: {
    ok: true,
    sites: [{
      id: 'lianjia', label: '链家', state: 'authenticated',
      reason: '已登录（到期 2026-10-15 16:54）', expiresAt: '2026-10-15T08:54:42Z', sessionCookie: false,
    }],
  },
})

function makeRunner(stdout) {
  const calls = []
  return {
    calls,
    async run(argv) {
      calls.push({ argv: [...argv] })
      return { ok: true, error: '', exitCode: 0, stdout, stderr: '', aborted: false, timedOut: false }
    },
  }
}

test('门禁预检只读凭据：argv 里没有 --verify-page', async () => {
  const runner = makeRunner(AUTHENTICATED_WITH_EXPIRY)
  const client = createBrowserClient({
    run: runner.run, sitesPath: SITES, queue: createProfileQueue(), source: 'panel', workdir: WORKDIR,
  })

  const result = await client.status(['lianjia'], undefined)
  assert.deepEqual(runner.calls[0].argv, ['crwu', 'browser', 'status', '--sites', SITES, '--site', 'lianjia'],
    '只读凭据：不带 --verify-page')
  assert.equal(result.ok, true)
  assert.equal(result.sites[0].state, 'authenticated')
  assert.equal(result.sites[0].expiresAt, '2026-10-15T08:54:42Z', '到期时间要原样带回来')
  assert.match(result.sites[0].reason, /到期/, '人话原因里带到期时间供界面直接显示')
})

test('登录链路读受保护页：argv 里带 --verify-page（页面判定只有它能给）', async () => {
  const runner = makeRunner(AUTHENTICATED_WITH_EXPIRY)
  const client = createBrowserClient({
    run: runner.run, sitesPath: SITES, queue: createProfileQueue(), source: 'panel', workdir: WORKDIR,
  })

  await client.statusVerified(['lianjia'], undefined)
  const argv = runner.calls[0].argv
  assert.equal(argv.includes('--verify-page'), true, '登录链路必须请求页面判定')
  assert.deepEqual(argv.filter((one) => one !== '--verify-page'),
    ['crwu', 'browser', 'status', '--sites', SITES, '--site', 'lianjia'],
    '除了这一个开关，其余参数与只读凭据完全一致')
})

/** 跑完一条登录任务（它内部先跑 login、再跑一次权威读）。 */
async function runLoginJob(statusResult) {
  const sites = [{
    id: 'lianjia', label: '链家', loginUrl: 'https://clogin.lianjia.com/login',
    protectedUrl: 'https://bj.lianjia.com/ershoufang/', authCookie: 'lianjia_token', authDomains: ['.lianjia.com'],
  }]
  const calls = []
  const client = {
    async status() { calls.push('status'); return statusResult },
    async statusVerified() { calls.push('statusVerified'); return statusResult },
    async login() { return { ok: true, error: '', sites: [], aborted: false } },
  }
  const logins = createLoginJobs({ client, loginUrlOf: () => sites[0].loginUrl })
  const started = await logins.start('lianjia')
  for (let i = 0; i < 100 && logins.get(started.job.jobId)?.state === 'running'; i += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 5) })
  }
  return { job: logins.get(started.job.jobId), calls }
}

test('登录任务用 --verify-page：页面判定参与结论（挑战/等待用户）', async () => {
  // ① 凭据有效 + 页面被挑战 → **登录是成功的**，只是这句 detail 要说清还要过验证
  const challenged = {
    ok: true, error: '', unavailable: false,
    sites: [{
      siteId: 'lianjia', label: '链家', state: 'authenticated', reason: '受保护页要求人机验证',
      verdict: 'captcha', protectedUrl: 'https://bj.lianjia.com/ershoufang/',
    }],
  }
  const first = await runLoginJob(challenged)
  assert.deepEqual(first.calls, ['statusVerified'], '登录链路必须读受保护页，而不是只读凭据')
  assert.equal(first.job.state, 'succeeded')
  assert.match(first.job.detail, /人机验证/, '成功但页面被挑战时必须说清这件事')

  // ② 凭据还没到位、页面又是挑战 → waiting-user（"你没登录成功"是错误判断）
  const waiting = {
    ok: true, error: '', unavailable: false,
    sites: [{
      siteId: 'lianjia', label: '链家', state: 'unknown', reason: '受保护页要求人机验证',
      verdict: 'captcha', protectedUrl: 'https://bj.lianjia.com/ershoufang/',
    }],
  }
  const second = await runLoginJob(waiting)
  assert.equal(second.job.state, 'waiting-user', '凭据未确认 + 页面被挑战 → waiting-user，不是 failed')
})

test('门禁把 CLI 报回来的到期时间原样展示（逐站原因 = 已登录（到期 …））', async () => {
  const sites = [{
    id: 'lianjia', label: '链家', loginUrl: 'https://clogin.lianjia.com/login',
    protectedUrl: 'https://bj.lianjia.com/ershoufang/', authCookie: 'lianjia_token', authDomains: ['.lianjia.com'],
  }]
  const config = { valuation: { browser: { sitesFile: 'x', requiredSiteIds: ['lianjia'], optionalSiteIds: [], assistLoginChallenge: true } } }
  const rows = statusFromEnvelope({ stdout: AUTHENTICATED_WITH_EXPIRY, ok: true, error: '', exitCode: 0, stderr: '', aborted: false, timedOut: false }, ['lianjia'])
  const ops = createValuationAuthOperations({
    ctx: {}, access: {}, config,
    client: { async status() { return { ok: true, error: '', sites: rows.sites, unavailable: false } } },
    logins: { current: () => [], start: async () => ({ ok: false, error: 'unused', reused: false, job: null }), cancel: () => ({ ok: false, error: 'unused' }) },
    sites, sitesPath: SITES,
  })
  const preflight = await ops['valuation-browser-preflight']({})
  assert.equal(preflight.gate.released, true, '只读凭据说已登录就该放行')
  assert.match(preflight.rows[0].reason, /到期/)
  assert.equal(preflight.rows[0].expiresAt, '2026-10-15T08:54:42Z')
})
