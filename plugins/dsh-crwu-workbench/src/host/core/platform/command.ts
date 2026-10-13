import type { Context } from '@deepseek-ai/cordis'
import { fileSystem, resolveTarget } from '../fs/paths.ts'
import { bundledBinaryPath } from './bin-dir.ts'

/**
 * 把「按名字调用的自带命令」解析成**包内绝对路径**；解析不到就原样回退那个名字。
 *
 * **为什么必须做这件事**：把二进制放进包里，只是让它们「存在于某处」；按名字调用仍然要靠 PATH ——
 * 而 DSH 的 shell PATH 是它自己继承来的。桌面端从 Finder 启动时 PATH 只有
 * `/usr/bin:/bin:/usr/sbin:/sbin`，那里既没有 `~/bin` 也没有插件的 `bin/<平台>/`。
 *
 * 实测踩到（2026-09-25，desktop profile）：环境自检报
 * `h3yun → bash: crwu: command not found`、`dingtalk → bash: dws: command not found`，
 * 而同一份清单里的 `ossutil` 正常 —— 因为 `resolveOssutil` 早就改成优先用包内绝对路径了。
 * 后果是「氚云登录 / 钉钉登录」按钮点了没有任何反应：命令压根没跑起来，而客户端又把返回值丢掉了。
 *
 * 回退分支必须保留：执行世界可能是 SSH / 容器，那时宿主上的包内路径根本不存在，只能靠那台机器的 PATH。
 * 所以这里只做「能证实存在就用绝对路径」，绝不去猜。
 */
export async function resolveBundledCommand(ctx: Context, platform: string, name: string): Promise<string> {
  const bundled = bundledBinaryPath(platform, name)
  if (bundled === '') return name
  try {
    const info = await fileSystem(ctx)?.stat(await resolveTarget(ctx, bundled))
    if (info?.type === 'file') return bundled
  } catch (error) {
    // 没装 / 平台不受支持 / 文件服务不可用都走回退，不是错误。
    void error
  }
  return name
}

/** 同上，但调用方拿到的是完整命令行：把第一个词（命令名）换掉，其余原样保留。 */
export function replaceCommandName(command: string, resolved: string): string {
  const at = command.indexOf(' ')
  return at < 0 ? resolved : `${resolved}${command.slice(at)}`
}

/** 严格解析的结果：要么是包内绝对路径，要么是一句可汇报的 capability gap。 */
export type RequiredCommand =
  | { ok: true; path: string; platform: string }
  | { ok: false; errorKind: 'capability-gap' | 'infrastructure'; error: string; platform: string }

/**
 * 审核工具专用的**严格**自带二进制解析：受支持平台上必须存在，否则回 capability gap。
 *
 * 与 `resolveBundledCommand` 的区别只有一条，但它是安全边界：**绝不回退裸命令名**。
 * 回退的名字要靠 PATH 解析，而审核调用的执行世界是 DSH 的 shell —— Finder 启动的桌面端 PATH 只有
 * `/usr/bin:/bin:/usr/sbin:/sbin`。回退的直接后果是 `bash: dws: command not found`：模型看到
 * 命令不存在，下一步自然就是 `which` / `command -v` / `find` 去找它 —— 正是本次改造要消灭的行为。
 *
 * 平台不在发布范围内（例如 linux-x64）时不假装成功：如实报「该平台没有随包二进制」，
 * 由调用方按显式配置/受信 world facts 决定是否改用执行世界的 PATH（见 `dws/run.ts` 的注释）。
 */
export async function requireBundledCommand(ctx: Context, platform: string, name: string): Promise<RequiredCommand> {
  const bundled = bundledBinaryPath(platform, name)
  if (bundled === '') {
    return {
      ok: false,
      errorKind: 'capability-gap',
      error: `当前平台（${platform || '未知'}）没有随包发布的 ${name}；自研审核链路不在 PATH 里搜索二进制。`,
      platform,
    }
  }
  const stat = await fileSystem(ctx)?.stat(await resolveTarget(ctx, bundled)).catch((error: unknown) => {
    // 文件不存在 / fs 服务不可用：两种都只意味着「这个绝对路径现在不可用」。
    void error
    return undefined
  })
  if (stat?.type !== 'file') {
    return {
      ok: false,
      errorKind: 'capability-gap',
      error: `包内 ${name} 不存在：${bundled}（插件包未装配该平台的二进制，或安装不完整）。`,
      platform,
    }
  }
  return { ok: true, path: bundled, platform }
}
