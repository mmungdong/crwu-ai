import { homedir } from 'node:os'
import { HOST_BUILD_STAMP } from '../build-info.ts'
import { PLUGIN_REV } from '../consts.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { WorkbenchConfig } from '../config/config.ts'
import { workspaceView } from '../state/store.ts'
import type { WorkbenchState } from '../state/types.ts'
import { finiteNumber, text } from '../../shared/utils/value.ts'
import { auditRelease, auditStart, auditStatus, auditStop } from '../audit/ops.ts'
import { DEFAULT_MANIFEST } from '../environment/manifest-default.ts'
import { DEFAULT_INSTALL_DOC, buildInstallPromptText } from '../environment/install-prompt.ts'
import { WORKBENCH_PROTOCOL } from '../../shared/consts.ts'
import { ensureRegistry } from '../state/registry.ts'
import { adoptWorkspace, autoWorkspace, pickWorkspace } from '../workspace/ops.ts'
import { sessionWorkspaceInfo } from '../workspace/resolve.ts'
import { auditRootView } from '../audit/root.ts'
import { maybeAutoUpload } from '../oss/auto.ts'
import { ossCredSave, ossIndex, ossLink, ossResult, ossUpload, type OssDeps } from '../oss/ops.ts'
import { createUploadWatch } from '../oss/watch.ts'
import { clipboard, dwsLogin, openPath, ossCred, relogin, sessionStatus } from '../system/ops.ts'
import { runCrwu } from '../crwu/run.ts'
import { loadEnvironment } from '../environment/ops.ts'
import { loadPending } from '../h3yun/pending.ts'
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

/** 创建包形态当前已经支持的操作表。 */
export function createCoreOperations(
  ctx: Context,
  config: WorkbenchConfig,
  state: WorkbenchState,
  world: WorldFacts,
): OperationMap {
  /**
   * OSS 操作的依赖。
   *
   * 必须每次调用时重新构造：清单是环境自检拉来的，平台是探测出来的，
   * 都可能在这之后才就绪。构造时抓一次快照会让第一次调用永远拿到内置默认清单。
   */
  const ossDeps = async (): Promise<OssDeps> => ({
    ctx,
    manifest: state.manifest ?? DEFAULT_MANIFEST,
    platform: await world.platform(),
    home: await world.home(),
    workdir: () => world.workdir(),
  })
  // 上传看门狗：审核跑完不会回调，只能轮询「有结果就传」。句柄挂在插件实例上。
  const watch = createUploadWatch(ctx, state, ossDeps)
  // 定时器必须随插件生命周期释放；这里只登记释放动作，启动由 audit-start 触发。
  ctx.effect(() => watch.stop, 'crwu-workbench: upload watch')
  return {
    // `rev` 只反映包版本，同一轮开发里两次 build 完全相同；`builtAt` 是这份产物的写入时间，
    // 用来回答「重启之后生效的是不是我刚 build 的那份」（见 AGENTS.md §7 的本地开发循环）。
    ping: () => ({
      ok: true, rev: PLUGIN_REV, at: new Date().toISOString(), builtAt: HOST_BUILD_STAMP,
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
      rev: PLUGIN_REV,
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
          'install-prompt',
          // 第 2 层：氚云表单定位 + 待审核列表 + 受白名单约束的 crwu 直通。
          'pending', 'crwu',
          // 第 1 层收尾：环境自检聚合（清单 / 二进制 / 氚云 / 钉钉 / OSS / iFinD / 工作空间）。
          'env',
          // 第 3 层：审核生命周期（顶层会话门禁 / 单条并发 / 带时间戳重启 / 状态跟不丢）。
          'audit-start', 'audit-stop', 'audit-status', 'audit-release',
          // 第 4 层：OSS 交付件（列举 / 按精确 key 读摘要 / 签名链接 / 重传 / 凭据保存）。
          'oss-index', 'oss-result', 'oss-link', 'oss-upload', 'oss-cred-save',
          // 第 5 层：零碎但用户每天会点的那些。
          'open-path', 'clipboard', 'relogin', 'dws-login', 'session', 'oss-cred'],
        // 24 个 legacy RPC 已全部搬完；这里保留空数组，是为了让「声明跟着实现走」的测试继续成立。
        todo: [],
      },
      }
    },
    workspace: async (args) => await pickWorkspace({ ctx, config, state, world }, args),

    'workspace-auto': async () => await autoWorkspace({ ctx, config, state, world }),

    trust: (args) => {
      state.trustH3yun = args.h3yun === true
      return { ok: true, trust: { h3yun: state.trustH3yun } }
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
    'install-prompt': (args) => {
      // 清单优先：它是从组织自己的 OSS 现拉的，比部署配置更新；Config 是兜底覆盖。
      // 与 `env` 返回 installDocUrl 的口径保持一致（同一个值有两个来源时不能各写一套）。
      const url = (state.manifest?.installDocUrl ?? '') || config.installDocUrl || DEFAULT_INSTALL_DOC
      const workspace = text(args.workspace) || state.workspacePath || state.caseRoot
      return { ok: true, url, prompt: buildInstallPromptText(url, workspace) }
    },

    env: async (args) => {
      // 自检要探测平台、主目录、工作空间；三者都按实例缓存，避免每次刷新都跑一串子进程。
      const [platform, home] = [await world.platform(), await world.home()]
      return await loadEnvironment(
        { ctx, config, state, home, platform, sessionRoot: () => world.workdir() },
        args,
      )
    },

    pending: async (args) => {
      // 平台探测要跑子进程，所以按实例缓存一次；提权执行必须带工作区，由 loadPending 统一解析。
      const platform = await world.platform()
      return await loadPending(
        { ctx, config, state, trusted: state.trustH3yun, platform, sessionRoot: () => world.workdir() },
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
        trusted: state.trustH3yun,
        platform,
      })
    },
    'audit-start': async (args) => {
      const result = await auditStart({ ctx, config, state, world }, args)
      // 起了审核就开始盯交付件：子会话跑完不会回调，只能轮询。
      if (result.ok) watch.start()
      return result
    },
    'audit-stop': async (args) => {
      const result = await auditStop({ ctx, config, state, world }, args)
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
        autoUpload: async (record) => await maybeAutoUpload(await ossDeps(), record),
      }, args)
      // 状态轮询本来就每 10 秒一次，顺手踢一脚看门狗，不必再等满 30 秒。
      await watch.kick()
      return result
    },
    'audit-release': async () => await auditRelease({ ctx, config, state, world }),
    'oss-index': async () => await ossIndex(await ossDeps()),
    'oss-result': async (args) => await ossResult(await ossDeps(), args),
    'oss-link': async (args) => await ossLink(await ossDeps(), args),
    'oss-upload': async (args) => await ossUpload(await ossDeps(), args, state),
    'oss-cred-save': async (args) => await ossCredSave(await ossDeps(), args),
    'open-path': async (args) => await openPath(
      { ctx, state, platform: await world.platform(), workdir: () => world.workdir() },
      args,
    ),
    clipboard: async (args) => await clipboard(
      { ctx, state, platform: await world.platform(), workdir: () => world.workdir() },
      args,
    ),
    relogin: async () => await relogin({ ctx, state, platform: await world.platform(), workdir: () => world.workdir() }),
    'dws-login': async (args) => await dwsLogin(
      { ctx, state, platform: await world.platform(), workdir: () => world.workdir() },
      args,
    ),
    session: async () => await sessionStatus({ ctx, state, platform: await world.platform(), workdir: () => world.workdir() }),
    'oss-cred': async () => await ossCred(
      { ctx, state, platform: await world.platform(), workdir: () => world.workdir() },
      await world.home(),
    ),
  }
}
