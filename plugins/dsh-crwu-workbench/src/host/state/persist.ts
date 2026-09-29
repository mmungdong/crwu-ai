import type { Context } from '@deepseek-ai/cordis'
import { text } from '../../shared/utils/value.ts'
import { joinLocalPath } from '../../shared/utils/local-path.ts'
import { fileSystem, resolveTarget } from '../fs/paths.ts'
import type { LocalAccessBroker } from '../access/broker.ts'

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
  // **必须走 `joinLocalPath`**：手拼 `/` 会让 Windows 的 `C:\Users\x` 变成
  // `C:\Users\x/.dsh/crwu-workbench.json`（混合分隔符）。Windows 通常能吃下去，
  // 但这个文件承载的是**授权收据与撤销状态** —— 它不能依赖"通常能吃下去"。
  return joinLocalPath(home, '.dsh', 'crwu-workbench.json')
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
 * 合并写入配置的依赖。
 *
 * **必须经 Broker**（协议 18 · B-01）：这份文件在 `~/.dsh/` —— 工作区之外，
 * 也就是"跨边界写"。它原来自己拼 `sandboxPolicy`，等于在工作台里开了第二个策略判据；
 * 现在连它一起走 `workbench.state.write`（capability = `host-owned-state`：
 * 插件自己的状态**不属于**员工授予的能力范围，所以未授权时也能落盘授权收据 ——
 * 这正是 A1 说的那个"窄例外"，由 Broker 的封闭表 + 固定路径来保证它只有这一条）。
 */
export interface WorkbenchWriteDeps {
  ctx: Context
  home: string
  access: LocalAccessBroker
}

/**
 * 合并写入配置。
 *
 * 读-改-写而不是整体覆盖：面板的多个操作（选工作空间、落盘审核记录、释放占用）都会写这个文件，
 * 整体覆盖会让后写的把先写的抹掉。
 */
export async function writeWorkbenchConfig(
  deps: WorkbenchWriteDeps,
  patch: Record<string, unknown>,
): Promise<boolean> {
  const { ctx, home, access } = deps
  const current = await readWorkbenchConfigResult(ctx, home)
  // 读失败就**不写**：这一次补丁会把没读到的字段一起抹掉，代价比晚一次写入大得多。
  if (!current.ok) return false
  const next = { ...current.value, ...patch }
  const written = await access.writeText(
    { operation: 'workbench.state.write', source: 'host-background' },
    { kind: 'workbench-state', path: workbenchConfigPath(home) },
    `${JSON.stringify(next, null, 2)}\n`,
  )
  if (!written.ok) {
    // 不吞：写不进去的原因必须能从日志里看到（界面只能给一句失败）。**不回显路径**：
    // 它在未授权语境里也是维护者信息，而操作名与类别已经足够定位。
    ctx.logger?.warn?.('crwu-workbench: 状态写入失败 %o', {
      operation: 'workbench.state.write',
      error: written.error,
    })
    return false
  }
  return true
}

/** 读取一个字符串字段；缺省为空串。 */
export function configText(config: Record<string, unknown>, key: string): string {
  return text(config[key])
}
