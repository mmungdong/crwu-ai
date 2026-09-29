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
import {
  grantLocalAccess,
  localAccessGranted,
  readLocalAccessConsent,
  revokeLocalAccess,
  syncLocalAccessConsent,
} from '../access/consent.ts'
import { PERMISSION_SCHEMA_VERSION } from '../../shared/access/types.ts'
import type { LocalAccessBroker } from '../access/broker.ts'
import type { LocalAccessSource } from '../access/operations.ts'
import { adoptWorkspace, autoWorkspace, pickWorkspace } from '../workspace/ops.ts'
import { sessionWorkspaceInfo } from '../workspace/resolve.ts'
import { auditRootView } from '../audit/root.ts'
import { openDiscussionMaterial } from '../audit/discussion-material.ts'
import type { DiscussionScopeRegistry } from '../audit/discussion-scope.ts'
import { maybeAutoUpload } from '../oss/auto.ts'
import { ossCredSave, ossIndex, ossLink, ossResult, ossUpload, type OssDeps } from '../oss/ops.ts'
import { reportFiles } from '../report/files.ts'
import { createUploadWatch } from '../oss/watch.ts'
import { clipboard, dwsLogin, openPath, ossCred, relogin, sessionStatus } from '../system/ops.ts'
import { dwsSelf, type WhoamiResult } from '../system/identity.ts'
import { runCrwu } from '../crwu/run.ts'
import { dwsLocalDoctor, dwsLocalPermissionRepair, hasAttributableDwsFailure } from '../dws/local.ts'
import { loadEnvironment } from '../environment/ops.ts'
import { createCapabilityGate, guardOperation } from '../environment/gate.ts'
import { ifindCredentialClear, ifindCredentialSave, ifindProbe, ifindStatus, type IfindOpsDeps } from '../tools/ifind-ops.ts'
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
  /**
   * **本地访问代理（协议 18）**：操作表这一层不再自己拼 `sandboxPolicy`，
   * 所有跨边界的调用都带着"操作 + 来源"交给它判。
   */
  access: LocalAccessBroker
  /** 讨论会话的受限材料范围（协议 23）：`discussion-material-open` 写它，业务 Tool 读它。 */
  discussionScopes: DiscussionScopeRegistry
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
  const ossDeps = async (source: LocalAccessSource = 'panel'): Promise<OssDeps> => ({
    ctx,
    manifest: state.manifest,
    // **来源必须逐次给**：面板 RPC 是 `panel`，审核 Tool 与自动上传是 `audit-tool`。
    // 少了它就等于让"谁发起的"这件事由默认值决定 —— 那正是本次改造要消灭的东西。
    source,
    platform: await world.platform(),
    home: await world.home(),
    workdir: () => world.workdir(),
    access: resolvers.access,
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
    const me = await dwsSelf({ ctx, access: resolvers.access, workdir: () => world.workdir(), platform: await world.platform() })
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
  const loadEnv = async (options: { refresh: boolean }): Promise<Record<string, unknown>> => {
    const [platform, home] = [await world.platform(), await world.home()]
    return await loadEnvironment(
      // 「我是谁」跟着自检一起拿（见 identity 的注释）：自检本来就要问一次钉钉登录态。
      {
        ctx, config, state, home, platform,
        access: resolvers.access,
        sessionRoot: () => world.workdir(),
        identity,
        // DSH 自带 Python 由实例级解析器给（成功缓存、失败可显式刷新）。
        // **带上面板绑定的父会话 agent**：`load_workspace_dependencies` 需要 agent 作用域，
        // 而自检本身没有会话上下文 —— 不带 agent 调它只会拿到工具报错，运行时永远解析不出来
        // （2026-09-29 员工 Windows 实测：会话里调同一个工具返回完整载荷）。
        // 没绑定会话时退回不带 agent 的调用：那种情况环境页只报「待复核」，不判缺失。
        // 必需 Tool 的可见性：默认按根 Agent 查一次；宿主可注入替身用于测试收窄场景。
        ...(extra.auditTools === undefined
          ? { auditTools: async () => ({ missing: missingAuditTools(ctx, undefined), checked: true }) }
          : { auditTools: extra.auditTools }),
      },
      {
        ...(options.refresh ? { refresh: true } : {}),
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
  const ifindDeps: IfindOpsDeps = {
    ctx,
    access: resolvers.access,
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
      const home = await world.home()
      await ensureRegistry({ ctx, home, state, access: resolvers.access })
      await adoptWorkspace({ ctx, config, state, world, access: resolvers.access })
      // 授权收据：`boot` 是面板挂载后第一个被调用的操作，界面靠它决定「先显示授权卡」
      // 还是「正常进环境页」。在这里读一次，就把「第一次打开」的判据固定在最前面。
      const localAccess = await syncLocalAccessConsent({ ctx, home, state, access: resolvers.access })
      return {
      ok: true,
      protocol: WORKBENCH_PROTOCOL,
      // 权限说明版本：客户端启动时与自己的 schema 比对，不一致就停在本机操作之前。
      permissionSchemaVersion: PERMISSION_SCHEMA_VERSION,
      localAccess,
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
          'local-access-grant', 'local-access-revoke', 'access-diagnostics',

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
          // 协议 23：报告讨论会话的受限材料登记（新建 / 恢复会话后各登记一次）。
          'discussion-material-open',
          // 第 6 层：iFinD 凭据生命周期（插件 Host 自己保管 SK；不再是「读技能目录里的文件」）。
          'ifind-status', 'ifind-credential-save', 'ifind-credential-clear', 'ifind-probe',
          // 第 5 层：零碎但用户每天会点的那些。
          'open-path', 'clipboard', 'relogin', 'dws-login', 'session', 'oss-cred',
          // 协议 18 · 子项目 D：DWS 本机目录的只读体检与最小权限修复。
          'dws-local-doctor', 'dws-local-permission-repair',
          // 协议 16：自助更新四个操作（安装目标由 Host 自己授权，调用方只能传空参数）。
          ...Object.keys(updateOperations)],
        // 24 个 legacy RPC 已全部搬完；这里保留空数组，是为了让「声明跟着实现走」的测试继续成立。
        todo: [],
      },
      }
    },
    // 换工作空间会改掉案例根目录（审核产物写到哪）：先落盘再作废快照。
    workspace: async (args) => {
      const result = await pickWorkspace({ ctx, config, state, world, access: resolvers.access }, args)
      gate.invalidate()
      return result
    },

    'workspace-auto': async () => {
      const result = await autoWorkspace({ ctx, config, state, world, access: resolvers.access })
      gate.invalidate()
      return result
    },

    /**
     * **旧版授权入口，保留一代、但不再授予任何权限**（协议 18）。
     *
     * 旧客户端（协议 ≤17）会带着 `{ credentials: true }` 调它。那个布尔值表达的是**旧范围**
     * （只覆盖「读本机凭据」），而协议 18 的范围扩到了氚云凭据存储 / DWS 目录 / OSS 配置 /
     * iFinD 凭据 / 系统集成五项。若继续按旧请求授予，就是**未经员工同意地扩权** ——
     * 所以这里一律回协议不匹配的失败，让界面去提示「完全退出并重新打开 DeepSeek Harness」。
     *
     * 保留这个 handler（而不是直接删掉）是为了让旧客户端拿到**一句能读懂的话**，而不是 404
     * 「未知 op」。
     */
    trust: async () => ({
      ok: false,
      error: `客户端与宿主的权限说明版本不一致：本机访问授权已改为版本化收据（协议 ${String(WORKBENCH_PROTOCOL)}），`
        + '请完全退出并重新打开 DeepSeek Harness 后在「账号连接」里按新的范围允许一次。',
      protocolMismatch: true,
      consent: await readLocalAccessConsent({ ctx, home: await world.home(), access: resolvers.access }),
    }),

    /**
     * 允许工作台访问本机账号和配置（协议 18）。
     *
     * **先落盘、后放行**：写盘失败就是 `ok:false` 且不获得任何权限（见 `access/consent.ts`）。
     * 提交的能力集合必须**逐字**等于当前版本的规范清单 —— 被改过的客户端无法提交一个
     * 与界面不同的范围。
     */
    'local-access-grant': async (args) => {
      const home = await world.home()
      // `state` 传进去：授权/撤销的状态迁移由 `access/consent.ts` **自己**负责。
      // 这里**不再**无条件采用 `result.consent` —— 写盘失败时那份视图可能来自磁盘上的旧授权，
      // 照抄进活状态就等于一次失败的「重新允许」把权限重新打开（2026-09-29 复查的 P1）。
      const result = await grantLocalAccess({ ctx, home, state, access: resolvers.access }, args)
      // 授权改变了「能不能读本机凭据」这条事实：作废旧快照，下一次操作重新自检。
      gate.invalidate()
      return { ok: result.ok, error: result.error, consent: result.consent, permissionSchemaVersion: PERMISSION_SCHEMA_VERSION }
    },

    /** 撤销本机访问：**内存先关**，写盘失败也要 fail closed（见 `access/consent.ts`）。 */
    'local-access-revoke': async () => {
      const home = await world.home()
      // `state` 传进去：撤销要在**任何 await 之前**把内存切到关闭态（见 consent.ts）。
      // 撤销同理：状态由 `access/consent.ts` 负责（它在任何 `await` 之前就把内存切到关闭态）。
      const result = await revokeLocalAccess({ ctx, home, state, access: resolvers.access })
      gate.invalidate()
      return { ok: result.ok, error: result.error, consent: result.consent, permissionSchemaVersion: PERMISSION_SCHEMA_VERSION }
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
      await adoptWorkspace({ ctx, config, state, world, access: resolvers.access })
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
    }),

    pending: async (args) => {
      // 平台探测要跑子进程，所以按实例缓存一次；提权执行必须带工作区，由 loadPending 统一解析。
      const platform = await world.platform()
      return await loadPending(
        { ctx, state, access: resolvers.access, platform, sessionRoot: () => world.workdir(), form: resolvers.form },
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
        // 协议 18：**不再接受 `escalate`**（那是调用方提交的提权开关）。这条直通入口现在只能
        // 执行**能映射到登记操作**的子命令，提权与否由操作身份决定（`crwuOperationOf`）。
        access: resolvers.access,
        source: 'panel',
        platform,
      })
    },
    'audit-start': async (args) => {
      // Host 侧门禁：工作空间 + 授权 + 包内能力 + DSH Runtime + 必需 Tool + 氚云/钉钉，一次判完。
      // 界面上的门禁只负责体验，**这里才是真实性与绕过防护**（同源路由是公开契约）。
      const blocked = await guard('audit-start')
      if (blocked !== null) return blocked
      const result = await auditStart({
        ctx, config, state, world, access: resolvers.access, form: resolvers.form, python: resolvers.python,
        // 与**界面门禁同一份**能力快照（`environment/gate.ts`）：创建子代理之前再确认一次
        // 环境仍然就绪。撤销授权 / 换工作空间都会 `invalidate()`，所以这里看到的是新事实。
        readiness: async () => {
          const blocked = await guard('audit-start')
          return blocked === null
            ? { ok: true, error: '' }
            : { ok: false, error: text(blocked.error) || '环境未就绪' }
        },
      }, args)
      // 起了审核就开始盯交付件：子会话跑完不会回调，只能轮询。
      if (result.ok) watch.start()
      return result
    },
    'audit-stop': async (args) => {
      // **不判门禁**：停止正在跑的审核是安全动作。环境刚坏了（AK 被撤、登录过期）时更要能停，
      // 判门禁会把人锁在外面，只能重启 profile。
      const result = await auditStop({ ctx, config, state, world, access: resolvers.access, form: resolvers.form, python: resolvers.python }, args)
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
        access: resolvers.access,
        form: resolvers.form,
        python: resolvers.python,
        autoUpload: async (record) => await maybeAutoUpload(await ossDeps('audit-tool'), record),
      }, args)
      // 状态轮询本来就每 10 秒一次，顺手踢一脚看门狗，不必再等满 30 秒。
      await watch.kick()
      return result
    },
    // 同上：释放占用锁是应急出口，不判门禁。
    'audit-release': async () => await auditRelease({ ctx, config, state, world, access: resolvers.access, form: resolvers.form, python: resolvers.python }),
    /**
     * **报告讨论会话的受限材料登记**（协议 23）。
     *
     * 客户端在 `ensureDiscussion`（新建或恢复）之后、发 kickoff 之前调。客户端只能提交
     * `sessionId` / `seqNo` / `objectId`：案例目录由 Host 算、白名单由 Host 自己重新取一次数
     * （见 `audit/discussion-material.ts` 的注释）。失败时**不登记**，讨论会话保持原样。
     */
    'discussion-material-open': async (args) => await openDiscussionMaterial({
      ctx, state, world, access: resolvers.access, form: resolvers.form,
      scopes: resolvers.discussionScopes,
    }, args),

    'report-files': async (args) => await reportFiles(
      {
        ctx,
        oss: await ossDeps(),
        workspacePath: () => state.workspacePath || state.caseRoot,
        // 氚云附件是「这份报告该有哪些文件」的权威来源：与 `pending` 同一个表单 code、
        // 同一条授权纪律（没授权就不去读钥匙串）。
        formCode: () => state.formCode,
        access: resolvers.access,
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
      { ctx, state, access: resolvers.access, platform: await world.platform(), workdir: () => world.workdir() },
      args,
    ),
    clipboard: async (args) => await clipboard(
      { ctx, state, access: resolvers.access, platform: await world.platform(), workdir: () => world.workdir() },
      args,
    ),
    // 登录成功 = 登录态事实变了：作废快照，下一次自检才能看到真结论。
    relogin: async () => {
      const result = await relogin({ ctx, state, access: resolvers.access, platform: await world.platform(), workdir: () => world.workdir() }, await world.home())
      gate.invalidate()
      return result
    },
    /**
     * **DWS 本机目录只读体检**（协议 18 · D2）。
     *
     * 不接受任何路径：目录由 Host 从 world facts 推导（`<home>/.dws`）。
     * 只在"已经出过一次本机访问失败、且事实排除了沙箱拒绝"之后才有意义
     * （`classification` 字段就是给调用方判断这一点的）。
     */
    'dws-local-doctor': async () => await dwsLocalDoctor({
      ctx,
      access: resolvers.access,
      home: await world.home(),
      platform: await world.platform(),
      workdir: await world.workdir(),
      source: 'panel',
    }),

    /**
     * **最小权限修复**（协议 18 · D3）：面板上二次确认之后才调用。
     *
     * 参数只接受 `{ confirm: true }`；路径、机制、权限位全部由 Host 决定。
     * 界面只在结论是"本机文件权限问题"时才渲染那个按钮 —— 但**判据在服务端**：
     * 客户端即使伪造请求，这里同样会拒（沙箱拒绝 / 降级 / 钥匙串 / 认证失败 / 锁 / 所有者不对）。
     */
    'dws-local-permission-repair': async (args) => await dwsLocalPermissionRepair({
      ctx,
      access: resolvers.access,
      home: await world.home(),
      platform: await world.platform(),
      workdir: await world.workdir(),
      source: 'panel',
    }, args),

    'dws-login': async (args) => {
      const result = await dwsLogin(
        { ctx, state, access: resolvers.access, platform: await world.platform(), workdir: () => world.workdir() },
        args,
        await world.home(),
      )
      gate.invalidate()
      return result
    },

    session: async () => await sessionStatus({ ctx, state, access: resolvers.access, platform: await world.platform(), workdir: () => world.workdir() }),

    // ⚠️ 2026-09-30：**没有** `browser-session-bind` / `dws-login-start` / `dws-login-status`。
    // DSH 不再提供氚云内置浏览器扫码登录（协议 20）与钉钉设备码 / 两阶段登录（协议 21）：
    // 账号连接只读取、检查已有凭据，登录由本机 CLI 自己拉起系统浏览器完成（`relogin` / `dws-login`）。
    'oss-cred': async () => await ossCred(
      { ctx, state, access: resolvers.access, platform: await world.platform(), workdir: () => world.workdir() },
      await world.home(),
    ),

    /**
     * 最近的本机访问诊断（协议 18 · B3）。
     *
     * **只读、零副作用、脱敏**：给「开发者诊断」看"刚才那次为什么失败"。
     * 记的是操作名 / 来源 / 请求·解析·实际沙箱模式 / 是否被沙箱拒绝 / 归因类别与版本，
     * 不含凭据、签名 URL、文件正文与原始 argv（见 `host/access/diagnostics.ts`）。
     * 故意**不**落盘：落盘会引出"诊断文件在哪、怎么轮转、会不会带上凭据"一整套新问题，
     * 而它要回答的问题在同一个进程生命周期里就有答案。
     */
    'access-diagnostics': async () => ({
      ok: true,
      entries: resolvers.access.diagnostics(),
      consent: resolvers.access.consent(),
      // 界面据此决定「检查本机目录」能不能点 —— **由 Host 给事实，客户端不自己推断**
      //（与体检的前置门禁同一个判据，见 `hasAttributableDwsFailure`）。
      dwsDiagnosable: hasAttributableDwsFailure({ access: resolvers.access, platform: await world.platform(), ctx, home: await world.home(), workdir: await world.workdir() }),
    }),

    // ⑥ 外部数据（iFinD）的凭据生命周期。**不是模型可见的 Tool**：界面把 SK 交给 Host，
    // Host 校验 → 写盘（0600）→ 收紧权限 → 立刻真实探测并保存脱敏结论；返回值只有状态与脱敏摘要。
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
  const home = await deps.home()
  return await ifindCredentialView(deps.ctx, home, {
    access: deps.access, source: 'panel', workdir: home,
  }) as unknown as Record<string, unknown>
}
