import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { registerRpcRoute } from '../../src/host/http/route.ts'

function fixture(operation) {
  let handler
  registerRpcRoute({ webServer: { register(route) { handler = route.handler; return () => {} } } }, { test: operation })
  const req = new EventEmitter()
  req.method = 'POST'
  req.headers = {}
  req[Symbol.asyncIterator] = async function* () { yield Buffer.from('{"op":"test","args":{}}') }
  const res = new EventEmitter()
  res.setHeader = () => {}
  res.end = () => { res.writableEnded = true; res.emit('close') }
  return { req, res, handler }
}

test('route supplies an AbortSignal and normal completion does not abort it', async () => {
  let signal
  const f = fixture(async (_args, context) => { signal = context?.signal; return { ok: true } })
  await f.handler(f.req, f.res)
  assert.ok(signal instanceof AbortSignal)
  assert.equal(signal.aborted, false)
  assert.equal(f.res.listenerCount('close'), 0)
})

test('response disconnect aborts the running operation and cleans listeners', async () => {
  let signal
  const f = fixture(async (_args, context) => {
    signal = context?.signal
    if (signal) await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
    return { ok: false }
  })
  const pending = f.handler(f.req, f.res)
  await new Promise((resolve) => setImmediate(resolve))
  f.res.emit('close')
  await pending
  assert.ok(signal?.aborted)
  assert.equal(f.req.listenerCount('aborted'), 0)
})
