import { text } from '../../shared/utils/value.ts'

/**
 * OSS 输出脱敏：**唯一**一处把 ossutil 的 stdout / stderr 变成可以给人看（或进日志）的文本。
 *
 * 为什么必须集中一处：`ossutil` 的报错里会带请求 URL（含 `Signature` / `OSSAccessKeyId`）、
 * 甚至完整的临时凭据与 `x-oss-security-token`。这类文本一旦进会话记录或界面，
 * 就等于把凭据写进了可回放的日志。上传路径（`tools/oss.ts`）与环境探测
 * （`environment/probe.ts`）都要用同一份判据 —— 两套正则必然有一天只改了一处。
 *
 * 顺序有讲究：**先按字段名抹值、再抹整条查询串、最后兜底抹 AK 形态**。
 * 反过来会把 URL 整条打成 `?<redacted>`，连"是哪个 bucket"都看不出来。
 */
export function sanitizeOssError(value: unknown): string {
  return text(value)
    .replace(/(Signature|OSSAccessKeyId|security-token|AccessKeyId|AccessKeySecret|STS\w*Token)=[^&\s"']+/gi, '$1=<redacted>')
    .replace(/(https?:\/\/[^\s"']*?)\?[^\s"']*/gi, '$1?<redacted>')
    .replace(/\bLTAI[A-Za-z0-9]{8,}\b/g, '<redacted-access-key>')
    .slice(0, 600)
}

/** ossutil 输出的上限：探测只关心状态码与错误名，不需要整篇正文。 */
export const OSS_OUTPUT_LIMIT = 400
