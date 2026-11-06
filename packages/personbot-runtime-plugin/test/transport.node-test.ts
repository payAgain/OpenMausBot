import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'node:stream'
import test from 'node:test'
import { setImmediate as immediate } from 'node:timers/promises'
import { ProtocolError, type Response } from '../../personbot-protocol/src/index.ts'
import { RuntimeTransport } from '../src/transport.ts'

function fixture(options: ConstructorParameters<typeof RuntimeTransport>[2] = {}) {
  const input = new PassThrough()
  const output = new PassThrough()
  const responses: Response[] = []
  const observers = new Set<() => void>()
  let buffer = ''
  output.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    let newline: number
    while ((newline = buffer.indexOf('\n')) !== -1) {
      responses.push(JSON.parse(buffer.slice(0, newline)) as Response)
      buffer = buffer.slice(newline + 1)
      for (const observer of observers) observer()
    }
  })
  const transport = new RuntimeTransport(input, output, options)
  transport.start()
  const wait = (count: number): Promise<void> => new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer)
      observers.delete(check)
      if (error) reject(error)
      else resolve()
    }
    const check = () => { if (responses.length >= count) finish() }
    const timer = setTimeout(() => finish(new Error(`Expected ${count} responses; got ${responses.length}`)), 1_000)
    observers.add(check)
    check()
  })
  return { transport, input, output, responses, wait }
}

function request(id: number | string, method = 'personbot.v1.sessions.list', params: unknown = {}) {
  return { jsonrpc: '2.0', id, method, params }
}

test('transport preserves fragmented Unicode, request identities, notifications and concurrent replies', async t => {
  const { transport, input, responses, wait, output } = fixture()
  t.after(() => transport.close())
  let release!: (value: unknown) => void
  const blocked = new Promise(resolve => { release = resolve })
  const seen: Record<string, unknown>[] = []
  transport.onRequest(async (method, params) => {
    seen.push(params)
    if (method === 'personbot.v1.messages.submit') return blocked
    return { listed: true }
  })
  const original = request('消息一', 'personbot.v1.messages.submit', {
    commandId: 'command', sessionId: 'session', messageId: 'message', mode: 'followup', text: '你好🌱',
  })
  const bytes = Buffer.from(`${JSON.stringify(original)}\n`)
  for (let index = 0; index < bytes.length; index++) input.write(bytes.subarray(index, index + 1))
  input.write(`${JSON.stringify(request(2))}\r\n`)
  await wait(1)
  assert.deepEqual(responses[0], { jsonrpc: '2.0', id: 2, result: { listed: true } })
  assert.equal(seen[0]!.text, '你好🌱')
  release({ received: true })
  await wait(2)
  assert.deepEqual(responses[1], { jsonrpc: '2.0', id: '消息一', result: { received: true } })
  transport.notify('personbot.v1.event', { type: 'fixture' })
  await wait(3)
  await transport.flush()
  assert.deepEqual(responses[2], { jsonrpc: '2.0', method: 'personbot.v1.event', params: { type: 'fixture' } })
  assert.equal(output.destroyed, false)
})

test('transport validates full envelopes and reports distinct protocol and domain errors', async t => {
  const { transport, input, responses, wait } = fixture()
  t.after(() => transport.close())
  let handled = 0
  transport.onRequest(async () => {
    handled++
    if (handled === 1) throw new Error('Session has an unfinished stop')
    throw new ProtocolError(-32602, 'Invalid question answer')
  })
  const cases: { value?: unknown; raw?: string; code: number; id: number | string | null }[] = [
    { value: { ...request(1), jsonrpc: '1.0' }, code: -32600, id: 1 },
    { value: { ...request(2), id: null }, code: -32600, id: null },
    { value: { ...request(3), id: {} }, code: -32600, id: null },
    { value: { ...request(4), extra: true }, code: -32600, id: 4 },
    { value: request(5, 'personbot.v1.sessions.list', []), code: -32602, id: 5 },
    { value: request(6, 'personbot.v1.unknown'), code: -32601, id: 6 },
    { value: request(7, 'personbot.v1.snapshots.get', { limit: 0, sessionId: 'session' }), code: -32602, id: 7 },
    { raw: '{"id":8,', code: -32700, id: null },
    { value: ['batch'], code: -32600, id: null },
    { value: request('domain'), code: -32000, id: 'domain' },
    { value: request('validated-handler'), code: -32602, id: 'validated-handler' },
  ]
  for (const entry of cases) input.write(`${entry.raw ?? JSON.stringify(entry.value)}\n`)
  await wait(cases.length)
  for (const entry of cases) {
    const response = responses.find(item => item.id === entry.id && 'error' in item && item.error.code === entry.code)
    assert.ok(response, `Missing ${entry.code} response for ${JSON.stringify(entry.id)}`)
  }
  assert.equal(handled, 2)
})

test('transport has a terminal byte limit for complete and unterminated input frames', async t => {
  for (const newline of ['', '\n']) {
    const failures: Error[] = []
    const { transport, input, responses } = fixture({ maxLineBytes: 32, onFailure: error => failures.push(error) })
    t.after(() => transport.close())
    let handled = 0
    transport.onRequest(async () => { handled++; return {} })
    input.write(Buffer.alloc(16, 'a'))
    input.write(`${'b'.repeat(17)}${newline}`)
    input.write(`${JSON.stringify(request(1))}\n`)
    transport.start()
    await assert.rejects(transport.flush(), /exceeds maxLineBytes/)
    assert.equal(failures.length, 1)
    assert.equal(handled, 0)
    assert.equal(responses.length, 0)
    assert.equal(input.destroyed, false)
  }
})

test('transport reports input errors once and ignores late request completions after close', async t => {
  const failures: Error[] = []
  const { transport, input, output, responses } = fixture({ onFailure: error => failures.push(error) })
  t.after(() => transport.close())
  let release!: (value: unknown) => void
  transport.onRequest(() => new Promise(resolve => { release = resolve }))
  input.write(`${JSON.stringify(request(1))}\n`)
  const failure = new Error('fixture input failure')
  input.emit('error', failure)
  release({ ignored: true })
  await immediate()
  assert.deepEqual(failures, [failure])
  assert.equal(responses.length, 0)
  await assert.rejects(transport.flush(), /fixture input failure/)
  assert.equal(input.listenerCount('data'), 0)
  assert.equal(output.listenerCount('error'), 0)
  assert.equal(output.destroyed, false)
})

test('flush waits for write callbacks and output failure cannot leave it pending', { timeout: 2_000 }, async t => {
  const input = new PassThrough()
  let release!: (error?: Error | null) => void
  const output = new Writable({
    write(_chunk, _encoding, callback) { release = callback },
  })
  const failures: Error[] = []
  const transport = new RuntimeTransport(input, output, { onFailure: error => failures.push(error) })
  t.after(() => transport.close())
  transport.start()
  transport.notify('personbot.v1.event', {})
  let flushed = false
  const pending = transport.flush().then(() => { flushed = true })
  await immediate()
  assert.equal(flushed, false)
  release()
  await pending
  transport.notify('personbot.v1.event', {})
  const rejected = assert.rejects(transport.flush(), /fixture EPIPE/)
  const error = Object.assign(new Error('fixture EPIPE'), { code: 'EPIPE' })
  release(error)
  await rejected
  await immediate()
  assert.equal(failures.length, 1)
  assert.equal(failures[0], error)
  await assert.rejects(transport.flush(), /fixture EPIPE/)
})

test('destroyed output and close during an unfinished write reject flush without owning stream destruction', { timeout: 2_000 }, async t => {
  for (const action of ['destroy', 'close'] as const) {
    const input = new PassThrough()
    let release!: (error?: Error | null) => void
    const output = new Writable({ write(_chunk, _encoding, callback) { release = callback } })
    const failures: Error[] = []
    const transport = new RuntimeTransport(input, output, { onFailure: error => failures.push(error) })
    t.after(() => transport.close())
    transport.start()
    transport.notify('personbot.v1.event', {})
    const pending = assert.rejects(transport.flush(), /closed/)
    if (action === 'destroy') output.destroy()
    else transport.close()
    await pending
    transport.notify('personbot.v1.event', { ignored: true })
    release()
    await immediate()
    assert.equal(input.destroyed, false)
    assert.equal(output.destroyed, action === 'destroy')
    assert.equal(failures.length, action === 'destroy' ? 1 : 0)
    assert.equal(output.listenerCount('error'), 0)
  }
})

test('close retains error containment until a pending write callback has completed', { timeout: 2_000 }, async () => {
  const input = new PassThrough()
  let release!: (error?: Error | null) => void
  const output = new Writable({ write(_chunk, _encoding, callback) { release = callback } })
  const failures: Error[] = []
  const transport = new RuntimeTransport(input, output, { onFailure: error => failures.push(error) })
  transport.start()
  transport.notify('personbot.v1.event', {})
  transport.close()
  assert.equal(output.destroyed, false)
  await assert.rejects(transport.flush(), /closed/)
  release(Object.assign(new Error('late EPIPE after close'), { code: 'EPIPE' }))
  await immediate()
  assert.deepEqual(failures, [])
  assert.equal(output.listenerCount('error'), 0)
})
