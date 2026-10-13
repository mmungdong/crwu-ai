import { WORKBENCH_ROUTE } from '../../shared/consts.ts'

/** 调用工作台同源 Host 操作。 */
export async function rpc(operation: string, args: unknown = {}, options: { signal?: AbortSignal } = {}): Promise<Record<string, unknown>> {
  const response = await fetch(WORKBENCH_ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ op: operation, args }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  if (!response.ok) throw new Error(`工作台请求失败：HTTP ${response.status}`)
  return await response.json() as Record<string, unknown>
}
