import type { OperationMap } from './types.ts'
import type { OperationHost } from './common.ts'
import { finiteNumber, text } from '../../shared/utils/value.ts'
import { auditRelease, auditStart, auditStatus, auditStop } from '../domains/report-audit/ops.ts'
import { openDiscussionMaterial } from '../domains/report-audit/discussion-material.ts'
import { maybeAutoUpload } from '../integrations/oss/auto.ts'
import { ossCredSave, ossIndex, ossLink, ossResult, ossUpload } from '../integrations/oss/ops.ts'
import { reportFiles } from '../domains/report-audit/material/files.ts'
import { runCrwu } from '../integrations/crwu/run.ts'
import { loadPending } from '../integrations/h3yun/pending.ts'

/**
 * **报告审核**这一族的操作（协议 32 · Task 3）：待审核列表、审核生命周期、报告讨论材料、
 * 交付件（OSS 列举 / 摘要 / 签名链接 / 重传 / 凭据）与受白名单约束的 `crwu` 直通。
 *
 * 门禁的用法在这里最能说明问题：
 * · `audit-start` / `oss-upload` **判**门禁 —— 环境不成立时它们必然做不成事；
 * · `audit-stop` / `audit-release` **不判** —— 停止与释放占用是应急出口，
 *   环境刚坏了（AK 被撤、登录过期）时更要能用，判门禁等于把人锁在外面只能重启 profile。
 */
export function reportAuditOperations(host: OperationHost): OperationMap {
  const { ctx, config, state, world, resolvers, ossDeps, ossBatch, watch, guard, gate } = host
  return {
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
    'oss-index': async (args, context) => 'seqNos' in args
      ? await ossBatch.run(args, context?.signal)
      : await ossIndex(await ossDeps(), args),
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
  }
}
