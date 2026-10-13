import type { OperationMap } from './types.ts'
import type { OperationHost } from './common.ts'
import type { Context } from '@deepseek-ai/cordis'
import { finiteNumber, text } from '../../shared/utils/value.ts'
import type { IfindOpsDeps } from '../tools/integrations/ifind-ops.ts'
import { ifindCredentialView } from '../integrations/ifind/store.ts'
import { HOST_BUILD_KIND, HOST_BUILD_STAMP } from '../build-info.ts'
import { PLUGIN_REV, PLUGIN_VERSION } from '../consts.ts'
import { workspaceView } from '../core/state/store.ts'
import { WORKBENCH_PROTOCOL } from '../../shared/consts.ts'
import { grantLocalAccess, readLocalAccessConsent, revokeLocalAccess } from '../core/access/consent.ts'
import { PERMISSION_SCHEMA_VERSION } from '../../shared/access/types.ts'
import { adoptWorkspace, autoWorkspace, pickWorkspace } from '../core/workspace/ops.ts'
import { sessionWorkspaceInfo } from '../core/workspace/resolve.ts'
import { clipboard, dwsLogin, openPath, ossCred, relogin, sessionStatus } from '../core/system/ops.ts'
import { dwsLocalDoctor, dwsLocalPermissionRepair, hasAttributableDwsFailure } from '../integrations/dws/local.ts'
import { ifindCredentialClear, ifindCredentialSave, ifindProbe, ifindStatus } from '../tools/integrations/ifind-ops.ts'

/**
 * **环境 / 工作空间 / 账号连接 / 系统集成**这一族的操作（协议 32 · Task 3）。
 *
 * 归到这里的判据只有一条：**它回答的是"这台机器现在是什么样"**，而不是某个业务的进展。
 * 所以环境自检、工作空间选择、本机访问授权、DWS 目录体检与修复、账号登录、OSS 凭据、
 * iFinD 凭据生命周期都在这一个文件里 —— 它们共享同一个能力门禁快照（`host.gate`），
 * 任何一条改变了环境事实之后都要 `invalidate()`。
 *
 * ⚠️ 门禁只加在**敏感**操作上（`audit-start` / `oss-upload`）：修复类操作（授权、保存凭据、
 * 登录）不判门禁 —— 判它们会把用户锁在"修不了"的状态里，而那正是它们存在的意义。
 */
export function environmentOperations(host: OperationHost): OperationMap {
  const { ctx, config, state, world, resolvers, gate, loadEnv, ifindDeps } = host
  return {
    // `rev` 只反映包版本，同一轮开发里两次 build 完全相同；`builtAt` 是这份产物的写入时间，
    // 用来回答「重启之后生效的是不是我刚 build 的那份」（见 AGENTS.md §7 的本地开发循环）。
    ping: () => ({
      ok: true, rev: PLUGIN_REV, version: PLUGIN_VERSION, buildKind: HOST_BUILD_KIND,
      at: new Date().toISOString(), builtAt: HOST_BUILD_STAMP,
      // 客户端拿它判断「跑着的宿主是不是同一代」——见 shared/consts.ts 的 WORKBENCH_PROTOCOL。
      protocol: WORKBENCH_PROTOCOL,
    }),
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
     * 不含凭据、签名 URL、文件正文与原始 argv（见 `host/core/access/diagnostics.ts`）。
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

async function ifindCredentialViewFor(deps: IfindOpsDeps): Promise<Record<string, unknown>> {
  const home = await deps.home()
  return await ifindCredentialView(deps.ctx, home, {
    access: deps.access, source: 'panel', workdir: home,
  }) as unknown as Record<string, unknown>
}
