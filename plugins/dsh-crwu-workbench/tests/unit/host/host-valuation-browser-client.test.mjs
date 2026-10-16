/**
 * `crwu browser` 的 Host 适配层（设计稿 §8.2 / §8.3，计划 Task 3）。
 *
 * 挑的是**错了会静默放行**的几条：
 *
 * 1. 非零退出 + 合法 `{ok,data}` 必须仍然解析逐站结果 —— CLI 在"有站点未登录"时故意返回非零，
 *    只看退出码会把最有用的那句原因整条丢掉；
 * 2. stdout 畸形必须降级成逐站 `unknown` 并说明原因，**不能**抛裸 JSON 错误，
 *    更不能当成"全部已登录"；
 * 3. 同一 profile 上真实的浏览器只有一个：所有调用必须串行，观测到的最大并发只能是 1；
 * 4. 取消只取消调用者自己那一项，不能杀掉别人正在跑的操作（那可能是员工自己在用的窗口）；
 * 5. `login` 结束后必须跑一次**权威** `status` —— Cookie 存在不能直接宣告成功；
 * 6. argv 由 Host 构造：模型提交的 URL / 路径不合形状时**整条命令不发出去**；
 * 7. **随包发布的登录入口必须是站点自己发布的那个链接**（源仓契约测试：读真实
 *    `skills/biz/.../assets/browser-sites.json`，技能目录不在时跳过）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../../', import.meta.url)

const { createProfileQueue, ProfileQueueCancelled } = await import(
  new URL('src/host/domains/report-evaluation/browser/profile-queue.ts', ROOT).href)
const { createBrowserClient, parseEnvelope, statusFromEnvelope, recoveryFromEnvelope, pageOutcomeFromEnvelope } = await import(
  new URL('src/host/domains/report-evaluation/browser/cli-client.ts', ROOT).href)
const { createLoginJobs } = await import(
  new URL('src/host/domains/report-evaluation/browser/login-jobs.ts', ROOT).href)

const SITES = '/pkg/skills/biz/crwu-biz-valuation-realestate/assets/browser-sites.json'
const WORKDIR = '/cases/space'

const AUTHENTICATED = JSON.stringify({
  ok: true,
  data: { sites: [{ id: 'lianjia', label: '链家', state: 'authenticated', reason: '' }] },
})
const UNAUTHENTICATED_NONZERO = JSON.stringify({
  ok: false,
  data: { sites: [{ id: 'lianjia', label: '链家', state: 'unauthenticated', reason: '尚未检测到该来源的登录凭据' }] },
})

/** 记录命令的替身 runner。 */
function makeRunner(handler) {
  const calls = []
  return {
    calls,
    async run(argv, options) {
      calls.push({ argv: [...argv], options })
      return await handler(argv, options, calls.length)
    },
  }
}

test('statusFromEnvelope 解析非零退出但合法的逐站结果', () => {
  const parsed = statusFromEnvelope(
    { stdout: UNAUTHENTICATED_NONZERO, exitCode: 1, stderr: '有站点未处于已登录状态', error: '', aborted: false, timedOut: false },
    ['lianjia'],
  )
  assert.equal(parsed.parsed, true)
  assert.equal(parsed.unavailable, false)
  assert.equal(parsed.ok, false)
  assert.equal(parsed.sites[0].siteId, 'lianjia')
  assert.equal(parsed.sites[0].state, 'unauthenticated')
  assert.match(parsed.sites[0].reason, /登录凭据/)
})

test('statusFromEnvelope 对畸形 stdout 降级成 unknown 而不是抛裸 JSON 错误', () => {
  const parsed = statusFromEnvelope(
    { stdout: 'not json at all', exitCode: 0, stderr: '', error: 'boom', aborted: false, timedOut: false },
    ['fang', 'lianjia'],
  )
  assert.equal(parsed.parsed, false)
  assert.equal(parsed.unavailable, true)
  assert.equal(parsed.ok, false)
  assert.equal(parsed.sites.length, 2)
  for (const site of parsed.sites) {
    assert.equal(site.state, 'unknown')
    assert.equal(site.reason.includes('boom'), true)
  }
})

test('statusFromEnvelope 遇到"成功但没有站点"时不当成全部已登录', () => {
  const parsed = statusFromEnvelope(
    { stdout: JSON.stringify({ ok: true, data: { sites: [] } }), exitCode: 0, stderr: '', error: '', aborted: false, timedOut: false },
    ['lianjia'],
  )
  assert.equal(parsed.ok, false)
  assert.equal(parsed.unavailable, true)
  assert.equal(parsed.sites[0].state, 'unknown')
})

test('parseEnvelope 只认 stdout 上的 JSON 信封', () => {
  assert.equal(parseEnvelope('').parsed, false)
  assert.equal(parseEnvelope('[1,2]').parsed, false)
  assert.equal(parseEnvelope(JSON.stringify({ ok: true, data: { sites: [] } })).parsed, true)
  assert.equal(parseEnvelope(JSON.stringify({ ok: true, data: null })).data, null)
})

test('recoveryFromEnvelope 用 state 判定，不用退出码', () => {
  const waiting = recoveryFromEnvelope({
    stdout: JSON.stringify({
      ok: false,
      data: {
        state: 'waiting-user', reasonCode: 'budget-exhausted', attempts: 2,
        beforeKind: 'geetest-v3-canvas', afterKind: 'geetest-v3-canvas',
        nextEligibleAt: '2026-10-14T10:00:00Z',
        pageValidation: { finalUrl: 'https://bj.lianjia.com/x.html', hostMatches: true, challengeVisible: true, reason: '仍有可见挑战' },
      },
    }),
    exitCode: 1, stderr: '', error: '',
  })
  assert.equal(waiting.state, 'waiting-user')
  assert.equal(waiting.attempts, 2)
  assert.equal(waiting.pageValidation.challengeVisible, true)

  const garbage = recoveryFromEnvelope({ stdout: '<<<', exitCode: 0, stderr: 'x', error: '' })
  assert.equal(garbage.state, 'failed')
  assert.equal(garbage.reasonCode, 'output-unreadable')
})

// 站点用自己的人机验证页回答受保护页（实测 2026-10-15：`bj.lianjia.com/…` →
// `hip.lianjia.com/captcha`）时，CLI 回的是 `waiting-user`：等人、可继续。
// 收窄必须原样保住这个状态与 reasonCode —— 它是"等人工"与"没有策略"的分水岭。
test('recoveryFromEnvelope 认得挑战页族：waiting-user + challenge-page-waiting-user', () => {
  const outcome = recoveryFromEnvelope({
    stdout: JSON.stringify({
      ok: false,
      data: {
        state: 'waiting-user', reasonCode: 'challenge-page-waiting-user', attempts: 1,
        beforeKind: 'site-challenge-page', afterKind: 'site-challenge-page',
        pageValidation: {
          finalUrl: 'https://hip.lianjia.com/captcha?location=x', title: 'CAPTCHA',
          hostMatches: false, readable: true, challengeVisible: false,
          loginWall: false, blocked: false, overlaySelectors: [], reason: '站点把人机验证页当回答',
        },
      },
    }),
    exitCode: 1, stderr: '', error: '',
  })
  assert.equal(outcome.state, 'waiting-user')
  assert.equal(outcome.reasonCode, 'challenge-page-waiting-user')
  assert.equal(outcome.beforeKind, 'site-challenge-page')
  assert.equal(outcome.pageValidation.hostMatches, false)
  assert.equal(outcome.pageValidation.readable, true)
  assert.equal(outcome.pageValidation.challengeVisible, false)
  // unsupported 只留给"没有策略"；这一族不许落到那里。
  assert.notEqual(outcome.state, 'unsupported')
})

test('pageOutcomeFromEnvelope 不把畸形输出当成成功取数', () => {
  const bad = pageOutcomeFromEnvelope({ stdout: 'nope', exitCode: 0, stderr: '', error: '' })
  assert.equal(bad.ok, false)
  const good = pageOutcomeFromEnvelope({
    stdout: JSON.stringify({ ok: true, data: { ok: true, verdict: 'ok', finalUrl: 'https://bj.lianjia.com/a', digest: 'sha256:x', bytes: 12 } }),
    exitCode: 0, stderr: '', error: '',
  })
  assert.equal(good.ok, true)
  assert.equal(good.finalUrl, 'https://bj.lianjia.com/a')
})

test('createBrowserClient 由 Host 构造 argv，且绝不接受自由 URL 或空输出路径', async () => {
  const runner = makeRunner(async (argv) => {
    if (argv.includes('status')) return { ok: true, error: '', exitCode: 0, stdout: AUTHENTICATED, stderr: '', aborted: false, timedOut: false }
    return { ok: true, error: '', exitCode: 0, stdout: JSON.stringify({ ok: true, data: { ok: true } }), stderr: '', aborted: false, timedOut: false }
  })
  const client = createBrowserClient({
    run: runner.run, sitesPath: SITES, queue: createProfileQueue(),
    source: 'panel', workdir: WORKDIR,
  })

  await client.status(['lianjia'], undefined)
  const statusArgv = runner.calls[0].argv
  assert.deepEqual(statusArgv, ['crwu', 'browser', 'status', '--sites', SITES, '--site', 'lianjia'])

  await client.shot({ url: 'https://bj.lianjia.com/ershoufang/1.html', out: '/cases/space/来源证据/页面/a.png' }, undefined)
  const shotArgv = runner.calls[1].argv
  assert.equal(shotArgv[0], 'crwu')
  assert.equal(shotArgv[1], 'browser')
  assert.equal(shotArgv[2], 'shot')
  assert.equal(shotArgv.includes('--background=true'), true, 'shot 必须固定复用自有后台窗口')
  assert.equal(shotArgv.includes('--sites'), false, 'shot 不接受 --sites')

  await assert.rejects(() => client.fetch({ url: 'file:///etc/passwd', out: '/tmp/x' }, undefined), /http/)
  await assert.rejects(() => client.fetch({ url: 'https://bj.lianjia.com/a', out: '' }, undefined), /输出路径/)
  assert.equal(runner.calls.length, 2, '不合形状的参数不该发出任何命令')
})

// 后台窗口是 Host 的固定选择，不是模型输入：即使请求里带了 background，argv 仍然是 true。
test('createBrowserClient 给 fetch/shot 固定 --background=true', async () => {
  const runner = makeRunner(async () => ({
    ok: true, error: '', exitCode: 0,
    stdout: JSON.stringify({ ok: true, data: { ok: true } }), stderr: '', aborted: false, timedOut: false,
  }))
  const client = createBrowserClient({
    run: runner.run, sitesPath: SITES, queue: createProfileQueue(), source: 'panel', workdir: WORKDIR,
  })

  await client.fetch({ url: 'https://bj.lianjia.com/a', out: '/cases/space/a.html' }, undefined)
  await client.shot({ url: 'https://bj.lianjia.com/a', out: '/cases/space/a.png' }, undefined)
  // 模型提交的 background 会被忽略：PageRequest 根本没有这个字段。
  await client.fetch({ url: 'https://bj.lianjia.com/b', out: '/cases/space/b.html', background: false }, undefined)

  assert.deepEqual(runner.calls[0].argv.slice(0, 4), ['crwu', 'browser', 'fetch', '--background=true'])
  assert.deepEqual(runner.calls[1].argv.slice(0, 4), ['crwu', 'browser', 'shot', '--background=true'])
  assert.equal(runner.calls[2].argv.includes('--background=true'), true, '模型输入不能关掉后台窗口')
})

test('createBrowserClient 经 status 报告站点逐站原因', async () => {
  const runner = makeRunner(async () => ({
    ok: false, error: '有站点未处于已登录状态', exitCode: 1,
    stdout: UNAUTHENTICATED_NONZERO, stderr: '', aborted: false, timedOut: false,
  }))
  const client = createBrowserClient({
    run: runner.run, sitesPath: SITES, queue: createProfileQueue(), source: 'panel', workdir: WORKDIR,
  })
  const result = await client.status(['fang', 'lianjia'], undefined)
  assert.equal(result.ok, false)
  assert.equal(result.unavailable, false)
  assert.equal(result.sites.length, 1)
})

test('同一 profile 的浏览器操作串行（观测到的最大并发是 1）', async () => {
  const queue = createProfileQueue()
  let active = 0
  let maximum = 0
  const operation = async () => {
    active += 1
    maximum = Math.max(maximum, active)
    await new Promise((resolve) => setTimeout(resolve, 5))
    active -= 1
    return 'done'
  }
  await Promise.all([
    queue.run('crwu:browser:default', undefined, operation),
    queue.run('crwu:browser:default', undefined, operation),
    queue.run('crwu:browser:default', undefined, operation),
  ])
  assert.equal(maximum, 1)
  assert.equal(queue.maxConcurrent('crwu:browser:default'), 1)
  assert.equal(queue.activeCount('crwu:browser:default'), 0)
  assert.equal(queue.queuedCount('crwu:browser:default'), 0)
  // 不同 profile 互不阻塞。
  assert.equal(queue.maxConcurrent('other:profile'), 0)
})

test('取消排队项不会杀掉别人正在跑的操作', async () => {
  const queue = createProfileQueue()
  let release = () => {}
  const running = queue.run('p', undefined, async () => {
    await new Promise((resolve) => { release = resolve })
    return 'first'
  })
  const controller = new AbortController()
  const queued = queue.run('p', controller.signal, async () => 'second')
  await new Promise((resolve) => setTimeout(resolve, 1))
  assert.equal(queue.queuedCount('p'), 1)
  controller.abort()
  await assert.rejects(() => queued, ProfileQueueCancelled)
  assert.equal(queue.activeCount('p'), 1, '正在跑的操作必须继续跑')
  release()
  assert.equal(await running, 'first')
  assert.equal(queue.activeCount('p'), 0)
})

test('已经取消的 signal 不会排进队列', async () => {
  const queue = createProfileQueue()
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(() => queue.run('p', controller.signal, async () => 'x'), ProfileQueueCancelled)
  assert.equal(queue.queuedCount('p'), 0)
})

test('login 结束后必须跑一次权威 status，Cookie 存在不算成功', async () => {
  const runner = makeRunner(async (argv) => {
    if (argv.includes('login')) {
      return {
        ok: true, error: '', exitCode: 0,
        stdout: JSON.stringify({ ok: true, data: { sites: [{ id: 'lianjia', label: '链家', state: 'authenticated', reason: '' }] } }),
        stderr: '', aborted: false, timedOut: false,
      }
    }
    // 权威检查说没登录：即使 login 声称凭据存在，也不能释放门禁。
    return {
      ok: false, error: '有站点未处于已登录状态', exitCode: 1,
      stdout: UNAUTHENTICATED_NONZERO, stderr: '', aborted: false, timedOut: false,
    }
  })
  const client = createBrowserClient({
    run: runner.run, sitesPath: SITES, queue: createProfileQueue(), source: 'panel', workdir: WORKDIR,
  })
  const jobs = createLoginJobs({ client, loginUrlOf: () => 'https://clogin.lianjia.com/login' })
  const started = await jobs.start('lianjia')
  assert.equal(started.ok, true)
  assert.equal(started.reused, false)
  await new Promise((resolve) => setTimeout(resolve, 10))
  const job = jobs.get(started.job.jobId)
  assert.equal(job.state, 'failed')
  assert.equal(job.commandOk, true, 'login 命令本身成功是事实，但它不是结论')
  assert.equal(job.sites[0].state, 'unauthenticated')
  assert.equal(runner.calls.filter((call) => call.argv.includes('status')).length, 1)
  assert.equal(runner.calls.filter((call) => call.argv.includes('login')).length, 1)
})

test('同一 profile 只允许一个登录任务，第二次点击复用同一条', async () => {
  const runner = makeRunner(async (argv) => {
    if (argv.includes('login')) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      return { ok: false, error: '等待登录超时', exitCode: 1, stdout: AUTHENTICATED, stderr: '', aborted: false, timedOut: true }
    }
    return { ok: true, error: '', exitCode: 0, stdout: AUTHENTICATED, stderr: '', aborted: false, timedOut: false }
  })
  const client = createBrowserClient({
    run: runner.run, sitesPath: SITES, queue: createProfileQueue(), source: 'panel', workdir: WORKDIR,
  })
  const jobs = createLoginJobs({ client, loginUrlOf: () => 'https://clogin.lianjia.com/login' })
  const first = await jobs.start('lianjia')
  const second = await jobs.start('lianjia')
  assert.equal(second.reused, true)
  assert.equal(second.job.jobId, first.job.jobId)
  assert.equal(runner.calls.filter((call) => call.argv.includes('login')).length, 1, '不该开第二个登录进程')
})

test('取消登录只中止本页发起的那一条', async () => {
  const runner = makeRunner(async (argv, options) => {
    if (argv.includes('login')) {
      await new Promise((resolve) => {
        const done = () => resolve()
        if (options.signal === undefined) return done()
        if (options.signal.aborted) return done()
        options.signal.addEventListener('abort', done, { once: true })
      })
      return {
        ok: false, error: '登录被取消', exitCode: null, stdout: '',
        stderr: '', aborted: options.signal?.aborted === true, timedOut: false,
      }
    }
    return { ok: true, error: '', exitCode: 0, stdout: AUTHENTICATED, stderr: '', aborted: false, timedOut: false }
  })
  const client = createBrowserClient({
    run: runner.run, sitesPath: SITES, queue: createProfileQueue(), source: 'panel', workdir: WORKDIR,
  })
  const jobs = createLoginJobs({ client, loginUrlOf: () => 'https://clogin.lianjia.com/login' })
  const started = await jobs.start('lianjia')
  assert.equal(jobs.cancel('missing-job').ok, false)
  assert.equal(jobs.cancel(started.job.jobId).ok, true)
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(jobs.get(started.job.jobId).state, 'cancelled')
  // 结束之后不能再取消（避免误伤下一次任务）。
  assert.equal(jobs.cancel(started.job.jobId).ok, false)
})

test('登录任务在可见挑战恢复成功后仍要过权威 status', async () => {
  const runner = makeRunner(async (argv) => {
    if (argv.includes('recover')) {
      return {
        ok: true, error: '', exitCode: 0,
        stdout: JSON.stringify({ ok: true, data: { state: 'recovered', reasonCode: 'no-visible-challenge', attempts: 1, pageValidation: { hostMatches: true, challengeVisible: false } } }),
        stderr: '', aborted: false, timedOut: false,
      }
    }
    if (argv.includes('login')) {
      return { ok: false, error: '登录未完成', exitCode: 1, stdout: '', stderr: '', aborted: false, timedOut: true }
    }
    return { ok: true, error: '', exitCode: 0, stdout: AUTHENTICATED, stderr: '', aborted: false, timedOut: false }
  })
  const client = createBrowserClient({
    run: runner.run, sitesPath: SITES, queue: createProfileQueue(), source: 'panel', workdir: WORKDIR,
  })
  const assists = []
  const jobs = createLoginJobs({
    client,
    loginUrlOf: () => 'https://clogin.lianjia.com/login',
    assist: async (input) => {
      assists.push(input)
      return { state: 'recovered', reasonCode: 'no-visible-challenge', attempts: 1 }
    },
  })
  const started = await jobs.start('lianjia')
  await new Promise((resolve) => setTimeout(resolve, 10))
  const job = jobs.get(started.job.jobId)
  assert.equal(assists.length, 1)
  assert.equal(job.recoveryAttempts, 1)
  assert.equal(job.state, 'succeeded')
  assert.equal(runner.calls.filter((call) => call.argv.includes('login')).length, 2)
  assert.equal(runner.calls.filter((call) => call.argv.includes('status')).length, 1)
})

test('站点清单按 CLI 同一口径校验，坏条目整批拒绝', async () => {
  const { siteListFrom, gateSiteIds, loadBrowserSites } = await import(
    new URL('src/host/domains/report-evaluation/browser/sites.ts', ROOT).href)

  const good = siteListFrom([
    { id: 'fang', label: '房天下', loginUrl: 'https://passport.fang.com/', protectedUrl: 'https://search.fang.com/house/', authCookie: 'fang_token', authDomains: ['.fang.com'] },
    { id: 'lianjia', label: '链家', loginUrl: 'https://clogin.lianjia.com/login', protectedUrl: 'https://bj.lianjia.com/ershoufang/', authCookie: 'lianjia_token', authDomains: ['.lianjia.com'] },
  ])
  assert.equal(good.ok, true)
  assert.deepEqual(good.sites.map((site) => site.id), ['fang', 'lianjia'])
  assert.equal(good.sites[0].label, '房天下')

  assert.equal(siteListFrom([]).ok, false)
  assert.equal(siteListFrom({}).ok, false)
  // 少一项就整批拒绝：静默跳过坏的条目会让门禁悄悄少检一个来源。
  assert.equal(siteListFrom([
    { id: 'lianjia', loginUrl: 'https://clogin.lianjia.com/login', protectedUrl: 'https://bj.lianjia.com/x', authCookie: 'c' },
    { id: 'bad', loginUrl: 'clogin.lianjia.com/login', protectedUrl: 'https://bj.lianjia.com/x', authCookie: 'c' },
  ]).ok, false)
  assert.equal(siteListFrom([
    { id: 'a/b', loginUrl: 'https://a.com/', protectedUrl: 'https://a.com/x', authCookie: 'c' },
  ]).ok, false)
  assert.equal(siteListFrom([
    { id: 'ke', loginUrl: 'https://a.com/', protectedUrl: 'https://a.com/x', authCookie: 'c' },
    { id: 'ke', loginUrl: 'https://b.com/', protectedUrl: 'https://b.com/x', authCookie: 'c' },
  ]).ok, false)

  const config = {
    valuation: { browser: { sitesFile: 'x', requiredSiteIds: ['lianjia'], optionalSiteIds: ['fang'], assistLoginChallenge: true } },
  }
  assert.deepEqual(gateSiteIds(config, good.sites), { required: ['lianjia'], optional: ['fang'] })
  // 协议 39：**空必需集就是空**（不再回退成"全部必需"）—— 登录是可选用能力，
  // 而旧回退会在配置改成可选时静默把所有站点重新变成硬门禁，界面上完全看不出来。
  assert.deepEqual(
    gateSiteIds({ valuation: { browser: { sitesFile: 'x', requiredSiteIds: [], optionalSiteIds: [] } } }, good.sites),
    { required: [], optional: ['fang', 'lianjia'] },
  )
  // 清单里有、两档都没点名的站点仍要展示（它是可用的替代来源，藏起来等于骗人）。
  assert.deepEqual(
    gateSiteIds({ valuation: { browser: { sitesFile: 'x', requiredSiteIds: ['lianjia'], optionalSiteIds: [] } } }, good.sites),
    { required: ['lianjia'], optional: ['fang'] },
  )

  // 真实包内清单必须能加载（它随包发布，是本任务交付的一部分）。
  const loaded = loadBrowserSites({
    configSource: '', caseRoot: '', preferWorkspaceTitle: '', formName: '',
    ossBucket: '', ossPrefix: '', ossEndpoint: '', ossBaseUrl: '', ossLinkMode: 'signed',
    ossLinkTtlSeconds: 3600, autoUpload: true, requireTopLevelParent: true,
    valuation: { browser: { sitesFile: 'skills/biz/crwu-biz-valuation-realestate/assets/browser-sites.json', requiredSiteIds: [], optionalSiteIds: [], assistLoginChallenge: true } },
  })
  assert.equal(loaded.ok, true, loaded.error)
  assert.deepEqual(loaded.sites.map((site) => site.id), ['lianjia'])
})

test('随包登录入口带着站点要求的 service（裸 passport 地址会被站点拒绝）', async () => {
  const { siteListFrom } = await import(
    new URL('src/host/domains/report-evaluation/browser/sites.ts', ROOT).href)
  const { existsSync, readFileSync } = await import('node:fs')
  const path = new URL('skills/biz/crwu-biz-valuation-realestate/assets/browser-sites.json', ROOT)
  if (!existsSync(path)) {
    // 技能可以被单独拷走；源仓契约测试在缺文件时跳过，而不是假装通过。
    return
  }
  const parsed = siteListFrom(JSON.parse(readFileSync(path, 'utf8')))
  assert.equal(parsed.ok, true, parsed.error)
  assert.ok(parsed.sites.length > 0)
  for (const site of parsed.sites) {
    // 2026-10-14 真机实测：`https://clogin.lianjia.com/login`
    // 不带 `service` 时页面只回一句「指定的服务未被授权，不能认证。」——**没有任何登录控件**。
    // 站点自己发布的登录链接是带 `service` 的，而 `service` 里的 `redirect` 指向受保护页。
    const service = new URL(site.loginUrl).searchParams.get('service')
    assert.ok(service !== null && service !== '', `${site.id} 的 loginUrl 缺少 service：${site.loginUrl}`)
    // 登录成功后必须回到**本站的受保护页**：两处指向不同城市/域名时，员工登录完落到别的站点。
    const redirect = new URL(String(service)).searchParams.get('redirect')
    assert.equal(redirect, site.protectedUrl, `${site.id} 的 service.redirect 必须等于 protectedUrl`)
  }
})

test('YAML 的 valuation.browser 严格校验，缺节时退回内置缺省', async () => {
  const { parseWorkbenchYaml } = await import(new URL('src/host/config/yaml.ts', ROOT).href)
  const { readFileSync } = await import('node:fs')
  const base = readFileSync(new URL('config/crwu-workbench.yml', ROOT), 'utf8')
  const parsed = parseWorkbenchYaml(base, 'config/crwu-workbench.yml')
  // 协议 39：链家改为**可选**（未登录不阻止启动，父会话拿到来源策略后按知识降级）。
  assert.deepEqual(parsed.runtime.valuation.browser.requiredSiteIds, [])
  assert.deepEqual(parsed.runtime.valuation.browser.optionalSiteIds, ['lianjia'])
  assert.equal(parsed.runtime.valuation.browser.assistLoginChallenge, true)

  const withoutValuation = base.replace(/^valuation:[\s\S]*?(?=^oss:)/m, '')
  const fallback = parseWorkbenchYaml(withoutValuation, 'no-valuation')
  assert.equal(fallback.runtime.valuation.browser.sitesFile.includes('browser-sites.json'), true)

  // 同一个来源同时写进必需与可选：解析必须拒绝，而不是让两档各说各的。
  const conflicting = base.replace('    requiredSiteIds: []', '    requiredSiteIds:\n      - lianjia')
  assert.throws(() => parseWorkbenchYaml(conflicting, 'conflict'), /既必需又可选/)
  const absolute = base.replace(
    'sitesFile: skills/biz/crwu-biz-valuation-realestate/assets/browser-sites.json',
    'sitesFile: /etc/passwd',
  )
  assert.throws(() => parseWorkbenchYaml(absolute, 'absolute'), /相对包根/)
})

test('能力状态：unknown 与 unauthenticated 分开说，released 只是兼容字段', async () => {
  const { gateFromStatuses, siteRowsOf } = await import(
    new URL('src/host/operations/report-evaluation/auth.ts', ROOT).href)
  const sites = [
    { id: 'fang', label: '房天下', loginUrl: 'https://passport.fang.com/', protectedUrl: 'https://search.fang.com/house/', authCookie: 'c', authDomains: [] },
    { id: 'lianjia', label: '链家', loginUrl: 'https://clogin.lianjia.com/login', protectedUrl: 'https://bj.lianjia.com/x', authCookie: 'c', authDomains: [] },
  ]
  const plan = { required: ['fang', 'lianjia'], optional: [] }

  const allIn = gateFromStatuses(sites, [
    { siteId: 'fang', label: '房天下', state: 'authenticated', reason: '' },
    { siteId: 'lianjia', label: '链家', state: 'authenticated', reason: '' },
  ], plan, false)
  assert.equal(allIn.released, true)
  assert.deepEqual(allIn.required, ['fang', 'lianjia'])

  const signedOut = gateFromStatuses(sites, [
    { siteId: 'fang', label: '房天下', state: 'unauthenticated', reason: '尚未检测到该来源的登录凭据' },
    { siteId: 'lianjia', label: '链家', state: 'authenticated', reason: '' },
  ], plan, false)
  assert.equal(signedOut.released, false)
  // 结论是**能力事实**（"这个来源未登录，本轮改用其它来源"），不再是"整轮暂停等人"。
  assert.match(signedOut.reason, /未登录/)
  assert.match(signedOut.reason, /改用其它来源/)

  const unknown = gateFromStatuses(sites, [
    { siteId: 'fang', label: '房天下', state: 'unknown', reason: '无法访问该来源' },
    { siteId: 'lianjia', label: '链家', state: 'authenticated', reason: '' },
  ], plan, false)
  assert.equal(unknown.released, false)
  assert.match(unknown.reason, /查不出来/)
  assert.equal(/尚未登录/.test(unknown.reason), false, 'unknown 不该被说成"没登录"')

  const rows = siteRowsOf(sites, unknown.released ? [] : [
    { siteId: 'fang', label: '房天下', state: 'unknown', reason: '无法访问该来源' },
  ], plan)
  assert.equal(rows[0].stateLabel, '无法检查')
  assert.equal(rows[0].required, true)
  assert.equal(rows[1].stateLabel, '无法检查', '没查到的站点默认 unknown，不假设已登录')

  const unavailable = gateFromStatuses(sites, [], plan, true)
  assert.equal(unavailable.released, false)
  assert.equal(unavailable.unavailable, true)
})

test('门禁操作：清单读不出来时给不可用结论，登录立刻拉起且复用同一条任务', async () => {
  const { createValuationAuthOperations } = await import(
    new URL('src/host/operations/report-evaluation/auth.ts', ROOT).href)
  const sites = [
    { id: 'lianjia', label: '链家', loginUrl: 'https://clogin.lianjia.com/login', protectedUrl: 'https://bj.lianjia.com/x', authCookie: 'c', authDomains: [] },
  ]
  const config = { valuation: { browser: { sitesFile: 'x', requiredSiteIds: ['lianjia'], optionalSiteIds: [], assistLoginChallenge: true } } }
  const started = []
  const jobs = {
    current: () => [],
    async start(siteId) {
      started.push(siteId)
      return {
        ok: true, error: '', reused: started.length > 1,
        job: { jobId: 'login-1', siteId, state: 'running', startedAt: 0, finishedAt: null, detail: '', sites: [], commandOk: false, recoveryAttempts: 0 },
      }
    },
    cancel: (jobId) => (jobId === 'login-1' ? { ok: true, error: '' } : { ok: false, error: '没有这个登录任务' }),
  }
  const client = { async status() { return { ok: true, error: '', sites: [{ siteId: 'lianjia', label: '链家', state: 'unauthenticated', reason: '尚未检测到该来源的登录凭据' }], unavailable: false } } }

  const ops = createValuationAuthOperations({
    ctx: {}, access: {}, config, client, logins: jobs, sites, sitesPath: '/pkg/sites.json',
  })
  const preflight = await ops['valuation-browser-preflight']({})
  assert.equal(preflight.gate.released, false)
  assert.equal(preflight.rows[0].required, true)

  const login = await ops['valuation-browser-login']({ siteId: 'lianjia' })
  assert.equal(login.ok, true)
  assert.equal(login.reused, false)
  const again = await ops['valuation-browser-login']({ siteId: 'lianjia' })
  assert.equal(again.reused, true)
  assert.deepEqual(await ops['valuation-browser-login']({ siteId: 'nope' }).then((r) => [r.ok, r.error]), [false, '未知来源：nope'])
  assert.equal((await ops['valuation-browser-login-cancel']({ jobId: 'login-1' })).ok, true)
  assert.equal((await ops['valuation-browser-login-cancel']({ jobId: 'nope' })).ok, false)

  const broken = createValuationAuthOperations({
    ctx: {}, access: {}, config, client, logins: jobs, sites, sitesPath: '', sitesError: '站点清单不存在：/pkg/sites.json',
  })
  const unavailable = await broken['valuation-browser-preflight']({})
  assert.equal(unavailable.ok, false)
  assert.equal(unavailable.gate.unavailable, true)
  assert.match(unavailable.gate.reason, /站点清单不存在/)
})

// ── 挑战处置：受保护页要人机验证时，门禁先自己试一次，再让员工动手 ──────────────
//
// 2026-10-14 的现场：员工**已经登录**（profile 里两个站点的 lianjia_token 都在），但受保护页
// 回的是 `hip.lianjia.com/captcha`。当时的门禁只会说"没有登录凭据"，员工被按回登录页 —— 处置是错的。
// 这一组断言钉住三件事：① 判定为 captcha 时**真的**发起一次有界恢复（用受保护的 URL，不是自由
// URL）；② 恢复之后**重新读一次**权威状态，只有真的过了才放行；③ 未恢复时给的是"完成验证"的
// 处置与地址，而不是"请登录"。

test('门禁：受保护页要求人机验证 → 先做一次有界恢复，恢复成功才释放', async () => {
  const { createValuationAuthOperations, gateRecoveryTaskId } = await import(
    new URL('src/host/operations/report-evaluation/auth.ts', ROOT).href)
  const sites = [
    { id: 'lianjia', label: '链家', loginUrl: 'https://clogin.lianjia.com/login?service=x',
      protectedUrl: 'https://bj.lianjia.com/ershoufang/', authCookie: 'lianjia_token', authDomains: ['.lianjia.com'] },
  ]
  const config = { valuation: { browser: { sitesFile: 'x', requiredSiteIds: ['lianjia'], optionalSiteIds: [], assistLoginChallenge: true } } }
  const challengeRow = {
    siteId: 'lianjia', label: '链家', state: 'unknown',
    reason: 'lianjia 的受保护页面要求**人机验证**（不是未登录）',
    verdict: 'captcha', protectedUrl: 'https://bj.lianjia.com/ershoufang/',
  }
  let reads = 0
  const client = {
    async status() {
      reads += 1
      // 第一次：被挑战；恢复之后第二次：正常房源页 → authenticated。
      return reads === 1
        ? { ok: false, error: '', sites: [challengeRow], unavailable: false }
        : { ok: true, error: '', sites: [{ ...challengeRow, state: 'authenticated', reason: '', verdict: 'ok' }], unavailable: false }
    },
  }
  const recoveries = []
  const ops = createValuationAuthOperations({
    ctx: {}, access: {}, config, client,
    logins: { current: () => [], start: async () => ({ ok: false, error: 'unused', reused: false, job: null }), cancel: () => ({ ok: false, error: 'unused' }) },
    sites, sitesPath: '/pkg/sites.json',
    recover: async (input) => { recoveries.push(input); return { state: 'recovered', reasonCode: 'page-ok' } },
  })

  const preflight = await ops['valuation-browser-preflight']({})
  assert.equal(recoveries.length, 1, '判定为 captcha 时必须真的尝试一次有界恢复')
  // 恢复用的是**站点登记过的受保护页**与固定任务 id：调用方提交不了自由 URL，重复点击共享预算。
  assert.equal(recoveries[0].url, 'https://bj.lianjia.com/ershoufang/')
  assert.equal(recoveries[0].taskId, gateRecoveryTaskId('lianjia'))
  assert.equal(reads, 2, '恢复之后必须重新读一次权威状态（不许因为"尝试过了"就放行）')
  assert.equal(preflight.gate.released, true, preflight.gate.reason)
  assert.equal(preflight.rows[0].challenge.state, 'recovered')
  assert.equal(preflight.rows[0].challenge.detected, true)
})

test('门禁：自动恢复没通过 → 给"完成验证"的处置与地址，**不**引导登录', async () => {
  const { createValuationAuthOperations } = await import(
    new URL('src/host/operations/report-evaluation/auth.ts', ROOT).href)
  const sites = [
    { id: 'lianjia', label: '链家', loginUrl: 'https://clogin.lianjia.com/login?service=x',
      protectedUrl: 'https://bj.lianjia.com/ershoufang/', authCookie: 'lianjia_token', authDomains: ['.lianjia.com'] },
  ]
  const config = { valuation: { browser: { sitesFile: 'x', requiredSiteIds: ['lianjia'], optionalSiteIds: [], assistLoginChallenge: true } } }
  const client = {
    async status() {
      return { ok: false, error: '', unavailable: false, sites: [{
        siteId: 'lianjia', label: '链家', state: 'unknown',
        reason: 'lianjia 的受保护页面要求**人机验证**（不是未登录）',
        verdict: 'captcha', protectedUrl: 'https://bj.lianjia.com/ershoufang/',
      }] }
    },
  }
  const ops = createValuationAuthOperations({
    ctx: {}, access: {}, config, client,
    logins: { current: () => [], start: async () => ({ ok: false, error: 'unused', reused: false, job: null }), cancel: () => ({ ok: false, error: 'unused' }) },
    sites, sitesPath: '/pkg/sites.json',
    recover: async () => ({ state: 'waiting-user', reasonCode: 'challenge-visible' }),
  })

  const preflight = await ops['valuation-browser-preflight']({})
  assert.equal(preflight.gate.released, false)
  const row = preflight.rows[0]
  assert.equal(row.state, 'unknown')
  assert.equal(row.challenge.detected, true)
  assert.equal(row.challenge.attempted, true)
  assert.equal(row.challenge.state, 'waiting-user')
  // 员工要能在可见窗口里完成验证：地址是站点清单里的公开受保护页。
  assert.equal(row.challenge.verifyUrl, 'https://bj.lianjia.com/ershoufang/')
  // 处置不是"去登录"：`unknown` 本来就不给登录入口，这里再确认一次。
  assert.equal(row.state === 'unauthenticated', false)
})

test('门禁：配置关掉挑战辅助时不发起恢复（行为可关）', async () => {
  const { createValuationAuthOperations } = await import(
    new URL('src/host/operations/report-evaluation/auth.ts', ROOT).href)
  const sites = [
    { id: 'lianjia', label: '链家', loginUrl: 'https://x/', protectedUrl: 'https://bj.lianjia.com/ershoufang/', authCookie: 'c', authDomains: [] },
  ]
  const config = { valuation: { browser: { sitesFile: 'x', requiredSiteIds: ['lianjia'], optionalSiteIds: [], assistLoginChallenge: false } } }
  let called = 0
  const ops = createValuationAuthOperations({
    ctx: {}, access: {}, config,
    client: { async status() { return { ok: false, error: '', unavailable: false, sites: [{
      siteId: 'lianjia', label: '链家', state: 'unknown', reason: 'x', verdict: 'captcha', protectedUrl: 'https://bj.lianjia.com/ershoufang/',
    }] } } },
    logins: { current: () => [], start: async () => ({ ok: false, error: 'unused', reused: false, job: null }), cancel: () => ({ ok: false, error: 'unused' }) },
    sites, sitesPath: '/pkg/sites.json',
    // `assistLoginChallenge: false` 时 runtime 不会注入 recover；即使注入了也不该调用。
    recover: undefined,
  })
  void called
  const preflight = await ops['valuation-browser-preflight']({})
  // 挑战**信息**照旧上报（界面要能看到"这个来源要求验证"），只是不发起自动恢复。
  assert.equal(preflight.rows[0].challenge?.attempted, false)
  assert.equal(preflight.gate.released, false)
})

// ── 登录任务的判定：登录成功 ≠ 页面读得回来 ────────────────────────────────
//
// 现场口径（2026-10-14）：员工点登录、在浏览器里**登录成功**，但因受保护页回人机验证，
// 面板把这条任务报成 `failed`（"登录状态未通过权威检查"）。那是错的判断：登录本身成功了，
// 缺的是过掉那次验证。诚实的结论是 `waiting-user`。

test('登录任务：登录命令成功但受保护页要人机验证 → waiting-user，不是 failed', async () => {
  const { createLoginJobs } = await import(
    new URL('src/host/domains/report-evaluation/browser/login-jobs.ts', ROOT).href)
  const calls = []
  const client = {
    async login(siteId) { calls.push(['login', siteId]); return { ok: true, error: '', aborted: false, sites: [] } },
    async status(ids) {
      calls.push(['status', ...ids])
      return {
        ok: false, error: '', unavailable: false,
        sites: [{
          siteId: 'lianjia', label: '链家', state: 'unknown',
          reason: 'lianjia 的受保护页面要求**人机验证**（不是未登录）',
          verdict: 'captcha', protectedUrl: 'https://bj.lianjia.com/ershoufang/',
        }],
      }
    },
  }
  const jobs = createLoginJobs({ client, loginUrlOf: () => 'https://clogin.lianjia.com/login?service=x' })
  const started = await jobs.start('lianjia')
  assert.equal(started.ok, true)
  // 等到任务落定（登录命令已经成功返回，紧接着是那次权威 status）。
  const job = await waitForSettled(jobs, started.job.jobId)
  assert.equal(job.state, 'waiting-user', `job.state = ${job.state}（detail=${job.detail}）`)
  assert.match(job.detail, /人机验证/)
  assert.equal(job.commandOk, true, '登录命令本身是成功的，这一点必须保留')
  assert.equal(calls.filter(([kind]) => kind === 'status').length, 1, '权威检查只跑一次')
})

test('登录任务：确实没登录成功时仍然是 failed（不许把失败也说成"去验证"）', async () => {
  const { createLoginJobs } = await import(
    new URL('src/host/domains/report-evaluation/browser/login-jobs.ts', ROOT).href)
  const client = {
    async login() { return { ok: false, error: '登录命令未成功', aborted: false, sites: [] } },
    async status() {
      return { ok: false, error: '登录命令未成功', unavailable: false, sites: [{
        siteId: 'lianjia', label: '链家', state: 'unauthenticated',
        reason: '没有登录凭据：请先登录该来源', verdict: 'login-wall', protectedUrl: 'https://bj.lianjia.com/ershoufang/',
      }] }
    },
  }
  const jobs = createLoginJobs({ client, loginUrlOf: () => 'https://x/' })
  const started = await jobs.start('lianjia')
  const job = await waitForSettled(jobs, started.job.jobId)
  assert.equal(job.state, 'failed')
  assert.match(job.detail, /没有登录凭据|登录命令未成功/)
})

/** 轮询到任务落定（替身没有事件，测试自己等）。 */
async function waitForSettled(jobs, jobId, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const job = jobs.current().find((item) => item.jobId === jobId)
    if (job !== undefined && job.state !== 'running') return job
    if (Date.now() > deadline) return job ?? { state: 'missing', detail: '' }
    await new Promise((resolve) => { setTimeout(resolve, 5) })
  }
}

// ── 2026-10-14 口径：凭据有效 + 页面被挑战 = **已登录**（门禁放行） ────────────
//
// 用户口径：登录成功的判定看凭据（有效期可以作证），人机验证是**页面访问**问题，
// 由后续取数流程处理（自动恢复 → waiting-user → 员工在窗口里完成验证）。
// 之前在门禁里把挑战当成"未通过"，等于让刚刚登录成功的员工永远进不去。

test('门禁：凭据有效但页面被挑战 → 放行，并给出非阻塞的验证提示（不再自动导航）', async () => {
  const { createValuationAuthOperations } = await import(
    new URL('src/host/operations/report-evaluation/auth.ts', ROOT).href)
  const sites = [
    { id: 'lianjia', label: '链家', loginUrl: 'https://clogin.lianjia.com/login?service=x',
      protectedUrl: 'https://bj.lianjia.com/ershoufang/', authCookie: 'lianjia_token', authDomains: ['.lianjia.com'] },
  ]
  const config = { valuation: { browser: { sitesFile: 'x', requiredSiteIds: ['lianjia'], optionalSiteIds: [], assistLoginChallenge: true } } }
  let recoveries = 0
  const ops = createValuationAuthOperations({
    ctx: {}, access: {}, config,
    client: { async status() { return { ok: true, error: '', unavailable: false, sites: [{
      siteId: 'lianjia', label: '链家', state: 'authenticated',
      reason: 'lianjia 已登录（到期 2026-10-15 16:54）；受保护页当前要求人机验证 —— 这是页面访问问题、不是未登录。',
      verdict: 'captcha', protectedUrl: 'https://bj.lianjia.com/ershoufang/',
      expiresAt: '2026-10-15T08:54:42Z', sessionCookie: false,
    }] } } },
    logins: { current: () => [], start: async () => ({ ok: false, error: 'unused', reused: false, job: null }), cancel: () => ({ ok: false, error: 'unused' }) },
    sites, sitesPath: '/pkg/sites.json',
    recover: async () => { recoveries += 1; return { state: 'unsupported', reasonCode: 'x' } },
  })

  const preflight = await ops['valuation-browser-preflight']({})
  assert.equal(preflight.gate.released, true, `gate.reason=${preflight.gate.reason}`)
  assert.equal(recoveries, 0, '已经能用凭据证明登录时不该再去导航受保护页（白白增加风控压力）')
  const row = preflight.rows[0]
  assert.equal(row.state, 'authenticated')
  assert.equal(row.verdict, 'captcha')
  assert.equal(row.expiresAt, '2026-10-15T08:54:42Z')
  // 提示仍在（界面要能说清"验证会在取数时处理"），但它是 detected 而不是 attempted。
  assert.equal(row.challenge?.detected, true)
  assert.equal(row.challenge?.attempted, false)
})

test('登录任务：凭据有效但页面被挑战 → succeeded（登录成功），并在 detail 里说明验证**不是**登录问题', async () => {
  const { createLoginJobs } = await import(
    new URL('src/host/domains/report-evaluation/browser/login-jobs.ts', ROOT).href)
  const client = {
    async login() { return { ok: true, error: '', aborted: false, sites: [] } },
    async status() {
      return { ok: true, error: '', unavailable: false, sites: [{
        siteId: 'lianjia', label: '链家', state: 'authenticated',
        reason: '已登录（到期 2026-10-15 16:54）；受保护页当前要求人机验证',
        verdict: 'captcha', protectedUrl: 'https://bj.lianjia.com/ershoufang/',
        expiresAt: '2026-10-15T08:54:42Z', sessionCookie: false,
      }] }
    },
  }
  const jobs = createLoginJobs({ client, loginUrlOf: () => 'https://x/' })
  const started = await jobs.start('lianjia')
  const job = await waitForSettled(jobs, started.job.jobId)
  assert.equal(job.state, 'succeeded', `state=${job.state} detail=${job.detail}`)
  assert.match(job.detail, /已确认登录状态/)
  assert.match(job.detail, /人机验证/)
})
