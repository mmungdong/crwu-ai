import type { Context } from '@deepseek-ai/cordis'
import { text } from '../../shared/utils/value.ts'
import { isWindowsPlatform } from '../platform/detect.ts'
import { expandLocal } from '../platform/home.ts'
import { fileSystem, resolveTarget } from '../fs/paths.ts'
import { maskKey } from '../h3yun/fields.ts'

/**
 * `~/.ossutilconfig` 的读写。
 *
 * 两条硬约束（`AGENTS.md` §4.3）：AccessKey/STS **绝不回显** —— 读只回脱敏与「有没有」；
 * 写完之后也不回读内容，只回路径与是否成功。文件按 600 权限落盘。
 */

/** ossutil 配置文件的路径：跟着主目录走，不写死。 */
export function ossConfigPath(home: string): string {
  if (home === '') return '~/.ossutilconfig'
  return `${home.replace(/[\\/]+$/, '')}/.ossutilconfig`
}

/** 解析 ossutil 的 INI 风格配置：`key=value`，忽略注释与段名，键小写。 */
export function parseOssConfig(content: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text(content).split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('[')) continue
    const at = trimmed.indexOf('=')
    if (at <= 0) continue
    out[trimmed.slice(0, at).trim().toLowerCase()] = trimmed.slice(at + 1).trim()
  }
  return out
}

export interface OssCredView {
  path: string
  exists: boolean
  endpoint: string
  accessKeyIdMasked: string
  hasSecret: boolean
  hasSts: boolean
  language: string
}

/** 读取当前 AK 配置的**脱敏视图**；文件不存在时全部为空，不抛错。 */
export async function readOssCred(ctx: Context, home: string): Promise<OssCredView> {
  const path = ossConfigPath(home)
  const view: OssCredView = {
    path,
    exists: false,
    endpoint: '',
    accessKeyIdMasked: '',
    hasSecret: false,
    hasSts: false,
    language: '',
  }
  const fs = fileSystem(ctx)
  if (fs === undefined) return view
  try {
    const target = await resolveTarget(ctx, path)
    const info = await fs.stat(target)
    if (info?.type !== 'file') return view
    const config = parseOssConfig(await fs.readText(target))
    view.exists = true
    view.endpoint = text(config.endpoint)
    view.accessKeyIdMasked = maskKey(config.accesskeyid)
    view.hasSecret = text(config.accesskeysecret) !== ''
    view.hasSts = text(config.ststoken) !== ''
    view.language = text(config.language)
  } catch (error) {
    // 不存在或不可读都等价于「没有配置」；界面据 exists=false 引导用户填写。
    void error
  }
  return view
}

export interface OssCredInput {
  accessKeyId: string
  accessKeySecret: string
  endpoint?: string
  language?: string
  stsToken?: string
}

/**
 * 生成 ossutil 配置文件内容。
 *
 * 只接受非空 AK：缺 secret 时**不写半份配置**（半份配置会让 ossutil 报一个和根因无关的错）。
 */
export function buildOssConfig(input: OssCredInput): { ok: boolean; error: string; content: string } {
  const keyId = text(input.accessKeyId).trim()
  const secret = text(input.accessKeySecret).trim()
  if (keyId === '' || secret === '') {
    return { ok: false, error: 'accessKeyId 和 accessKeySecret 都不能为空', content: '' }
  }
  const lines = ['[Credentials]', `language=${text(input.language) || 'CH'}`]
  const endpoint = text(input.endpoint).trim()
  if (endpoint !== '') lines.push(`endpoint=${endpoint}`)
  lines.push(`accessKeyID=${keyId}`, `accessKeySecret=${secret}`)
  const sts = text(input.stsToken).trim()
  if (sts !== '') lines.push(`stsToken=${sts}`)
  return { ok: true, error: '', content: `${lines.join('\n')}\n` }
}

/** 主目录展开：把配置里写的 `~/.ossutilconfig` 换成执行世界的绝对路径。 */
export function resolveConfigPath(home: string, platform: string, path: string): string {
  return path.startsWith('~') ? expandLocal(path, home, isWindowsPlatform(platform)) : path
}
