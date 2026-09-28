import { homedir } from 'node:os'
import { HOST_BUILD_KIND, HOST_BUILD_STAMP } from '../build-info.ts'
import { PLUGIN_REV, PLUGIN_VERSION } from '../consts.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { WorkbenchConfig } from '../config/config.ts'
import { workspaceView } from '../state/store.ts'
import type { WorkbenchState } from '../state/types.ts'
import { finiteNumber, text } from '../../shared/utils/value.ts'
import { auditRelease, auditStart, auditStatus, auditStop } from '../audit/ops.ts'
import { WORKBENCH_PROTOCOL } from '../../shared/consts.ts'
import { ensureRegistry } from '../state/registry.ts'
import { writeWorkbenchConfig } from '../state/persist.ts'
import { adoptWorkspace, autoWorkspace, pickWorkspace } from '../workspace/ops.ts'
import { sessionWorkspaceInfo } from '../workspace/resolve.ts'
import { auditRootView } from '../audit/root.ts'
import { maybeAutoUpload } from '../oss/auto.ts'
import { ossCredSave, ossIndex, ossLink, ossResult, ossUpload, type OssDeps } from '../oss/ops.ts'
import { reportFiles } from '../report/files.ts'
import { createUploadWatch } from '../oss/watch.ts'
import { clipboard, dwsLogin, openPath, ossCred, relogin, sessionStatus } from '../system/ops.ts'
import { dwsSelf, type WhoamiResult } from '../system/identity.ts'
import { runCrwu } from '../crwu/run.ts'
import { loadEnvironment } from '../environment/ops.ts'
import { createCapabilityGate, guardOperation } from '../environment/gate.ts'
import { ifindCredentialClear, ifindCredentialSave, ifindProbe, ifindStatus, type IfindOpsDeps } from '../tools/ifind-ops.ts'
import { createIfindProbeCache } from '../ifind/env.ts'
import { ifindCredentialView } from '../ifind/store.ts'
import { missingAuditTools } from '../tools/register.ts'
import type { IfindTransport } from '../ifind/mcp.ts'
import { loadPending } from '../h3yun/pending.ts'
import type { H3yunFormResolver } from '../h3yun/form.ts'
import type { PythonRuntimeResolver } from '../runtime/python.ts'
import type { WorldFacts } from '../platform/world.ts'
import type { OperationMap } from './types.ts'

interface DelegationView {
  found: boolean
  subagent: boolean
  depth: number
  parentSession: string
}

function sessionDelegation(ctx: Context, id: string): DelegationView {
  const result = { found: false, subagent: false, depth: 0, parentSession: '' }
  if (id === '') return result
  try {
    const sessions = (ctx as unknown as {
      sessions?: { get(sessionId: string): { header?: Record<string, unknown> } | undefined }
    }).sessions
    if (sessions === undefined || typeof sessions.get !== 'function') return result
    const header = sessions.get(id)?.header
    if (header === undefined) return result
    result.found = true
    result.subagent = text(header.origin) === 'subagent'
    result.depth = finiteNumber(header.delegationDepth)
    result.parentSession = text(header.parentSession)
  } catch (error) {
    // 会话服务不可用时保留“未知”状态，不阻断用户继续处理环境问题。
    void error
  }
  return result
}

/**
 * 创建包形态当前已经支持的操作表。
 *
 * `IfindOps` 与 `auditTools` 都是**可注入**的：
 * - `ifind.transport` 让单测用内存替身（永不访问真实网络）；
 * - `ifind.timeoutMs` 让单测用短超时；
 * - `auditTools` 让「必需 Tool 是否可见」这件事在自检里有真实事实（替身里也可以模拟收窄）。
 */
export interface CoreDeps {
  ifindTransport?: IfindTransport
  ifindTimeoutMs?: number
  /**
   * iFinD 探测缓存（插件实例级）：
   * - 不传时每个 `createCoreOperations()` 自建一份（**同一个插件实例共用**，
   *   所以面板反复刷新不会重复打上游）；
   * - 传 `null` 表示不缓存（单测里想看每次调用都真探）。
   */
  ifindProbeCache?: import('../ifind/env.ts').IfindProbeCache | null
  auditTools?: (options: { refresh: boolean }) => Promise<{ missing: string[]; checked: boolean }>
  /**
   * Task 4 的四个自助更新操作（由 `update/ops.ts` 组装）。
   *
   * 这里只做**组合**：拿到就并进操作表，并把名字登记进 `ported.done` —— 声明从真实注入的
   * 操作表推导，避免"声明一份、实现一份"漂移（clipboard 那次就是这么踩的）。
   */
  update?: OperationMap
}

export interface HostResolvers {
  /** 氚云表单 code 的实例级解析器（列表 / 审核启动 / 业务 Tool 共用）。 */
  form: H3yunFormResolver
  /** DSH 自带 Python 的实例级解析器（审核启动与环境页共用）。 */
  python: PythonRuntimeResolver
}

export function createCoreOperations(
  ctx: Context,
  config: WorkbenchConfig,
  state: WorkbenchState,
  world: WorldFacts,
  resolvers: HostResolvers,
  extra: CoreDeps = {},
): OperationMap {
  /**
   * OSS 操作的依赖。
   *
   * 必须每次调用时重新构造：清单是环境自检拉来的，平台是探测出来的，
   * 都可能在这之后才就绪。构造时抓一次快照会让第一次调用永远拿到内置默认清单。
   */
  const ossDeps = async (): Promise<OssDeps> => ({
    ctx,
    manifest: state.manifest,
    platform: await world.platform(),
    home: await world.home(),
    workdir: () => world.workdir(),
  })
  // 上传看门狗：审核跑完不会回调，只能轮询「有结果就传」。句柄挂在插件实例上。
  const watch = createUploadWatch(ctx, state, ossDeps)
  /**
   * 「我是谁」的进程内缓存（面板头部那句问候的姓名）。
   *
   * 它挂在**环境自检**上（用户口径：「这个钉钉 cli 环境监测一遍就可以了，不需要每次切换页面
   * 都去调」），所以这里要挡住的是"反复自检"：姓名在一次登录周期里不会变，缓存住就不再跑
   * `dws` 冷启动。**只缓存成功的结果** —— 失败（没登录 / 命令没跑起来）不缓存，
   * 员工登录之后刷一下自检就能拿到，不用重启 profile。
   */
  let meCache: WhoamiResult | null = null
  const identity = async (): Promise<WhoamiResult> => {
    if (meCache !== null) return meCache
    const me = await dwsSelf({ ctx, workdir: () => world.workdir(), platform: await world.platform() })
    if (me.name !== '') meCache = me
    return me
  }
  // 定时器必须随插件生命周期释放；这里只登记释放动作，启动由 audit-start 触发。
  ctx.effect(() => watch.stop, 'crwu-workbench: upload watch')

  /**
   * 环境自检的唯一入口（`env` 操作与能力门禁共用）。
   *
   * 共用是刻意的：门禁必须与界面看到的是**同一份事实**；各跑一套的结果是
   * 「界面说没配好、Host 放行」或者反过来（见 `environment/gate.ts`）。
   */
  const loadEnv = async (options: { refresh: boolean; probeIfind?: boolean }): Promise<Record<string, unknown>> => {
    const [platform, home] = [await world.platform(), await world.home()]
    return await loadEnvironment(
      // 「我是谁」跟着自检一起拿（见 identity 的注释）：自检本来就要问一次钉钉登录态。
      {
        ctx, config, state, home, platform,
        sessionRoot: () => world.workdir(),
        identity,
        // DSH 自带 Python 由实例级解析器给（成功缓存、失败可显式刷新）。
        pythonRuntime: (request: { refresh: boolean }) => resolvers.python.check({ refresh: request.refresh }),
        // 必需 Tool 的可见性：默认按根 Agent 查一次；宿主可注入替身用于测试收窄场景。
        ...(extra.auditTools === undefined
          ? { auditTools: async () => ({ missing: missingAuditTools(ctx, undefined), checked: true }) }
          : { auditTools: extra.auditTools }),
        ...(extra.ifindTransport === undefined ? {} : { ifindTransport: extra.ifindTransport }),
        ...(probeCache === undefined ? {} : { ifindProbeCache: probeCache }),
      },
      {
        ...(options.refresh ? { refresh: true } : {}),
        // `probeIfind` 只由界面在「保存 SK 之后」与「重新验证」时传：默认不主动打外部网络。
        ...(options.probeIfind === true ? { probeIfind: true } : {}),
      },
    ) as unknown as Record<string, unknown>
  }
  /**
   * 能力门禁：**带失效策略的快照**（默认 60s），敏感操作复用它而不是各自重跑一遍自检。
   * 会改变环境事实的操作（授权、选工作空间、保存凭据、登录）之后调 `invalidate()`。
   */
  const gate = createCapabilityGate(async (options) => {
    const result = await loadEnv(options)
    const state = result.state as import('../../shared/environment/model.ts').EnvironmentStateView | undefined
    return state ?? null
  })
  // 探测结果缓存：同一个插件实例共用一份（30s TTL），保存 / 清除凭据后由指纹自然失效。
  const probeCache = extra.ifindProbeCache === null
    ? undefined
    : (extra.ifindProbeCache ?? createIfindProbeCache())
  const ifindDeps: IfindOpsDeps = {
    ctx,
    home: () => world.home(),
    platform: () => world.platform(),
    ...(extra.ifindTransport === undefined ? {} : { transport: extra.ifindTransport }),
    ...(extra.ifindTimeoutMs === undefined ? {} : { timeoutMs: extra.ifindTimeoutMs }),
  }

  /**
   * 敏感操作的 Host 侧门禁：被拒绝时返回失败信封，放行返回 null。
   *
   * 判据是**同一份环境快照**（`gate`），所以不会为每个操作重跑一遍昂贵自检；
   * 拿不到快照或自检失败一律 fail closed。
   */
  const guard = async (operation: string): Promise<Record<string, unknown> | null> =>
    await guardOperation(gate, operation)

  // 四个 update 操作（Task 4）：名字从**真实注入的操作表**推导，声明与实现不会各写一份。
  const updateOperations = extra.update ?? {}

  return {
    // Task 4：自助更新四个操作（检查 / 手动检查 / 安装 / 取消）。由 update/ops.ts 组装，
    // 这里只并表；没有注入时就不登记（声明必须跟着实现走）。
    ...updateOperations,
    // `rev` 只反映包版本，同一轮开发里两次 build 完全相同；`builtAt` 是这份产物的写入时间，
    // 用来回答「重启之后生效的是不是我刚 build 的那份」（见 AGENTS.md §7 的本地开发循环）。
    ping: () => ({
      ok: true, rev: PLUGIN_REV, version: PLUGIN_VERSION, buildKind: HOST_BUILD_KIND,
      at: new Date().toISOString(), builtAt: HOST_BUILD_STAMP,
      // 客户端拿它判断「跑着的宿主是不是同一代」——见 shared/consts.ts 的 WORKBENCH_PROTOCOL。
      protocol: WORKBENCH_PROTOCOL,
    }),
    boot: async () => {
      // legacy 的 boot 是面板挂载后第一个被调用的操作，它顺手恢复了注册表并采用工作空间；
      // 不补这一步，第一次响应里的 workspace 永远是「未选定」，界面会先闪一下空状态。
      await ensureRegistry(ctx, await world.home(), state)
      await adoptWorkspace({ ctx, config, state, world })
      return {
      ok: true,
      protocol: WORKBENCH_PROTOCOL,
      // 面板标题旁要显示「现在跑的是哪一版」：客户端刷一下就换新，宿主只有重启才换，
      // 把 rev 与构建时间一起给它，用户报问题时能直接对上号（见 AGENTS.md §7.2）。
      // `version` / `buildKind` 供侧栏入口那枚小标签用：dev（源码检出）还是装好的包 + 具体版本。
      rev: PLUGIN_REV,
      version: PLUGIN_VERSION,
      buildKind: HOST_BUILD_KIND,
      builtAt: HOST_BUILD_STAMP,
      caseRoot: state.caseRoot,
      home: homedir(),
      formName: config.formName,
      parentSessionId: state.parentSessionId,
      workspace: workspaceView(state),
      auditRoot: auditRootView(ctx, state),
      active: { key: state.activeKey, childId: state.activeChildId, since: state.activeSince },
      ported: {
        // 只列包形态真的实现了的操作。曾经把 clipboard 列进 done，但操作表里没有它，
        // 于是客户端点「复制提示词」时拿到 404 —— 声明必须跟着实现走。
        done: ['ping', 'boot', 'workspace', 'workspace-auto', 'bind-session', 'trust',

          // 第 2 层：氚云表单定位 + 待审核列表 + 受白名单约束的 crwu 直通。
          'pending', 'crwu',
          // 第 1 层收尾：环境自检聚合（清单 / 二进制 / 氚云 / 钉钉 / OSS / iFinD / 工作空间）。
          'env',
          // 第 3 层：审核生命周期（顶层会话门禁 / 单条并发 / 带时间戳重启 / 状态跟不丢）。
          'audit-start', 'audit-stop', 'audit-status', 'audit-release',
          // 第 4 层：OSS 交付件（列举 / 按精确 key 读摘要 / 签名链接 / 重传 / 凭据保存）。
          'oss-index', 'oss-result', 'oss-link', 'oss-upload', 'oss-cred-save',
          // 第 4 层补：一份报告的全部相关文件（只列举、不下载）。
          'report-files',
          // 第 6 层：iFinD 凭据生命周期（插件 Host 自己保管 SK；不再是「读技能目录里的文件」）。
          'ifind-status', 'ifind-credential-save', 'ifind-credential-clear', 'ifind-probe',
          // 第 5 层：零碎但用户每天会点的那些。
          'open-path', 'clipboard', 'relogin', 'dws-login', 'session', 'oss-cred',
          // 协议 16：自助更新四个操作（安装目标由 Host 自己授权，调用方只能传空参数）。
          ...Object.keys(updateOperations)],
        // 24 个 legacy RPC 已全部搬完；这里保留空数组，是为了让「声明跟着实现走」的测试继续成立。
        todo: [],
      },
      }
    },
    // 换工作空间会改掉案例根目录（审核产物写到哪）：先落盘再作废快照。
    workspace: async (args) => {
      const result = await pickWorkspace({ ctx, config, state, world }, args)
      gate.invalidate()
      return result
    },

    'workspace-auto': async () => {
      const result = await autoWorkspace({ ctx, config, state, world })
      gate.invalidate()
      return result
    },

    trust: async (args) => {
      // `h3yun` 是旧客户端的字段名，继续接受（协议号已 +1，但没必要为一个布尔值让旧页面报错）。
      const granted = args.credentials === true || args.h3yun === true
      state.trustCredentials = granted
      // 授权改变了"读本机凭据"这条事实：作废旧快照，下一次操作重新自检。
      gate.invalidate()
      // **落盘**：一次授权长期有效，否则员工每次重启 profile 都要重新授权（用户 2026-09-22 口径）。
      const saved = await writeWorkbenchConfig(ctx, await world.home(), { trustCredentials: granted })
      return {
        ok: true,
        trust: { credentials: state.trustCredentials },
        ...(saved ? {} : { persistError: '授权没能写入磁盘，重启后需要重新授权' }),
      }
    },
    'bind-session': async (args) => {
      const id = text(args.sessionId)
      if (id === '') return { ok: false, error: '缺少 sessionId' }
      const info = sessionDelegation(ctx, id)
      if (config.requireTopLevelParent && info.found && info.subagent) {
        return {
          ok: false,
          subagent: true,
          depth: info.depth,
          parentSessionId: state.parentSessionId,
          error: `这个会话本身是子代理（delegationDepth ${info.depth || 1}），不能当审核父级：`
            + '审核只允许挂在顶层会话下，嵌套会引入状态跟丢的问题。请在顶层会话里打开工作台。',
          workspace: workspaceView(state),
        }
      }
      state.parentSessionId = id
      // 登记是用户按引导做的第一步；顺带把工作空间采用了，别让他再额外点一次自检。
      await adoptWorkspace({ ctx, config, state, world })
      return {
        ok: true,
        parentSessionId: id,
        subagent: false,
        depth: 0,
        workspace: workspaceView(state),
        sessionWorkspace: sessionWorkspaceInfo(ctx, state),
      }
    },
    env: async (args) => await loadEnv({
      refresh: args.refresh === true,
      ...(args.probeIfind === true ? { probeIfind: true } : {}),
    }),

    pending: async (args) => {
      // 平台探测要跑子进程，所以按实例缓存一次；提权执行必须带工作区，由 loadPending 统一解析。
      const platform = await world.platform()
      return await loadPending(
        { ctx, state, trusted: state.trustCredentials, platform, sessionRoot: () => world.workdir(), form: resolvers.form },
        args,
      )
    },

    crwu: async (args) => {
      // 直通入口，但白名单与提权规则与其它操作完全一致：argv[0] 必须是 crwu。
      const argv = Array.isArray(args.argv) ? args.argv.map((item) => text(item)) : []
      const platform = await world.platform()
      const workdir = text(args.workdir) || await world.workdir()
      return await runCrwu(ctx, argv, {
        ...(workdir === '' ? {} : { workdir }),
        timeoutMs: finiteNumber(args.timeoutMs) > 0 ? finiteNumber(args.timeoutMs) : 60_000,
        escalate: args.escalate === true,
        trusted: state.trustCredentials,
        platform,
      })
    },
    'audit-start': async (args) => {
      // Host 侧门禁：工作空间 + 授权 + 包内能力 + DSH Runtime + 必需 Tool + 氚云/钉钉，一次判完。
      // 界面上的门禁只负责体验，**这里才是真实性与绕过防护**（同源路由是公开契约）。
      const blocked = await guard('audit-start')
      if (blocked !== null) return blocked
      const result = await auditStart({ ctx, config, state, world, form: resolvers.form, python: resolvers.python }, args)
      // 起了审核就开始盯交付件：子会话跑完不会回调，只能轮询。
      if (result.ok) watch.start()
      return result
    },
    'audit-stop': async (args) => {
      // **不判门禁**：停止正在跑的审核是安全动作。环境刚坏了（AK 被撤、登录过期）时更要能停，
      // 判门禁会把人锁在外面，只能重启 profile。
      const result = await auditStop({ ctx, config, state, world, form: resolvers.form, python: resolvers.python }, args)
      // 手动停止后把看门狗也停掉（legacy 行为）：这条审核已经不活动了，
      // 定时器留着只是空转。真正已产出的交付件仍会被 audit-status 的每轮触发上传。
      if (result.ok) watch.stop()
      return result
    },
    'audit-status': async (args) => {
      const result = await auditStatus({
        ctx,
        config,
        state,
        world,
        form: resolvers.form,
        python: resolvers.python,
        autoUpload: async (record) => await maybeAutoUpload(await ossDeps(), record),
      }, args)
      // 状态轮询本来就每 10 秒一次，顺手踢一脚看门狗，不必再等满 30 秒。
      await watch.kick()
      return result
    },
    // 同上：释放占用锁是应急出口，不判门禁。
    'audit-release': async () => await auditRelease({ ctx, config, state, world, form: resolvers.form, python: resolvers.python }),
    'report-files': async (args) => await reportFiles(
      {
        ctx,
        oss: await ossDeps(),
        workspacePath: () => state.workspacePath || state.caseRoot,
        // 氚云附件是「这份报告该有哪些文件」的权威来源：与 `pending` 同一个表单 code、
        // 同一条授权纪律（没授权就不去读钥匙串）。
        formCode: () => state.formCode,
        trusted: state.trustCredentials === true,
        platform: await world.platform(),
        workdir: () => world.workdir(),
      },
      args,
    ),
    'oss-index': async (args) => await ossIndex(await ossDeps(), args),
    'oss-result': async (args) => await ossResult(await ossDeps(), args),
    'oss-link': async (args) => await ossLink(await ossDeps(), args),
    'oss-upload': async (args) => {
      const blocked = await guard('oss-upload')
      if (blocked !== null) return blocked
      return await ossUpload(await ossDeps(), args, state)
    },
    // 保存 AK 本身**不**判门禁（它就是修复交付能力的入口，判它会锁死自己）；
    // 但保存成功后要作废快照，因为 OSS 的连通性事实变了。
    'oss-cred-save': async (args) => {
      const result = await ossCredSave(await ossDeps(), args)
      gate.invalidate()
      return result
    },
    'open-path': async (args) => await openPath(
      { ctx, state, platform: await world.platform(), workdir: () => world.workdir() },
      args,
    ),
    clipboard: async (args) => await clipboard(
      { ctx, state, platform: await world.platform(), workdir: () => world.workdir() },
      args,
    ),
    // 登录成功 = 登录态事实变了：作废快照，下一次自检才能看到真结论。
    relogin: async () => {
      const result = await relogin({ ctx, state, platform: await world.platform(), workdir: () => world.workdir() })
      gate.invalidate()
      return result
    },
    'dws-login': async (args) => {
      const result = await dwsLogin(
        { ctx, state, platform: await world.platform(), workdir: () => world.workdir() },
        args,
      )
      gate.invalidate()
      return result
    },
    session: async () => await sessionStatus({ ctx, state, platform: await world.platform(), workdir: () => world.workdir() }),
    'oss-cred': async () => await ossCred(
      { ctx, state, platform: await world.platform(), workdir: () => world.workdir() },
      await world.home(),
    ),

    // ⑥ 外部数据（iFinD）的凭据生命周期。**不是模型可见的 Tool**：界面把 SK 交给 Host，
    // Host 校验 → 写盘（0600）→ 收紧权限 → 立刻真实探测；返回值只有状态与脱敏摘要。
    // 这三条也顺手作废能力快照：凭据变了，之前那份环境结论就不再可信。
    'ifind-status': async () => {
      const status = await ifindStatus(ifindDeps)
      const credential = await ifindCredentialViewFor(ifindDeps)
      // `ok` 放最后：`ifindStatus` 自己会回"凭据是否可用"，那个才是界面要的判据。
      return { ...status, credential, ok: true }
    },
    'ifind-credential-save': async (args) => {
      const result = await ifindCredentialSave(ifindDeps, args)
      gate.invalidate()
      return result as unknown as Record<string, unknown>
    },
    'ifind-credential-clear': async (args) => {
      const result = await ifindCredentialClear(ifindDeps, args)
      gate.invalidate()
      return result as unknown as Record<string, unknown>
    },
    'ifind-probe': async (args) => {
      const result = await ifindProbe(ifindDeps, args)
      return { ...result, ok: true }
    },
  }
}

/** iFinD 凭据的脱敏视图（只给界面看，**没有明文**）。 */
async function ifindCredentialViewFor(deps: IfindOpsDeps): Promise<Record<string, unknown>> {
  return await ifindCredentialView(deps.ctx, await deps.home()) as unknown as Record<string, unknown>
}
