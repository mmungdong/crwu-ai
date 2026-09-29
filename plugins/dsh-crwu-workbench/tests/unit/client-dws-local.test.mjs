/**
 * 「钉钉本机目录」卡片的判据测试（协议 18 · 子项目 D3 的界面侧）。
 *
 * 这里守的是一条**交互**规则，不是样式：修复按钮只在确诊"本机文件权限问题"时出现。
 * 沙箱拒绝 / 降级 / 钥匙串 / 认证失败 / 所有者不对 / 文件锁这六类问题**改文件权限解决不了**，
 * 渲染一个按下去必然失败的按钮，员工会以为是权限问题反复点。
 *
 * 断言直接打在这两个纯函数上（不需要 tsx-loader），并逐类覆盖 —— "按钮不出现"这种规则
 * 只测一个反例是不够的，漏掉哪一类都不会有人发现。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { registerTsxLoader } from '../helpers/tsx-loader.mjs'

// `DwsLocalCard.tsx` 是真组件模块（要过 JSX 转换），所以这里必须注册加载器 ——
// 与其余客户端测试同一条路（本仓不引入 vitest / jsdom）。
registerTsxLoader()

const ROOT = new URL('../../', import.meta.url)
const { repairOffered, dwsLocalSummary, repairSummary } = await import(
  new URL('src/client/features/environment/DwsLocalCard.tsx', ROOT).href)
const { accessDiagnosticLine } = await import(
  new URL('src/client/features/environment/EnvironmentPane.tsx', ROOT).href)
const { zhCN } = await import(new URL('src/client/locales/zh-CN.ts', ROOT).href)

/** 一份"体检通过、目录可写"的基线视图。 */
function doctor(patch = {}) {
  return {
    ok: true,
    error: '',
    platform: 'darwin-arm64',
    permissionMechanism: 'posix-mode',
    directoryExists: true,
    lockExists: true,
    ownerMatchesCurrentUser: true,
    currentUserCanModify: true,
    directoryMode: '700',
    lockMode: '600',
    credentialStoreState: 'missing-secret',
    dwsDoctorState: 'pass=2 fail=2 warn=0 failing=auth,version',
    classification: '',
    ...patch,
  }
}

test('D-03 · 只有确诊"本机文件权限问题"时才渲染修复按钮', () => {
  assert.equal(repairOffered(doctor({ classification: 'os-filesystem-permission', currentUserCanModify: false })), true)
})

test('D-04/D-05/D-08 · 六类"不是权限问题"的结论都不渲染修复按钮', () => {
  const notPermission = {
    'sandbox-denied': doctor({ classification: 'sandbox-denied', currentUserCanModify: false }),
    'sandbox-downgraded': doctor({ classification: 'sandbox-downgraded', currentUserCanModify: false }),
    'os-credential-store': doctor({ classification: 'os-credential-store', credentialStoreState: 'interaction-denied' }),
    'authentication': doctor({ classification: 'cli', credentialStoreState: 'missing-secret' }),
    'file-lock': doctor({ classification: 'file-lock', lockExists: true }),
    'wrong-owner': doctor({ classification: '', ownerMatchesCurrentUser: false, currentUserCanModify: false }),
  }
  for (const [label, view] of Object.entries(notPermission)) {
    assert.equal(repairOffered(view), false, label)
  }
  // 还没查过 / 查询失败：同样不渲染。
  assert.equal(repairOffered(null), false)
  assert.equal(repairOffered(doctor({ ok: false, error: '拿不到主目录' })), false)
})

test('员工口径的一句话：每一类都给**可操作**的下一步，不说术语', () => {
  assert.equal(dwsLocalSummary(doctor()), zhCN.dwsLocalWritable)
  assert.equal(dwsLocalSummary(doctor({ directoryExists: false })), zhCN.dwsLocalNoDirectory)
  assert.equal(dwsLocalSummary(doctor({ ownerMatchesCurrentUser: false, currentUserCanModify: false })), zhCN.dwsLocalWrongOwner)
  assert.equal(dwsLocalSummary(doctor({ classification: 'file-lock' })), zhCN.dwsLocalLocked)
  assert.equal(
    dwsLocalSummary(doctor({ classification: 'os-credential-store', credentialStoreState: 'interaction-denied' })),
    zhCN.dwsLocalKeychain,
  )
  assert.equal(dwsLocalSummary(doctor({ credentialStoreState: 'missing-secret', currentUserCanModify: false })), zhCN.dwsLocalNotWritable)
  // 可写优先于"还没登录"（登录态由钉钉那一行负责说）；读不到可写性时才用登录态兜底。
  assert.equal(dwsLocalSummary(doctor({ credentialStoreState: 'missing-secret' })), zhCN.dwsLocalWritable)
  assert.equal(dwsLocalSummary(doctor({ credentialStoreState: 'missing-secret', currentUserCanModify: null })), zhCN.dwsLocalNotLoggedIn)
  // 失败时如实说失败，不编一句"未知"。
  assert.equal(dwsLocalSummary(doctor({ ok: false, error: '拿不到主目录：无法推导 DWS 目录' })), '拿不到主目录：无法推导 DWS 目录')
  // 排序：**锁被占用 + 目录恰好可写**时不许说「可读写，正常」（那会把真问题盖掉）。
  assert.equal(dwsLocalSummary(doctor({ classification: 'file-lock', currentUserCanModify: true })), zhCN.dwsLocalLocked)
  assert.equal(
    dwsLocalSummary(doctor({ classification: 'os-credential-store', credentialStoreState: 'access-denied', currentUserCanModify: true })),
    zhCN.dwsLocalKeychain,
  )
  // 员工文案里不许出现技术术语（模式位 / ACL / SID / 路径）。
  for (const text of [zhCN.dwsLocalWritable, zhCN.dwsLocalNotWritable, zhCN.dwsLocalWrongOwner, zhCN.dwsLocalLocked, zhCN.dwsLocalKeychain, zhCN.dwsLocalNotLoggedIn]) {
    assert.equal(/ACL|SID|0700|0600|mode/i.test(text), false, text)
  }
})

test('P-15/P-16 · 开发者诊断里那一行必须带齐 §11 要的证据，且不含命令原文', () => {
  // 验收要求每条失败都能给出：操作名 / 来源 / 请求·解析·实际模式 / denied / runnerFailed /
  // 归因类别 / 失败发生在进程创建之前还是之后。这一行就是那个出口 —— 少一项就没法留证。
  const line = accessDiagnosticLine({
    operation: 'oss.config.write',
    source: 'panel',
    consentVersion: 1,
    requestedMode: 'danger-full-access',
    resolvedMode: 'danger-full-access',
    ranMode: 'workspace-write',
    sandboxDenied: true,
    runnerFailed: false,
    errorClass: 'sandbox-downgraded',
    processStarted: true,
    hostVersion: '0.0.15',
    protocolVersion: 18,
    summary: 'ossutil ls（探测）',
    at: '2026-09-29T00:00:00.000Z',
  })
  for (const needle of [
    'oss.config.write', 'panel',
    'req=danger-full-access', 'res=danger-full-access', 'ran=workspace-write',
    'denied=true', 'runnerFailed=false', 'started=true', 'sandbox-downgraded',
  ]) {
    assert.equal(line.includes(needle), true, `缺 ${needle}：${line}`)
  }
  // 起过的进程 vs 没起过：`started` 就是"失败发生在进程创建之前还是之后"那一项。
  const beforeProcess = accessDiagnosticLine({
    operation: 'dws.auth.login', source: 'panel', consentVersion: 1,
    requestedMode: 'danger-full-access', resolvedMode: '', ranMode: '',
    sandboxDenied: false, runnerFailed: true, errorClass: 'infrastructure',
    processStarted: false, hostVersion: '0.0.15', protocolVersion: 18,
    summary: 'dws auth login', at: '2026-09-29T00:00:00.000Z',
  })
  assert.equal(beforeProcess.includes('started=false'), true)
  assert.equal(beforeProcess.includes('runnerFailed=true'), true)
  // 空串模式要显式写成"未设置"，不能留空让人猜。
  assert.equal(beforeProcess.includes('res=（未设置）') || beforeProcess.includes('res=未设置'), true, beforeProcess)
  // 这一行**不许**带命令原文 / 路径 / 凭据（诊断里本来也没有，这里是反向断言）。
  for (const forbidden of ['ossutil ls oss://', 'AccessKey', '/Users/', '.ossutilconfig']) {
    assert.equal(line.includes(forbidden), false, `诊断行泄露了 ${forbidden}`)
  }
})

test('D2 · 体检的前置条件要写在界面上（它是事后归因，不是随时可跑的健康检查）', () => {
  // 设计 §D2：doctor 只在"刚刚发生过一次 DWS 失败"之后运行。界面必须把这件事说清，
  // 否则员工点一下拿到"还没有可以归因的 DWS 失败"会以为按钮坏了。
  assert.match(zhCN.dwsLocalNeedsFailure, /复现/)
  assert.match(zhCN.dwsLocalNeedsFailure, /刚才/)
  // Host 拒绝时的理由原样展示（`doctor.ok === false` → 卡片显示 `doctor.error`）。
  const refused = {
    ok: false, error: '还没有可以归因的 DWS 失败：请先复现一次（体检只回答"刚才那次为什么失败"）。',
    platform: 'darwin-arm64', permissionMechanism: 'posix-mode', directoryExists: null, lockExists: null,
    ownerMatchesCurrentUser: null, currentUserCanModify: null, directoryMode: '', lockMode: '',
    credentialStoreState: 'unknown', dwsDoctorState: '', classification: 'not-applicable',
  }
  assert.equal(dwsLocalSummary(refused), refused.error)
  // 体检没给结论时**不许**冒出修复按钮。
  assert.equal(repairOffered(refused), false)
})

test('D-06 · 修复结果只说"修了几项、几项没做成"，不回路径与命令', () => {
  const result = {
    ok: true, error: '', repaired: ['directory-mode', 'lock-mode'], skipped: [],
    doctor: doctor(), authStatus: 'not-authenticated',
  }
  assert.equal(repairSummary(result), `${zhCN.dwsLocalRepaired}2`)
  assert.equal(repairSummary({ ...result, skipped: ['lock-mode'] }), `${zhCN.dwsLocalRepaired}2（1 项没做成）`)
  assert.equal(repairSummary({ ...result, ok: false, error: '当前结论是 cli，没有确诊"本机文件权限问题"：未做任何改动' }),
    '当前结论是 cli，没有确诊"本机文件权限问题"：未做任何改动')
  // 二次确认那句话必须写清**范围**（只改 .dws、不改上级、不改所有者、不删锁）。
  for (const phrase of ['$HOME/.dws', '不会改动上级目录', '不会改变所有者', '不会删除锁文件']) {
    assert.equal(zhCN.dwsLocalRepairConfirm.includes(phrase), true, phrase)
  }
})
