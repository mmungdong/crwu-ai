/**
 * 测试用的环境清单夹具。
 *
 * 2026-09-25 之前各测试文件都拿 `normalizeManifest({...})` 造清单 —— 那个函数属于
 * 「把远程 JSON 收窄成清单」这条已删除的链路。现在清单只有内置一份，夹具就是
 * 「内置清单 + 覆盖你想改的那一段」；收窄只剩 OSS 那部分（`normalizeOss` 还在，它同时服务
 * `audit/ops.ts`）。
 *
 * 放进 helpers 而不是每个文件各写一份：OSS 的默认值（prefix / linkMode / TTL / autoUpload）
 * 一旦在测试里散成几份，改默认值时就会有一半测试在验一个生产里不存在的形状。
 *
 * 用法两种都对（`oss` 会被单独收窄，其余段落直接覆盖）：
 *   manifestFixture({ oss: { bucket: 'bkt', prefix: 'crwu/audit' } })
 *   manifestFixture({ binaries: [{ name: 'extra', command: 'extra' }] })
 */
import { DEFAULT_MANIFEST } from '../../src/host/environment/manifest-default.ts'
import { normalizeOss } from '../../src/host/environment/manifest.ts'

export function manifestFixture(patch = {}) {
  const { oss, ...rest } = patch
  return {
    ...DEFAULT_MANIFEST,
    ...rest,
    oss: normalizeOss({ ...DEFAULT_MANIFEST.oss, ...(oss ?? {}) }),
  }
}
