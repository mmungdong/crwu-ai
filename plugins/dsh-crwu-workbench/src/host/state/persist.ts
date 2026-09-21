import type { Context } from '@deepseek-ai/cordis'
import { text } from '../../shared/utils/value.ts'
import { fileSystem, resolveTarget } from '../fs/paths.ts'

/**
 * 工作台自己的持久化文件：`~/.dsh/crwu-workbench.json`。
 *
 * 为什么落在 `~/.dsh` 而不是案例目录：审核记录与占用锁必须跨「插件重装」保留 ——
 * 动态形态每次 `cordis_define` 都是新 Package、进程内状态全丢；包形态重启 profile 也一样。
 * 丢了占用锁，同一条报告就能被起第二条子会话，两条会往同一个案例目录对写。
 *
 * 读写都**不抛错**：这个文件坏了不该让整个面板打不开。写失败由调用方决定怎么提示（返回 false）。
 */

export function workbenchConfigPath(home: string): string {
  if (home === '') return '~/.dsh/crwu-workbench.json'
  return `${home.replace(/[\\/]+$/, '')}/.dsh/crwu-workbench.json`
}

/**
 * 读盘结果。
 *
 * 为什么要区分「读成功但文件不存在」和「读失败」：写盘是读-改-写，把**读失败**当成空配置，
 * 就等于用只有本次补丁的对象去覆盖别人的字段 —— 实测踩过：一次 transient 的 stat 失败会让
 * `workspacePath` 被静默抹掉，用户下次进来发现工作空间「自己变了」。
 */
export interface ConfigRead {
  /** false = 这次读**没有**成功（fs 不可用 / stat 或读抛出），调用方不得据此覆盖写。 */
  ok: boolean
  value: Record<string, unknown>
}

export async function readWorkbenchConfigResult(ctx: Context, home: string): Promise<ConfigRead> {
  const fs = fileSystem(ctx)
  if (fs === undefined) return { ok: false, value: {} }
  try {
    const target = await resolveTarget(ctx, workbenchConfigPath(home))
    const info = await fs.stat(target)
    // 文件不存在 = 空配置（可以写）；这与「读失败」是两件事。
    if (info?.type !== 'file') return { ok: true, value: {} }
    const raw = await fs.readText(target)
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      // 内容坏掉当作空配置：此时本来就没有任何字段可保全，允许写回一个可用文件，
      // 否则插件会永远卡在「读不了 → 不让写」的死循环里。
      void error
      return { ok: true, value: {} }
    }
    return { ok: true, value: parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : {} }
  } catch (error) {
    void error
    return { ok: false, value: {} }
  }
}

/** 读取配置；文件不存在、不是 JSON、fs 不可用都返回空对象。 */
export async function readWorkbenchConfig(ctx: Context, home: string): Promise<Record<string, unknown>> {
  return (await readWorkbenchConfigResult(ctx, home)).value
}

/**
 * 合并写入配置。
 *
 * 读-改-写而不是整体覆盖：面板的多个操作（选工作空间、落盘审核记录、释放占用）都会写这个文件，
 * 整体覆盖会让后写的把先写的抹掉。
 */
export async function writeWorkbenchConfig(
  ctx: Context,
  home: string,
  patch: Record<string, unknown>,
): Promise<boolean> {
  const fs = fileSystem(ctx)
  if (fs === undefined) return false
  const current = await readWorkbenchConfigResult(ctx, home)
  // 读失败就**不写**：这一次补丁会把没读到的字段一起抹掉，代价比晚一次写入大得多。
  if (!current.ok) return false
  const next = { ...current.value, ...patch }
  try {
    const target = await resolveTarget(ctx, workbenchConfigPath(home))
    // 这份文件是插件**自己的**状态（授权、工作空间选择、占用锁），不是用户数据，也是插件唯一的
    // 持久化出口。员工默认的受限沙箱（workspace-write）下写 `~/.dsh/` 会被拦 —— 表现就是
    // 「点了同意但授权存不住，重启又要重新授权」（2026-09-22 实测）。fs 的 writeText 支持
    // 逐次声明策略，所以这里像凭据命令一样显式声明；读不需要（stat/readText 没有该参数）。
    await fs.writeText(target, `${JSON.stringify(next, null, 2)}\n`, undefined, undefined, {
      mode: 'danger-full-access',
      workspaceRoot: home,
    })
    return true
  } catch (error) {
    // 不吞：写不进去的原因必须能从日志里看到（界面只能给一句话）。
    ctx.logger?.warn?.('crwu-workbench: 状态写入失败 %o', {
      path: workbenchConfigPath(home),
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}

/** 读取一个字符串字段；缺省为空串。 */
export function configText(config: Record<string, unknown>, key: string): string {
  return text(config[key])
}
