import { isSafeSeqNo } from '../../shared/consts.ts'
import type { OssBatchIndexResult, OssBatchItemResult } from '../../shared/types.ts'
import { listOssDirectory, requireOss, type OssDeps } from './ops.ts'
import { groupObjects, parseLsEntries, parseLsObjects } from './parse.ts'

type FailureKind = Extract<OssBatchItemResult, { ok: false }>['errorKind']
const failed = (errorKind: FailureKind, error: string): OssBatchItemResult => ({ ok: false, errorKind, error, item: null })

interface Job {
  signal: AbortSignal
  run: () => Promise<OssBatchItemResult>
  finish: (result: OssBatchItemResult) => void
  cancelled: () => OssBatchItemResult
}

export interface OssBatchQueue {
  run: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<OssBatchIndexResult>
  dispose: () => void
}

export function createOssBatchQueue(
  resolveDeps: () => Promise<OssDeps>,
  options: { deadlineMs?: number } = {},
): OssBatchQueue {
  const jobs: Job[] = []
  const batches = new Set<AbortController>()
  let active = 0
  let disposed = false

  const drain = (): void => {
    while (active < 3 && jobs.length > 0) {
      const job = jobs.shift()!
      if (job.signal.aborted) { job.finish(job.cancelled()); continue }
      active++
      void job.run().then(job.finish, () => job.finish(failed('command', '查询审核文件失败，请重试')))
        .finally(() => { active--; drain() })
    }
  }

  const run = async (args: Record<string, unknown>, signal?: AbortSignal): Promise<OssBatchIndexResult> => {
    const reject = (error: string): OssBatchIndexResult => ({ ok: false, error, results: {} })
    if ('seqNo' in args || !Array.isArray(args.seqNos) || args.seqNos.length > 100
      || args.seqNos.some((value: unknown) => typeof value !== 'string' || !isSafeSeqNo(value))) {
      return reject('报告流水号列表不合法：最多 100 项，且每项必须是有效流水号')
    }
    const serials = [...new Set((args.seqNos as string[]).map((value) => value.trim()))]
    if (serials.length === 0) return { ok: true, error: '', results: {} }
    if (disposed || signal?.aborted) return reject('查询已取消')

    const controller = new AbortController()
    const batchJobs = new Set<Job>()
    const results: Record<string, OssBatchItemResult> = {}
    batches.add(controller)
    let timedOut = false
    const deadlineMs = options.deadlineMs ?? 90_000
    const deadline = Date.now() + deadlineMs
    const cancelled = (): OssBatchItemResult => timedOut
      ? failed('timeout', '查询审核文件超时，请重试') : failed('cancelled', '查询已取消')
    const abort = (): void => { controller.abort() }
    signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => { timedOut = true; controller.abort(); drain() }, deadlineMs)
    let rejectPreparation: () => void = () => {}
    const interruption = new Promise<never>((_resolve, reject) => { rejectPreparation = () => reject(new Error('cancelled')) })
    const onAbort = (): void => {
      // Remove cancelled jobs even while all workers are occupied.
      for (let i = jobs.length - 1; i >= 0; i--) {
        if (jobs[i].signal === controller.signal) jobs.splice(i, 1)[0].finish(cancelled())
      }
      for (const job of batchJobs) job.finish(cancelled())
      rejectPreparation()
    }
    controller.signal.addEventListener('abort', onAbort, { once: true })
    try {
      const prepared = await Promise.race([interruption, (async () => {
        const deps = await resolveDeps()
        if (controller.signal.aborted) return null
        const ready = await requireOss(deps)
        if (!ready.ok || controller.signal.aborted) return null
        const workdir = await deps.workdir()
        return { deps, ready, workdir }
      })()])
      if (controller.signal.aborted) return {
        ok: true, error: '', results: Object.fromEntries(serials.map((seq) => [seq, cancelled()])),
      }
      if (prepared === null) return reject('OSS 查询环境未就绪，请在环境信息中检查配置和本机访问授权')
      const { deps, ready, workdir } = prepared
      const read = async (seq: string): Promise<OssBatchItemResult> => {
        if (controller.signal.aborted) return cancelled()
        const prefix = `${ready.oss.prefix}/${seq}/`
        const result = await listOssDirectory(deps, ready, prefix, {
          workdir, signal: controller.signal, timeoutMs: Math.max(1, deadline - Date.now()),
        })
        if (controller.signal.aborted) return cancelled()
        if (result.timedOut) return failed('timeout', '查询审核文件超时，请重试')
        if (result.aborted) return failed('cancelled', '查询已取消')
        if (!result.ok) return failed(result.sandbox.denied ? 'access' : 'command', '查询审核文件失败，请检查 OSS 连接与访问权限后重试')
        if (result.truncated) return failed('truncated', '审核文件清单过大，查询结果不完整')
        if ([...result.stdout.matchAll(/oss:\/\/([^/\s]+)\//g)].some((match) => match[1] !== ready.oss.bucket)) {
          return failed('invalid-result', '审核文件清单无法解析，请重试')
        }
        const entries = parseLsEntries(result.stdout, ready.oss.bucket)
        const keys = parseLsObjects(result.stdout, ready.oss.bucket)
        const list = entries.length > 0 ? entries : keys
        const objectLines = result.stdout.split(/\r?\n/).filter((line) => /^oss:\/\/|^\d{4}-\d{2}-\d{2} /u.test(line.trim()))
        if (objectLines.length !== list.length) return failed('invalid-result', '审核文件清单无法解析，请重试')
        const declared = /Object Number is:\s*(\d+)/i.exec(result.stdout)
        if (declared === null) {
          return failed('invalid-result', '审核文件清单无法解析，请重试')
        }
        if (declared !== null && Number(declared[1]) !== list.length) {
          return failed('invalid-result', '审核文件清单不完整，请重试')
        }
        if (list.some((entry) => !(typeof entry === 'string' ? entry : entry.key).startsWith(prefix))) {
          return failed('invalid-result', '审核文件与报告流水号不匹配')
        }
        if (list.length === 0) return { ok: true, error: '', item: null }
        const items = groupObjects(list, ready.oss.prefix)
        if (Object.keys(items).some((key) => key !== seq) || items[seq] === undefined) {
          return failed('invalid-result', '审核文件与报告流水号不匹配')
        }
        return { ok: true, error: '', item: items[seq] }
      }
      await Promise.all(serials.map((seq) => new Promise<void>((resolve) => {
        if (controller.signal.aborted) { results[seq] = cancelled(); resolve(); return }
        let settled = false
        const job: Job = { signal: controller.signal, run: () => read(seq), cancelled,
          finish: (result) => {
            if (settled) return
            settled = true; batchJobs.delete(job); results[seq] = result; resolve()
          } }
        batchJobs.add(job)
        jobs.push(job)
        drain()
      })))
      return { ok: true, error: '', results: Object.fromEntries(serials.map((seq) => [seq, results[seq]])) }
    } catch {
      if (controller.signal.aborted) return { ok: true, error: '', results: Object.fromEntries(serials.map((seq) => [seq, results[seq] ?? cancelled()])) }
      return reject('OSS 查询环境不可用，请重试')
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      controller.signal.removeEventListener('abort', onAbort)
      batches.delete(controller)
    }
  }

  return {
    run,
    dispose: () => { disposed = true; for (const controller of batches) controller.abort(); drain() },
  }
}
