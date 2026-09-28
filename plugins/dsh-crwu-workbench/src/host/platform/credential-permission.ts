import type { Context } from '@deepseek-ai/cordis'
import { text } from '../../shared/utils/value.ts'
import type { CredentialPermission } from '../../shared/types.ts'
import { privateFileCommand, privateFileMechanism, readFileModeCommand } from './shell.ts'
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
 * - `verified`：POSIX 上跑了收紧命令**并回读了模式位**，两者都确认是 `0600`（`posix-0600`）；
 * - `inherited`：该平台没有 POSIX 权限位这件事（Windows），不执行任何命令，
 *   如实说明权限由**当前账户 ACL** 负责 —— 不伪装成成功，也不谎报失败；
 * - `failed`：试图收紧但失败，或**回读对不上**（chmod 报错 / 沙箱拒绝 / 命令没跑起来 /
 *   文件系统静默忽略 chmod），带原因。
 *
 * `verified` 的含义是「回读确认」，所以**必须有第二步**（2026-09-28 复查修）：
 * 只信 `chmod` 的退出码就把「命令跑过了」说成「权限已验证」，而有些文件系统会静默忽略 chmod。
 * 回读命令由 `platform/shell.ts` 的 `readFileModeCommand()` 生成（GNU / BSD 的参数差异只在那里出现一次）。
 *
 * 本轮**不**调用 `icacls` 重写 ACL：企业域策略下的权限继承不是插件该擅自改的东西，
 * 真要「收紧 ACL」得另做设计与域环境测试（见设计说明 §3.5）。
 */

/** 期望的模式位（八进制字符串）。 */
const EXPECTED_MODE = '600'

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

  const shellOptions = {
    workdir: options.workdir,
    timeoutMs: 15_000,
    ...(options.escalate === true ? { escalate: true } : {}),
  }
  const run = await runShell(ctx, command, shellOptions)
  if (!run.ok) return { status: 'failed', mechanism, message: permissionFailureMessage(run) }

  // ② 回读：chmod 在某些文件系统上会静默无效，`verified` 必须由**观察到的模式位**支撑。
  const readCommand = readFileModeCommand(path, platform)
  if (readCommand === '') {
    return { status: 'failed', mechanism, message: '无法为该平台生成权限回读命令（平台事实自相矛盾）' }
  }
  const read = await runShell(ctx, readCommand, shellOptions)
  if (!read.ok) {
    return { status: 'failed', mechanism, message: `权限回读失败：${permissionFailureMessage(read)}` }
  }
  const mode = parseFileMode(read.stdout)
  if (mode === '') {
    return { status: 'failed', mechanism, message: `权限回读没有给出可解析的模式位：${text(read.stdout).trim().slice(0, 80)}` }
  }
  if (mode !== EXPECTED_MODE) {
    return {
      status: 'failed',
      mechanism,
      message: `权限收紧命令返回成功，但回读到的模式是 ${mode}（期望 ${EXPECTED_MODE}）—— 该文件系统可能忽略了 chmod`,
    }
  }
  return { status: 'verified', mechanism, message: '' }
}

/**
 * 从 `stat` 的输出里取出八进制模式位。
 *
 * GNU `stat -c %a` 给 `600`（也可能带前导 `0`）；BSD `stat -f %Lp` 给 `600`；
 * 都按「最后一个连续八进制串」取，避免把别的输出混进来。取不到返回空串。
 */
export function parseFileMode(raw: unknown): string {
  const match = /(?:^|\s)([0-7]{3,4})\s*$/.exec(text(raw).trim())
  if (match === null) return ''
  const digits = match[1] ?? ''
  // `0600` → `600`；四位里若带 setuid/setgid/sticky 位（如 `2600`）也要如实比较。
  return digits.length === 4 && digits.startsWith('0') ? digits.slice(1) : digits
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
