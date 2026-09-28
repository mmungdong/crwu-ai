import type { Context } from '@deepseek-ai/cordis'
import { text } from '../../shared/utils/value.ts'
import type { CredentialPermission } from '../../shared/types.ts'
import { privateFileCommand, privateFileMechanism } from './shell.ts'
import { runShell, type ShellResult } from '../shell/run.ts'

/**
 * 凭据文件的**权限收紧与如实报告**（协议 17）。
 *
 * ## 为什么单独成一个模块
 *
 * iFinD API-Key 与 OSS AccessKey 落在同一个形态的文件里（用户配置目录下的私有文件），
 * 收紧方式与「失败怎么说话」必须**只有一份判据**。旧形态两处各写一遍
 * `if (!isWindowsPlatform(...)) { chmod } else { chmodOk = true }` —— 于是 Windows 上
 * 两处都报「成功」，而实际什么都没做。
 *
 * ## 三种结局（见 `shared/types.ts` 的 `CredentialPermission`）
 *
 * - `verified`：POSIX 上真的跑了收紧命令**且退出码为 0**（`posix-0600`）；
 * - `inherited`：该平台没有 POSIX 权限位这件事（Windows），不执行任何命令，
 *   如实说明权限由**当前账户 ACL** 负责 —— 不伪装成成功，也不谎报失败；
 * - `failed`：试图收紧但失败（chmod 报错 / 沙箱拒绝 / 命令根本没跑起来），带原因。
 *
 * 本轮**不**调用 `icacls` 重写 ACL：企业域策略下的权限继承不是插件该擅自改的东西，
 * 真要「收紧 ACL」得另做设计与域环境测试（见设计说明 §3.5）。
 */
export async function enforceCredentialPermission(
  ctx: Context,
  path: string,
  platform: string,
  options: { workdir: string; escalate?: boolean },
): Promise<CredentialPermission> {
  const mechanism = privateFileMechanism(platform)
  if (mechanism === 'windows-acl') {
    return {
      status: 'inherited',
      mechanism,
      message: '使用当前 Windows 账户 ACL；POSIX 0600 不适用',
    }
  }

  const command = privateFileCommand(path, platform)
  if (command === '') {
    // 两个判据都来自同一个适配器，正常不可能走到这里；走到就说明平台事实自相矛盾。
    return { status: 'failed', mechanism, message: `无法为该平台生成权限收紧命令（platform=${platform || '未知'}）` }
  }

  const run = await runShell(ctx, command, {
    workdir: options.workdir,
    timeoutMs: 15_000,
    ...(options.escalate === true ? { escalate: true } : {}),
  })
  if (run.ok) return { status: 'verified', mechanism, message: '' }
  return { status: 'failed', mechanism, message: permissionFailureMessage(run) }
}

/** 失败原因：命令没跑起来（沙箱/审批）与跑完报错要能分辨。 */
function permissionFailureMessage(run: ShellResult): string {
  const raw = text(run.stderr) || text(run.error) || text(run.stdout)
  return (raw.trim() || '权限收紧命令没有成功').slice(0, 200)
}

/** Host 凭据服务（`credentials`）托管时的权限结论：不由我们管，也不宣称已验证。 */
export function hostStorePermission(): CredentialPermission {
  return {
    status: 'inherited',
    mechanism: 'host-store',
    message: '凭据由 DSH 凭据服务保管，文件权限不适用',
  }
}
