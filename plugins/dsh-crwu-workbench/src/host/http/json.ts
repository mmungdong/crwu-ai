import type { IncomingMessage, ServerResponse } from 'node:http'

/** 写出禁止缓存的 JSON 响应。 */
export function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(payload)
}

/** 在固定字节上限内读取 JSON 请求体。 */
export async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const value = chunk as Buffer
    size += value.length
    if (size > maxBytes) throw new Error('请求体过大 / Request body too large.')
    chunks.push(value)
  }
  if (size === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
