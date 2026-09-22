import type { Context } from '@deepseek-ai/cordis'
import type { FileSystem, FsDirEntry, FsTarget } from '@deepseek-ai/dsh-fs'
import { isSafeSeqNo } from '../../shared/consts.ts'
import { text } from '../../shared/utils/value.ts'
import { runCrwu } from '../crwu/run.ts'
import { parseJsonLoose } from '../../shared/utils/json.ts'
import { fileSystem, resolveTarget } from '../fs/paths.ts'
import { ossIndex, type OssDeps } from '../oss/ops.ts'

/**
 * 一份报告的**全部相关文件**（只列举、不下载）。
 *
 * 用户口径（2026-09-22）：「打开侧边栏的时候，crwu 应该同步去查询一份关于这个报告流水号的
 * 所有的内容，包括文件数据，但是不下载，只有当用户询问的时候才去下载」。
 *
 * 三个来源合并在**一次**调用里回给面板：
 * 1. **氚云附件（这是"这份报告到底有哪些文件"的权威来源）**：`crwu h3yun files list
 *    --schema <表单 code> --id <ObjectId>`。用户 2026-09-22 让我"看下 skills 里 crwu 是怎么查
 *    这些文件的"——正是这条：crwu-audit 技能步骤 1 就用它只取**附件字段、文件名、类型、大小、
 *    下载 URL** 这些元数据，**不下载**（下载是逐件的 `crwu h3yun file get`，只在真要用的时候发）。
 *    真实输出形如 `{"data":[{"field","fileId","fileName","fileSize","contentType","downloadUrl"}]}`。
 * 2. **本地案例目录**：`<工作空间>/<流水号>`（crwu-audit 的案例目录就是这么定的），递归列到第 3 层。
 * 3. **云端交付件**：复用 `ossIndex({ seqNo })`，只列举 `<prefix>/<流水号>/`。
 *
 * **为什么不做成"打开面板就下载"**：材料动辄几十上百 MB，一次下载会把面板卡住、也白烧流量；
 * 面板只回答"有哪些文件"，要正文由 AI 在讨论里按需取（它自己会调工具）。
 *
 * 安全边界：流水号进路径，所以先过共享的形状判据（`isSafeSeqNo`，不含 `/`）；本地目录再确认
 * 它**落在选定工作空间之内**（拼路径后做一次前缀包含判断）。
 */

/** 云端一个对象（只给面板显示用的两个字段）。 */
export interface ReportCloudFile {
  key: string
  name: string
  /** 下面三项来自 `ossutil ls` 的长格式（一次列举就有）：大小 / 最后写入时间 / ETag。 */
  size?: number
  lastModified?: string
  etag?: string
}

/** 本地案例目录里的一个文件（相对路径 + 字节数 + DSH fs 的版本令牌）。 */
export interface ReportLocalFile {
  name: string
  path: string
  size: number
  /**
   * DSH `FsDirEntry.version`：**后端给的权威新鲜度令牌**（`stat`/写入结果才有）。
   * 它比 mtime 强：同一份文件没动过就是同一个令牌，动过就换。
   * 组合成目录级指纹后，用来判断"这份报告的资料在会话之后是否变过"。
   */
  version?: string
}

/** 氚云上的一个附件（只元数据，不下载）。 */
export interface ReportH3yunFile {
  field: string
  fileId: string
  name: string
  size: number
  contentType: string
}

export interface ReportFilesResult {
  ok: boolean
  error: string
  seqNo: string
  /** 氚云附件（权威来源：这份报告该有哪些文件）。 */
  h3yun: ReportH3yunFile[]
  /** 氚云查询失败的原因（失败不影响本地/云端两组照常显示）。 */
  h3yunError: string
  /** 云端对象（可能为空 = 这份报告还没上云）。 */
  oss: ReportCloudFile[]
  /** 本地案例目录里的文件（可能为空 = 还没有这个目录）。 */
  local: ReportLocalFile[]
  /** 本地案例目录的绝对路径（空串 = 没选定工作空间）。 */
  localDir: string
  /** 本地是否真的存在这个案例目录（不存在与"存在但空"是两件事，界面要分开说）。 */
  localExists: boolean
  /** 列举被上限截断（对象/文件太多）。 */
  truncated: boolean
}

export interface ReportFilesDeps {
  ctx: Context
  /** 与 OSS 操作同一套依赖（列举要跑 ossutil）。 */
  oss: OssDeps
  /** 环境里选中的工作空间绝对路径（空串 = 还没选）。 */
  workspacePath: () => string
  /** 氚云表单 code（`records list` 用的同一个；空串 = 还没解析出来）。 */
  formCode: () => string
  /** 用户是否已授权读本机凭据（与 `pending` 同一条纪律：没授权就不去读钥匙串）。 */
  trusted: boolean
  platform: string
  workdir: () => Promise<string>
}

const LOCAL_MAX_DEPTH = 3
const LOCAL_MAX_FILES = 300

const EMPTY = {
  seqNo: '', h3yun: [], h3yunError: '', oss: [], local: [], localDir: '', localExists: false, truncated: false,
}

/** 把 `crwu h3yun files list` 的 `{data:[…]}` 收窄成我们要的元数据（形状不对就跳过该条）。 */
export function parseH3yunFiles(payload: unknown): ReportH3yunFile[] {
  const rows = (payload as { data?: unknown } | null)?.data
  if (!Array.isArray(rows)) return []
  const out: ReportH3yunFile[] = []
  for (const raw of rows) {
    const row = raw as Record<string, unknown> | null
    if (row === null || typeof row !== 'object') continue
    const name = text(row.fileName)
    if (name === '') continue
    const size = Number.parseInt(text(row.fileSize), 10)
    out.push({
      field: text(row.field),
      fileId: text(row.fileId),
      name,
      size: Number.isFinite(size) ? size : 0,
      contentType: text(row.contentType),
    })
  }
  return out
}

function joinPath(base: string, name: string): string {
  return base.endsWith('/') ? `${base}${name}` : `${base}/${name}`
}

/** 递归列目录（只名字与大小，深度与数量都设上限）。 */
async function collectLocal(
  fs: FileSystem,
  target: FsTarget,
  base: string,
  relative: string,
  depth: number,
  out: ReportLocalFile[],
): Promise<void> {
  if (depth > LOCAL_MAX_DEPTH || out.length >= LOCAL_MAX_FILES) return
  let entries: FsDirEntry[] = []
  try {
    entries = await fs.listDir(target)
  } catch (error) {
    // 目录列不动（权限/消失）不算致命：返回已经收到的那些，界面照常显示云端部分。
    void error
    return
  }
  for (const entry of entries) {
    if (out.length >= LOCAL_MAX_FILES) return
    const name = relative === '' ? entry.name : `${relative}/${entry.name}`
    if (entry.type === 'directory') {
      await collectLocal(fs, entry.target, base, name, depth + 1, out)
      continue
    }
    if (entry.type !== 'file') continue
    out.push({
      name: entry.name,
      path: joinPath(base, name),
      size: typeof entry.size === 'number' ? entry.size : 0,
      ...(typeof entry.version === 'string' ? { version: entry.version } : {}),
    })
  }
}

export async function reportFiles(deps: ReportFilesDeps, args: Record<string, unknown> = {}): Promise<ReportFilesResult> {
  const seqNo = text(args.seqNo).trim()
  // ObjectId 是氚云记录 id：只允许字母数字与 -（uuid 形状），进命令行参数前先收窄。
  const objectId = text(args.objectId).trim()
  if (objectId !== '' && !/^[A-Za-z0-9-]{8,64}$/.test(objectId)) {
    return { ok: false, error: `记录 id 形状不对：${objectId}`, ...EMPTY }
  }
  if (seqNo === '' || !isSafeSeqNo(seqNo)) {
    return {
      ok: false,
      error: `流水号形状不对：${seqNo === '' ? '(空)' : seqNo}（示例 2026-301705-LX10170-BG8746；只允许字母数字与 - _ .，不能含 /）`,
      ...EMPTY,
    }
  }

  // 氚云附件：**只取元数据、绝不下载**（下载是 `crwu h3yun file get` 逐件的事，只在真要用时发）。
  // 没授权就不去读钥匙串（与 `pending` 同一条纪律）：那样只会问出一个假的"没登录"。
  let h3yun: ReportH3yunFile[] = []
  let h3yunError = ''
  const formCode = deps.formCode()
  if (objectId !== '') {
    if (!deps.trusted) {
      h3yunError = '还没授权读取本机凭据（授权后这里会列出氚云上的全部附件）'
    } else if (formCode === '') {
      h3yunError = '还没解析出氚云表单 code，无法列附件'
    } else {
      const run = await runCrwu(deps.ctx, [
        'crwu', 'h3yun', 'files', 'list', '--schema', formCode, '--id', objectId,
      ], {
        workdir: await deps.workdir(),
        timeoutMs: 90_000,
        trusted: deps.trusted,
        platform: deps.platform,
        stdoutMaxBytes: 4 * 1024 * 1024,
      })
      const payload = parseJsonLoose(run.stdout)
      if (run.ok && payload !== null) {
        h3yun = parseH3yunFiles(payload)
      } else {
        h3yunError = text(run.stderr) || run.error || '氚云附件列举失败'
        h3yunError = h3yunError.slice(0, 300)
      }
    }
  }

  // 云端：只列举。失败不致命（本地文件仍然要显示），但把原因带出去。
  const listed = await ossIndex(deps.oss, { seqNo })
  const oss: ReportCloudFile[] = []
  // `oss-index` 的 items 在类型上是 `Record<string, unknown>`（它面向客户端、形状由线上契约定），
  // 这里按我们真正用到的两个字段收窄，缺字段就跳过 —— 不为一个显示用的字段去改跨进程契约。
  for (const raw of Object.values(listed.items)) {
    const item = raw as {
      files?: Array<{ key?: unknown; name?: unknown; size?: unknown; lastModified?: unknown; etag?: unknown }>
    } | null
    for (const file of item?.files ?? []) {
      if (typeof file.key === 'string' && typeof file.name === 'string') {
        oss.push({
          key: file.key,
          name: file.name,
          ...(typeof file.size === 'number' ? { size: file.size } : {}),
          ...(typeof file.lastModified === 'string' ? { lastModified: file.lastModified } : {}),
          ...(typeof file.etag === 'string' ? { etag: file.etag } : {}),
        })
      }
    }
  }

  // 本地：<工作空间>/<流水号>，且必须落在工作空间之内。
  const workspacePath = deps.workspacePath()
  const localDir = workspacePath === '' ? '' : joinPath(workspacePath, seqNo)
  let local: ReportLocalFile[] = []
  let localExists = false
  if (localDir !== '' && (localDir === workspacePath || localDir.startsWith(`${workspacePath.replace(/\/+$/, '')}/`))) {
    const fs = fileSystem(deps.ctx)
    if (fs !== undefined) {
      const target = await resolveTarget(deps.ctx, localDir)
      const entries = await fs.listDir(target).catch((error: unknown) => {
        void error
        return null
      })
      if (entries !== null) {
        localExists = true
        await collectLocal(fs, target, localDir, '', 1, local)
      }
    }
  }

  return {
    ok: true,
    error: listed.ok ? '' : listed.error,
    seqNo,
    h3yun,
    h3yunError,
    oss,
    local,
    localDir,
    localExists,
    truncated: listed.truncated || local.length >= LOCAL_MAX_FILES,
  }
}
