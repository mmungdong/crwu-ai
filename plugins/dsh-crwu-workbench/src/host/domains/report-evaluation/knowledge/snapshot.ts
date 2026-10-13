import { createHash } from 'node:crypto'
import { text } from '../../../../shared/utils/value.ts'
import type { KnowledgeOrigin, KnowledgeRoute } from './route.ts'

/**
 * 知识来源快照。
 *
 * 它要回答一个能被核对的问题：**这一轮结果用的是哪一版知识**。
 * 所以每条记录都带 `source`（dws / local）、`updatedAt`（能拿到就给）、`digest`（正文指纹）
 * 与 `bytes`。三者缺一，事后就说不清"当时读的是哪一份"。
 *
 * ⚠️ 这里**不记**签名 URL、库 id、组织标识：那些是凭据面的事实，与"哪一版正文"无关。
 */

export interface KnowledgeSource {
  /** `估值与测算/房地产/02-市场法`。 */
  route: string
  /** 库内节点名。 */
  node: string
  /** 正文来源。 */
  source: KnowledgeOrigin
  /** 正文落盘位置（相对案例目录），例如 `知识快照/02-市场法.md`；缺失时为空串。 */
  file: string
  /** 正文指纹；缺失时为空串（**不编一个**）。 */
  digest: string
  bytes: number
  /**
   * 来源端给出的更新时间；拿不到就是空串。
   *
   * 不拿本地文件的 mtime 冒充"知识库更新时间" —— 那会把技能发布时刻说成规范修订时刻。
   */
  updatedAt: string
  /** 为什么需要它（写进索引，子会话按需读）。 */
  when: string
  /** 缺失原因（`source === 'missing'` 时非空）。 */
  missingReason: string
}

/** `sha256:<hex>`，与案例里其它指纹同形。 */
export function knowledgeDigest(body: string): string {
  return `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}`
}

export interface BuildSourceInput {
  route: KnowledgeRoute
  source: KnowledgeOrigin
  body: string
  file: string
  updatedAt?: string
  missingReason?: string
}

/** 造一条来源记录。`digest` 由**正文**算出，调用方给不了假值。 */
export function buildKnowledgeSource(input: BuildSourceInput): KnowledgeSource {
  const body = text(input.body)
  return {
    route: input.route.route,
    node: input.route.node,
    source: input.source,
    file: text(input.file),
    digest: body === '' ? '' : knowledgeDigest(body),
    bytes: byteLength(body),
    updatedAt: text(input.updatedAt),
    when: input.route.when,
    missingReason: text(input.missingReason),
  }
}

/** UTF-8 字节数（`body.length` 对中文是字符数，写进证据会误导）。 */
export function byteLength(body: string): number {
  return new TextEncoder().encode(body).length
}

/**
 * 整份知识快照的指纹：按**路由排序**后哈希，于是同一批正文无论取数顺序如何都是同一个值。
 *
 * 用途是核对"确认抽屉里看到的来源"与"子会话实际用的来源"是不是同一份 ——
 * 只列文件名无法区分"同名但正文改过"。
 */
export function knowledgeSnapshotDigest(sources: readonly KnowledgeSource[]): string {
  const rows = [...sources]
    .sort((left, right) => (left.route < right.route ? -1 : left.route > right.route ? 1 : 0))
    .map((item) => ({ route: item.route, source: item.source, digest: item.digest }))
  return `sha256:${createHash('sha256').update(JSON.stringify(rows), 'utf8').digest('hex')}`
}

/**
 * 来源摘要（界面与结果 JSON 都用它；不含正文）。
 *
 * 显式形状而不是 `Record<string, unknown>`：它是**跨进程契约**的一部分
 * （结果 JSON 的 `knowledge_sources`），宽类型会让"少写一个字段"在编译期看不见。
 */
export interface KnowledgeSourceView {
  route: string
  source: KnowledgeOrigin
  updatedAt: string
  digest: string
}

export function knowledgeSourcesView(sources: readonly KnowledgeSource[]): KnowledgeSourceView[] {
  return sources.map((item) => ({
    route: item.route,
    source: item.source,
    updatedAt: item.updatedAt,
    digest: item.digest,
  }))
}
