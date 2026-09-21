import type { ServiceCheckView } from '../../../shared/types.ts'
import type { EnvResult } from '../report-audit/api.ts'
import { zhCN } from '../../locales/zh-CN.ts'

/**
 * 环境自检页的**分层规则**（纯函数，组件只渲染）。
 *
 * 为什么单独一个模块：这一页旧的毛病不是"不好看"，是**没有层次** —— 5/5 都通过的工具和
 * "氚云没登录"同权重地堆在一列里，维护者噪声（sha256、清单来源、probe 原文）混在员工视野里，
 * 而且只有 iFinD 给了"怎么配"。分层、排序、状态词、"怎么办"这四件事全是判断，放在组件里
 * 就只能靠人眼看界面来验证，所以抽到这里由单测覆盖。
 *
 * 四个层固定顺序（员工排查顺序）：工具 → 登录认证 → 上传配置（AK）→ 外部数据。
 * ① 案例根目录由 WorkspaceCard 承担（它要先于这四层），排查详情（维护者看）不在层里。
 */

export type EnvItemState = 'ok' | 'missing' | 'reauth'
export type EnvLayerId = 'tools' | 'auth' | 'upload' | 'external'
/** 该项"怎么配"要用哪种交互；`none` = 已就绪、不需要动。 */
export type EnvFixKind = 'none' | 'tool' | 'h3yun' | 'dws' | 'oss' | 'ifind'

export interface EnvLayerItem {
  id: string
  /** 显示名（工具用 Host 的 name，服务用 Host 的 label）。 */
  name: string
  state: EnvItemState
  /** 状态词：已就绪 / 未配置 / 版本不符 / Host 原文（未绑定、未登录、探测失败…）。 */
  stateText: string
  /** 一句人话：它是干什么用的。 */
  purpose: string
  /** 现在是什么情况（实际路径 / 版本 / AK 掩码 / 连通性）。 */
  meta: string
  /** 没就绪的原因（Host 原文，不改写）。 */
  reason: string
  /** 怎么配置（人话）；已就绪时是空串。 */
  fix: string
  fixKind: EnvFixKind
  /** 工具：下载地址；空串 = 本平台暂无预编译包。 */
  url: string
  /** 工具：安装目标路径（HOST 给的 host 相对路径）。 */
  target: string
  /** 以下四项只进"排查详情"，员工视野里不出现。 */
  expect: string
  sha256: string
  detail: string
  note: string
}

export interface EnvLayer {
  id: EnvLayerId
  title: string
  /** 通过数 / 总数，用于 `x/y 已就绪`。 */
  pass: number
  total: number
  /** 本层有没有没就绪的项（决定默认展开还是收成一行）。 */
  needsWork: boolean
  /** 没就绪的项排在最前；同组内保持 Host 给的顺序。 */
  items: EnvLayerItem[]
}

/** 状态词：Host 的 `state` 是外部原始数据（未绑定 / 未登录 / 探测失败），按原样显示更能说明问题。 */
function authStateText(state: string): string {
  if (state === '已过期') return zhCN.envItemReauth
  if (state === '') return zhCN.envItemMissing
  return state
}

/** 没就绪的排在前面（稳定：同组内保持原顺序）。 */
function notReadyFirst(items: EnvLayerItem[]): EnvLayerItem[] {
  return [...items.filter((item) => item.state !== 'ok'), ...items.filter((item) => item.state === 'ok')]
}

function layerOf(id: EnvLayerId, title: string, items: EnvLayerItem[]): EnvLayer {
  const pass = items.filter((item) => item.state === 'ok').length
  return { id, title, pass, total: items.length, needsWork: pass < items.length, items: notReadyFirst(items) }
}

/** ② 工具与运行时：Host 的 `checks`（node / crwu / dws / python3 / ossutil）。 */
function toolItem(check: EnvResult['checks'][number]): EnvLayerItem {
  const ok = check.ok === true
  const meta = check.found
    ? `${check.path}${check.versionText === '' ? '' : ` · ${check.versionText}`}`
    : zhCN.envNotInstalled
  return {
    id: `tool-${check.name}`,
    name: check.name,
    state: ok ? 'ok' : 'missing',
    // 装上了但版本/校验不达标时说"版本不符"：说成"未配置"会让人去重装一个已经在的东西。
    stateText: ok ? zhCN.envItemOk : (check.found ? zhCN.envItemOutdated : zhCN.envItemMissing),
    purpose: check.note,
    meta,
    reason: check.reason,
    fix: ok ? '' : (check.url === '' ? `${zhCN.envFixTool}（${zhCN.envFixToolNoPackage}）` : zhCN.envFixTool),
    fixKind: ok ? 'none' : 'tool',
    url: check.url,
    target: check.target,
    expect: check.expect,
    sha256: check.sha256,
    detail: check.actual,
    note: check.note,
  }
}

/** ③ 登录认证：Host 的 `services` 里非 oss 的那几条（氚云 / 钉钉 / 清单声明的其它服务）。 */
function authItem(service: ServiceCheckView): EnvLayerItem {
  const ok = service.ok === true
  const purpose = service.id === 'h3yun'
    ? zhCN.envPurposeH3yun
    : (service.id === 'dingtalk' ? zhCN.envPurposeDingtalk : '')
  // 没授权时，"怎么办"就是先授权（其它步骤在授权前都做不了）；授权后才是登录/重登那条路径。
  const fix = service.state === '需要授权'
    ? zhCN.envFixAuthorize
    : (service.id === 'h3yun'
      ? zhCN.envFixH3yun
      : (service.id === 'dingtalk' ? zhCN.envFixDws : zhCN.envFixService))
  return {
    id: `service-${service.id}`,
    name: service.label,
    state: ok ? 'ok' : (service.state === '已过期' ? 'reauth' : 'missing'),
    stateText: ok ? zhCN.envItemOk : authStateText(service.state),
    purpose,
    // 同一个 detail 只出现一次：就绪时当"现在是什么情况"，没就绪时当"为什么没过"
    // （两边都填会在界面上原样重复两遍 —— 实测渲染出来就是这样）。
    meta: ok ? service.detail : '',
    reason: ok ? '' : service.detail,
    fix: ok ? '' : fix,
    fixKind: ok ? 'none' : (service.id === 'h3yun' ? 'h3yun' : (service.id === 'dingtalk' ? 'dws' : 'none')),
    url: '',
    target: '',
    expect: '',
    sha256: '',
    detail: service.detail,
    note: '',
  }
}

/** ④ 上传配置（OSS AK）：凭据文件 + Host 的 oss 连通性探测。 */
function uploadItem(env: EnvResult): EnvLayerItem {
  const cred = env.ossCred
  const probe = (env.oss.probe ?? {}) as { ok?: boolean; state?: string; detail?: string }
  const service = env.services.find((item) => item.id === 'oss')
  const credReady = cred.exists === true && cred.hasSecret === true
  // 连通性优先用 Host 的服务探测（它带 state/detail）；老 Host 没这条时退回 oss.probe。
  const connectivityOk = service === undefined ? probe.ok === true : service.ok === true
  const ok = credReady && connectivityOk
  const masked = cred.accessKeyIdMasked === '' ? zhCN.envOssCredMissing : cred.accessKeyIdMasked
  const probeState = service?.state ?? probe.state ?? ''
  const file = cred.path === '' ? '~/.ossutilconfig' : cred.path
  const meta = `${file} · AK ${masked}${probeState === '' ? '' : ` · ${probeState}`}`
  const reason = ok
    ? ''
    : (!cred.exists
      ? zhCN.envOssReasonNoCred
      : (!cred.hasSecret ? zhCN.envOssReasonNoSecret : (service?.detail ?? probe.detail ?? '')))
  return {
    id: 'oss-cred',
    name: zhCN.envItemOssName,
    state: ok ? 'ok' : 'missing',
    stateText: ok ? zhCN.envItemOk : zhCN.envItemMissing,
    purpose: zhCN.envPurposeOss,
    meta,
    reason,
    fix: ok ? '' : zhCN.envFixOss,
    fixKind: ok ? 'none' : 'oss',
    url: '',
    target: '',
    expect: '',
    sha256: '',
    detail: service?.detail ?? probe.detail ?? '',
    note: '',
  }
}

/** ⑤ 外部数据：同花顺 iFinD 的 auth_token（只回长度，绝不回显）。 */
function ifindItem(env: EnvResult): EnvLayerItem {
  const ifind = env.ifindKey
  const ok = ifind.ok === true
  const where = ifind.path === '' ? zhCN.envUnset : ifind.path
  return {
    id: 'ifind-token',
    name: zhCN.ifindItemName,
    state: ok ? 'ok' : 'missing',
    stateText: ok ? zhCN.envItemOk : zhCN.envItemMissing,
    purpose: zhCN.envPurposeIfind,
    meta: ok
      ? `${zhCN.envIfindPath} ${where} · ${zhCN.ifindConfigured}${String(ifind.tokenLength)}${zhCN.ifindNoEcho}`
      : `${zhCN.envIfindPath} ${where}`,
    reason: ok ? '' : (ifind.reason === '' ? zhCN.ifindMissing : ifind.reason),
    fix: ok ? '' : `${zhCN.envFixIfind}${where}${zhCN.envFixIfindField}${zhCN.envFixIfindExample}${zhCN.envFixIfindNote}`,
    fixKind: ok ? 'none' : 'ifind',
    url: '',
    target: '',
    expect: '',
    sha256: '',
    detail: '',
    note: '',
  }
}

/** 四个层的完整结构（顺序固定：工具 → 登录认证 → 上传配置 → 外部数据）。 */
export function envLayers(env: EnvResult): EnvLayer[] {
  const auth = env.services.filter((service) => service.id !== 'oss')
  return [
    layerOf('tools', zhCN.envLayerTools, env.checks.map(toolItem)),
    layerOf('auth', zhCN.envLayerAuth, auth.map(authItem)),
    layerOf('upload', zhCN.envLayerUpload, [uploadItem(env)]),
    layerOf('external', zhCN.envLayerExternal, [ifindItem(env)]),
  ]
}

export interface EnvLayerSet {
  tools: EnvLayer
  auth: EnvLayer
  upload: EnvLayer
  external: EnvLayer
}

/**
 * 按 id 取四层。
 *
 * 组件里刻意不走下标（`layers[0]`）：层顺序哪天变了，下标会**静默**画错一层；这里找不到就抛。
 */
export function envLayerSet(env: EnvResult): EnvLayerSet {
  const all = envLayers(env)
  const pick = (id: EnvLayerId): EnvLayer => {
    const hit = all.find((layer) => layer.id === id)
    if (hit === undefined) throw new Error(`envLayers 未返回 ${id} 层`)
    return hit
  }
  return { tools: pick('tools'), auth: pick('auth'), upload: pick('upload'), external: pick('external') }
}

/** 员工视野里"还差什么"的一句话（Hero 用 Host 的权威清单，不自己拼结论）。 */
export function envTodoText(env: EnvResult): string {
  if (env.allOk === true) return zhCN.envHeroOkSub
  if (env.blocked.length === 0) return zhCN.envHeroBadSub
  return `${zhCN.envHeroTodo}${String(env.blocked.length)}${zhCN.envHeroTodoTail}`
}
