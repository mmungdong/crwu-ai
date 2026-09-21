import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { WORKBENCH_ROUTE } from '../../shared/consts.ts'
import { text } from '../../shared/utils/value.ts'
import type { OperationArgs, OperationMap } from '../ops/types.ts'
import { RPC_BODY_MAX_BYTES } from './consts.ts'
import { readJsonBody, writeJson } from './json.ts'

/** 注册工作台的同源操作端点。 */
export function registerRpcRoute(ctx: Context, operations: OperationMap): () => void {
  return ctx.webServer.register({
    kind: 'exact',
    path: WORKBENCH_ROUTE,
    async handler(req, res) {
      try {
        if (req.method !== 'POST') {
          writeJson(res, 405, { ok: false, error: '仅支持 POST' })
          return
        }
        const origin = req.headers.origin
        const host = req.headers.host
        if (origin !== undefined && host !== undefined
          && origin !== `http://${host}` && origin !== `https://${host}`) {
          writeJson(res, 403, { ok: false, error: '不允许跨域' })
          return
        }
        const body = await readJsonBody(req, RPC_BODY_MAX_BYTES) as { op?: unknown; args?: unknown }
        const operationName = text(body.op)
        const operation = operations[operationName]
        if (operation === undefined) {
          writeJson(res, 404, { ok: false, error: `未知 op：${operationName}` })
          return
        }
        const args = (body.args !== null && typeof body.args === 'object' ? body.args : {}) as OperationArgs
        writeJson(res, 200, await operation(args))
      } catch (error) {
        writeJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  })
}
