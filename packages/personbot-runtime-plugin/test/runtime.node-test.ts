import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { watch } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { EVENT_METHOD, type RuntimeEvent } from '../../personbot-protocol/src/index.ts'
import { spawnRuntime, type RuntimeHost } from '../../personbot-runtime-host/src/index.ts'
import { prepareRuntime } from '../src/launch.ts'

interface NativeEvent {
  type: string
  seq: number
  data: {
    id?: string
    source?: { kind: string }
    message?: { content: { type: string; text?: string }[] }
    reason?: { kind: string }
  }
}

interface Snapshot {
  generation: string
  sessions: { sessionId: string; status: string }[]
  logs: { sessionId: string; events: NativeEvent[]; nextSeq?: number; hasMore?: boolean }[]
  pending: { requestId: string; sessionId: string; generation: string; kind: string }[]
}

const fixtureHosts = new Map<string, Set<RuntimeHost>>()

class RuntimeFixture {
  readonly runtime: RuntimeHost
  readonly events: RuntimeEvent[] = []
  private readonly observers = new Set<() => void>()
  generation = ''

  constructor(runtime: RuntimeHost) {
    this.runtime = runtime
    runtime.onNotification(notification => {
      if (notification.method !== EVENT_METHOD) return
      this.events.push(notification.params as RuntimeEvent)
      for (const notify of this.observers) notify()
    })
  }

  async initialize(): Promise<void> {
    const result = await this.runtime.request<{ generation: string; protocolVersion: number }>(
      'personbot.v1.initialize', { protocolVersion: 1 },
    )
    assert.equal(result.protocolVersion, 1)
    this.generation = result.generation
  }

  create(sessionId: string, cwd: string, task = false) {
    return this.runtime.request('personbot.v1.sessions.create', {
      sessionId, cwd, ...(task ? { taskId: `task-${sessionId}` } : { conversationId: `chat-${sessionId}` }),
    })
  }

  submit(sessionId: string, text: string, identity = randomUUID()) {
    return this.runtime.request('personbot.v1.messages.submit', {
      commandId: `command-${identity}`, sessionId, messageId: `message-${identity}`, text, mode: 'followup',
    })
  }

  stop(sessionId: string, commandId = randomUUID()) {
    return this.runtime.request<{ sessionId: string; confirmed: boolean; errors: string[] }>(
      'personbot.v1.sessions.stop', { commandId, sessionId },
    )
  }

  wait(predicate: (event: RuntimeEvent) => boolean, from = 0): Promise<RuntimeEvent> {
    const existing = this.events.slice(from).find(predicate)
    if (existing) return Promise.resolve(existing)
    return new Promise((resolve, reject) => {
      const check = () => {
        const event = this.events.slice(from).find(predicate)
        if (event) finish(undefined, event)
      }
      const timer = setTimeout(() => finish(new Error(`Native runtime event timed out.\n${this.runtime.stderrTail}`)), 15_000)
      const finish = (error?: Error, event?: RuntimeEvent) => {
        clearTimeout(timer)
        this.observers.delete(check)
        if (error) reject(error)
        else resolve(event!)
      }
      this.observers.add(check)
      void this.runtime.closed.then(exit => {
        if (this.observers.has(check)) finish(new Error(`Runtime exited before event: ${JSON.stringify(exit)}\n${this.runtime.stderrTail}`))
      })
    })
  }

  native(type: string, sessionId: string, from = 0) {
    return this.wait(event => event.type === 'session.event' && event.sessionId === sessionId &&
      (event.payload as { event: NativeEvent }).event.type === type, from).catch(error => {
        const observed = this.events.slice(from).map(event => `${event.sessionId}:${event.type === 'session.event'
          ? (event.payload as { event: NativeEvent }).event.type : event.type}`)
        throw new Error(`Expected native ${type} for ${sessionId}; observed ${observed.join(', ')}`, { cause: error })
      })
  }

  async allEvents(sessionId: string): Promise<NativeEvent[]> {
    const events: NativeEvent[] = []
    let fromSeq: number | undefined
    for (;;) {
      const snapshot = await this.runtime.request<Snapshot>('personbot.v1.snapshots.get', {
        sessionId, ...(fromSeq === undefined ? {} : { fromSeq, limit: 100 }),
      })
      const log = snapshot.logs.find(entry => entry.sessionId === sessionId)
      assert.ok(log)
      events.push(...log.events)
      if (!log.hasMore) return events
      assert.ok(log.nextSeq !== undefined && log.nextSeq > (fromSeq ?? 0))
      fromSeq = log.nextSeq
    }
  }

  async close(): Promise<void> {
    const exit = await this.runtime.close({ graceMs: 10_000, terminateMs: 1_000 })
    assert.equal(exit.code, 0, `Runtime did not exit cleanly: ${JSON.stringify(exit)}\n${this.runtime.stderrTail}`)
  }
}

async function workspace(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'personbot-native-test-'))
  const cwd = join(directory, 'workspace')
  const home = join(directory, 'home')
  await mkdir(cwd)
  await mkdir(home)
  const hosts = new Set<RuntimeHost>()
  fixtureHosts.set(home, hosts)
  t.after(async () => {
    await Promise.all([...hosts].map(host => host.close({ graceMs: 10_000 })))
    fixtureHosts.delete(home)
    await rm(directory, { recursive: true, force: true })
  })
  return { directory, cwd, home }
}

async function start(home: string, cwd: string): Promise<RuntimeFixture> {
  const options = await prepareRuntime({ home, workspace: cwd, provider: 'personbot-fixture', model: 'fixture', fixture: true })
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    TEMP: process.env.TEMP ?? tmpdir(),
    SystemRoot: process.env.SystemRoot,
    LANG: 'en_US.UTF-8',
    DSH_HOME: options.env.DSH_HOME,
    DSH_PRIMARY_RUNTIME: '',
    DSH_TELEMETRY_DISABLED: '1',
  }
  const fixture = new RuntimeFixture(spawnRuntime({ ...options, env, defaultTimeoutMs: 25_000 }))
  fixtureHosts.get(home)?.add(fixture.runtime)
  try {
    await fixture.initialize()
    return fixture
  } catch (error) {
    await fixture.runtime.close({ shutdownMethod: null, graceMs: 0 })
    throw new Error(`Could not initialize native dsh fixture.\n${fixture.runtime.stderrTail}`, { cause: error })
  }
}

async function missing(path: string): Promise<void> {
  await assert.rejects(access(path), { code: 'ENOENT' })
}

function assistantText(events: NativeEvent[]): string {
  return events.filter(event => event.type === 'assistant/message')
    .flatMap(event => event.data.message?.content ?? [])
    .filter(block => block.type === 'text').map(block => block.text).join('\n')
}

function processMarker(cwd: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const watcher = watch(cwd, () => { void inspect() })
    const timer = setTimeout(() => finish(new Error('Native background process did not publish its PID')), 15_000)
    const finish = (error?: Error, pid?: number) => {
      clearTimeout(timer)
      watcher.close()
      if (error) reject(error)
      else resolve(pid!)
    }
    const inspect = async () => {
      try {
        const text = await readFile(join(cwd, 'background.pid'), 'utf8')
        if (/^[1-9]\d*$/.test(text)) finish(undefined, Number(text))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') finish(error as Error)
      }
    }
    watcher.once('error', error => finish(error))
    void inspect()
  })
}

async function processExited(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH')
      return
    }
    await delay(20)
  }
  assert.fail(`Owned native background PID ${pid} remains alive after session stop`)
}

test('native concurrent Sessions stop independently and old stop retries preserve new work', { timeout: 60_000 }, async t => {
  const { home, cwd } = await workspace(t)
  const fixture = await start(home, cwd)
  t.after(() => fixture.runtime.close({ graceMs: 10_000 }))
  await Promise.all([fixture.create('a', cwd), fixture.create('b', cwd)])
  const first = fixture.events.length
  await Promise.all([fixture.submit('a', 'hold'), fixture.submit('b', 'hold')])
  await Promise.all([fixture.native('request/context', 'a', first), fixture.native('request/context', 'b', first)])
  const stopId = randomUUID()
  assert.equal((await fixture.stop('a', stopId)).confirmed, true)
  const listed = await fixture.runtime.request<{ sessions: { sessionId: string; status: string }[] }>('personbot.v1.sessions.list')
  assert.equal(listed.sessions.find(session => session.sessionId === 'a')?.status, 'closed')
  assert.equal(listed.sessions.find(session => session.sessionId === 'b')?.status, 'running')
  const next = fixture.events.length
  await fixture.submit('a', 'hold')
  await fixture.wait(event => event.sessionId === 'a' && event.type === 'session.stream' &&
    (event.payload as { type: string }).type === 'start', next)
  assert.equal((await fixture.stop('a', stopId)).confirmed, true)
  const retried = await fixture.runtime.request<{ sessions: { sessionId: string; status: string }[] }>('personbot.v1.sessions.list')
  assert.equal(retried.sessions.find(session => session.sessionId === 'a')?.status, 'running')
  await Promise.all([fixture.stop('a'), fixture.stop('b')])
  await fixture.close()
})

test('native worker approvals gate actual writes and native questions accept validated answers', { timeout: 60_000 }, async t => {
  const { home, cwd } = await workspace(t)
  const fixture = await start(home, cwd)
  t.after(() => fixture.runtime.close({ graceMs: 10_000 }))
  await fixture.create('worker', cwd, true)
  let from = fixture.events.length
  await fixture.submit('worker', 'approve allowed.txt')
  const approval = await fixture.wait(event => event.type === 'approval.requested' && event.sessionId === 'worker', from)
  const requestId = (approval.payload as { requestId: string }).requestId
  await missing(join(cwd, 'allowed.txt'))
  await assert.rejects(fixture.runtime.request('personbot.v1.approvals.resolve', {
    generation: 'expired-generation', requestId, outcome: 'allowed-once',
  }), /expired runtime generation/)
  await missing(join(cwd, 'allowed.txt'))
  await fixture.runtime.request('personbot.v1.approvals.resolve', {
    generation: approval.generation, requestId, outcome: 'allowed-once',
  })
  await fixture.native('turn/end', 'worker', from)
  assert.equal(await readFile(join(cwd, 'allowed.txt'), 'utf8'), 'approved by personbot fixture\n')
  await assert.rejects(fixture.runtime.request('personbot.v1.approvals.resolve', {
    generation: approval.generation, requestId, outcome: 'allowed-once',
  }), /no longer pending/)

  from = fixture.events.length
  await fixture.submit('worker', 'approve denied.txt')
  const denial = await fixture.wait(event => event.type === 'approval.requested' && event.sessionId === 'worker', from)
  await fixture.runtime.request('personbot.v1.approvals.resolve', {
    generation: denial.generation, requestId: (denial.payload as { requestId: string }).requestId, outcome: 'rejected',
  })
  await fixture.native('turn/end', 'worker', from)
  await missing(join(cwd, 'denied.txt'))

  from = fixture.events.length
  await fixture.submit('worker', 'question')
  const question = await fixture.wait(event => event.type === 'question.requested' && event.sessionId === 'worker', from)
  const answerId = (question.payload as { requestId: string }).requestId
  await assert.rejects(fixture.runtime.request('personbot.v1.questions.answer', {
    generation: question.generation, requestId: answerId, result: { answers: [{ id: 'format', selected: ['Unknown'] }] },
  }), /unknown option/)
  await fixture.runtime.request('personbot.v1.questions.answer', {
    generation: question.generation, requestId: answerId, result: { answers: [{ id: 'format', selected: ['Markdown'] }] },
  })
  await fixture.native('turn/end', 'worker', from)
  assert.match(assistantText(await fixture.allEvents('worker')), /Markdown/)
  await fixture.close()
})

test('native question skip preserves an empty selection and completes the turn', { timeout: 60_000 }, async t => {
  const { home, cwd } = await workspace(t)
  const fixture = await start(home, cwd)
  t.after(() => fixture.runtime.close({ graceMs: 10_000 }))
  await fixture.create('question-skip', cwd)
  const from = fixture.events.length
  await fixture.submit('question-skip', 'question')
  const question = await fixture.wait(event => event.type === 'question.requested' && event.sessionId === 'question-skip', from)
  const result = { answers: [{ id: 'format', selected: [] }] }
  assert.deepEqual(await fixture.runtime.request('personbot.v1.questions.answer', {
    generation: question.generation, requestId: (question.payload as { requestId: string }).requestId, result,
  }), { accepted: true })
  await fixture.native('turn/end', 'question-skip', from)
  assert.deepEqual(JSON.parse(assistantText(await fixture.allEvents('question-skip'))), result)
  const snapshot = await fixture.runtime.request<Snapshot>('personbot.v1.snapshots.get', { sessionId: 'question-skip' })
  assert.deepEqual(snapshot.pending, [])
  await fixture.close()
})

test('native steer reaches the next step of an active tool turn exactly once', { timeout: 60_000 }, async t => {
  const { home, cwd } = await workspace(t)
  const fixture = await start(home, cwd)
  t.after(() => fixture.runtime.close({ graceMs: 10_000 }))
  const sessionId = 'steered'
  await fixture.create(sessionId, cwd, true)
  const from = fixture.events.length
  await fixture.submit(sessionId, 'approve steered.txt')
  const approval = await fixture.wait(event => event.type === 'approval.requested' && event.sessionId === sessionId, from)
  const requestId = (approval.payload as { requestId: string }).requestId
  await missing(join(cwd, 'steered.txt'))
  const identity = randomUUID()
  const steering = {
    commandId: `command-${identity}`, sessionId, messageId: `message-${identity}`,
    text: 'echo steered requirement', mode: 'steer',
  }
  await fixture.runtime.request('personbot.v1.messages.submit', steering)
  await fixture.runtime.request('personbot.v1.messages.submit', steering)
  const waiting = await fixture.runtime.request<Snapshot>('personbot.v1.snapshots.get', { sessionId })
  assert.equal(waiting.pending.some(decision => decision.requestId === requestId), true)
  assert.equal(waiting.logs[0]?.events.some(event => event.type === 'turn/end'), false)
  await missing(join(cwd, 'steered.txt'))

  await fixture.runtime.request('personbot.v1.approvals.resolve', {
    generation: approval.generation, requestId, outcome: 'allowed-once',
  })
  await fixture.native('turn/end', sessionId, from)
  assert.equal(await readFile(join(cwd, 'steered.txt'), 'utf8'), 'approved by personbot fixture\n')
  const events = await fixture.allEvents(sessionId)
  assert.equal(events.filter(event => event.type === 'user/message' && event.data.id === steering.messageId).length, 1)
  assert.equal(events.filter(event => event.type === 'turn/start').length, 1)
  assert.equal(events.filter(event => event.type === 'turn/end').length, 1)
  assert.equal(events.filter(event => event.type === 'step/start').length, 2)
  assert.equal(assistantText(events), 'steered requirement')
  await fixture.runtime.request('personbot.v1.messages.submit', steering)
  assert.deepEqual(await fixture.allEvents(sessionId), events)
  await fixture.close()
})

test('native restart preserves Session history and stable commands do not duplicate consumed input', { timeout: 60_000 }, async t => {
  const { home, cwd } = await workspace(t)
  let fixture = await start(home, cwd)
  t.after(() => fixture.runtime.close({ graceMs: 10_000 }))
  await fixture.create('persistent', cwd)
  const command = randomUUID()
  const from = fixture.events.length
  await fixture.submit('persistent', 'echo durable answer', command)
  await fixture.native('turn/end', 'persistent', from)
  const generation = fixture.generation
  await fixture.close()

  fixture = await start(home, cwd)
  assert.notEqual(fixture.generation, generation)
  await fixture.runtime.request('personbot.v1.sessions.resume', { sessionId: 'persistent' })
  await fixture.submit('persistent', 'echo durable answer', command)
  const events = await fixture.allEvents('persistent')
  assert.equal(events.filter(event => event.type === 'user/message' && event.data.id === `message-${command}`).length, 1)
  assert.match(assistantText(events), /durable answer/)
  await assert.rejects(fixture.submit('persistent', 'echo different payload', command), /different input/)
  const next = fixture.events.length
  await fixture.submit('persistent', 'echo follow-up after restart')
  await fixture.native('turn/end', 'persistent', next)
  const resumed = await fixture.allEvents('persistent')
  assert.match(assistantText(resumed), /follow-up after restart/)
  await fixture.close()
})

test('native snapshot pagination preserves complete ordered history and rejects invalid cursors', { timeout: 60_000 }, async t => {
  const { home, cwd } = await workspace(t)
  const fixture = await start(home, cwd)
  t.after(() => fixture.runtime.close({ graceMs: 10_000 }))
  const sessionId = 'paged-history'
  await fixture.create(sessionId, cwd)
  for (const text of ['first', 'second', 'third']) {
    const from = fixture.events.length
    await fixture.submit(sessionId, `echo ${text}`)
    await fixture.native('turn/end', sessionId, from)
  }
  assert.equal((await fixture.stop(sessionId)).confirmed, true)
  const complete = await fixture.runtime.request<Snapshot>('personbot.v1.snapshots.get', { sessionId, limit: 1000 })
  const original = complete.logs.find(log => log.sessionId === sessionId)
  assert.ok(original)
  assert.equal(original.hasMore, false)
  assert.ok(original.events.length > 6)
  assert.match(assistantText(original.events), /first[\s\S]*second[\s\S]*third/)

  const reassembled: NativeEvent[] = []
  const seen = new Set<number>()
  const limit = 3
  let fromSeq = 0
  let pages = 0
  for (;;) {
    const snapshot = await fixture.runtime.request<Snapshot>('personbot.v1.snapshots.get', { sessionId, fromSeq, limit })
    const page = snapshot.logs.find(log => log.sessionId === sessionId)
    assert.ok(page)
    assert.ok(page.events.length > 0 && page.events.length <= limit)
    assert.equal(page.nextSeq, fromSeq + page.events.length)
    for (const event of page.events) {
      assert.equal(seen.has(event.seq), false, `Repeated native event sequence ${event.seq}`)
      seen.add(event.seq)
      reassembled.push(event)
    }
    pages++
    assert.ok(pages <= original.events.length)
    assert.ok(page.nextSeq !== undefined && page.nextSeq > fromSeq)
    fromSeq = page.nextSeq
    if (!page.hasMore) break
  }
  assert.ok(pages > 1)
  assert.deepEqual(reassembled, original.events)
  const exhausted = await fixture.runtime.request<Snapshot>('personbot.v1.snapshots.get', { sessionId, fromSeq, limit })
  assert.deepEqual(exhausted.logs, [{ sessionId, events: [], nextSeq: fromSeq, hasMore: false }])

  for (const invalid of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(fixture.runtime.request('personbot.v1.snapshots.get', { sessionId, fromSeq: invalid }), {
      code: -32602, message: /fromSeq must be a non-negative safe integer/,
    })
  }
  for (const invalid of [-1, 0, 1.5, 1001, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(fixture.runtime.request('personbot.v1.snapshots.get', { sessionId, limit: invalid }), {
      code: -32602, message: /limit must be between 1 and 1000/,
    })
  }
  await assert.rejects(fixture.runtime.request('personbot.v1.snapshots.get', { fromSeq: 0, limit }), {
    code: -32602, message: /Log pagination requires sessionId/,
  })
  await fixture.close()
})

test('pending approval from a previous runtime generation cannot authorize a new tool call', { timeout: 60_000 }, async t => {
  const { home, cwd } = await workspace(t)
  let fixture = await start(home, cwd)
  t.after(() => fixture.runtime.close({ graceMs: 10_000 }))
  await fixture.create('approval-restart', cwd, true)
  const from = fixture.events.length
  await fixture.submit('approval-restart', 'approve stale.txt')
  const stale = await fixture.wait(event => event.type === 'approval.requested', from)
  await fixture.close()
  await missing(join(cwd, 'stale.txt'))
  fixture = await start(home, cwd)
  await assert.rejects(fixture.runtime.request('personbot.v1.approvals.resolve', {
    generation: stale.generation, requestId: (stale.payload as { requestId: string }).requestId, outcome: 'allowed-once',
  }), /expired runtime generation/)
  await fixture.runtime.request('personbot.v1.sessions.resume', { sessionId: 'approval-restart' })
  const snapshot = await fixture.runtime.request<Snapshot>('personbot.v1.snapshots.get', { sessionId: 'approval-restart' })
  assert.deepEqual(snapshot.pending, [])
  await missing(join(cwd, 'stale.txt'))
  const next = fixture.events.length
  await fixture.submit('approval-restart', 'approve fresh.txt')
  const current = await fixture.wait(event => event.type === 'approval.requested', next)
  assert.notEqual(current.generation, stale.generation)
  await fixture.runtime.request('personbot.v1.approvals.resolve', {
    generation: current.generation, requestId: (current.payload as { requestId: string }).requestId, outcome: 'allowed-once',
  })
  await fixture.native('turn/end', 'approval-restart', next)
  assert.equal(await readFile(join(cwd, 'fresh.txt'), 'utf8'), 'approved by personbot fixture\n')
  await fixture.close()
})

test('graceful shutdown preserves queued follow-up for explicit Session resume', { timeout: 60_000 }, async t => {
  const { home, cwd } = await workspace(t)
  let fixture = await start(home, cwd)
  t.after(() => fixture.runtime.close({ graceMs: 10_000 }))
  await fixture.create('queue', cwd)
  const from = fixture.events.length
  await fixture.submit('queue', 'hold')
  await fixture.native('request/context', 'queue', from)
  const queued = randomUUID()
  await fixture.submit('queue', 'echo queued after shutdown', queued)
  await fixture.close()

  fixture = await start(home, cwd)
  const next = fixture.events.length
  await fixture.runtime.request('personbot.v1.sessions.resume', { sessionId: 'queue' })
  await fixture.native('turn/end', 'queue', next)
  const events = await fixture.allEvents('queue')
  assert.equal(events.filter(event => event.type === 'user/message' && event.data.id === `message-${queued}`).length, 1)
  assert.match(assistantText(events), /queued after shutdown/)
  await fixture.close()
})

test('native child execution stops with its parent while another root remains running', { timeout: 60_000 }, async t => {
  const { home, cwd } = await workspace(t)
  const fixture = await start(home, cwd)
  t.after(() => fixture.runtime.close({ graceMs: 10_000 }))
  await Promise.all([fixture.create('parent', cwd, true), fixture.create('unrelated', cwd)])
  const from = fixture.events.length
  await fixture.submit('unrelated', 'hold')
  await fixture.native('request/context', 'unrelated', from)
  await fixture.submit('parent', 'child-hold')
  const child = await fixture.wait(event => event.type === 'session.status' && event.sessionId !== 'parent' &&
    event.sessionId !== 'unrelated' && (event.payload as { status: string }).status === 'running', from)
  assert.ok(child.sessionId)
  const stopped = await fixture.stop('parent')
  assert.equal(stopped.confirmed, true, stopped.errors.join('\n'))
  const statuses = fixture.events.filter(event => event.sessionId === child.sessionId && event.type === 'session.status')
  const lastStatus = statuses.at(-1)
  assert.ok(lastStatus)
  assert.equal((lastStatus.payload as { status: string }).status, 'idle')
  const listed = await fixture.runtime.request<{ sessions: { sessionId: string; status: string }[] }>('personbot.v1.sessions.list')
  assert.equal(listed.sessions.find(session => session.sessionId === 'unrelated')?.status, 'running')
  await fixture.stop('unrelated')
  await fixture.close()
})

test('native delegated child approval policy denies a write before App approval', { timeout: 60_000 }, async t => {
  const { home, cwd } = await workspace(t)
  const fixture = await start(home, cwd)
  t.after(() => fixture.runtime.close({ graceMs: 10_000 }))
  await fixture.create('parent', cwd, true)
  const from = fixture.events.length
  await fixture.submit('parent', 'child-approve')
  const child = await fixture.wait(event => event.type === 'session.status' && event.sessionId !== 'parent' &&
    (event.payload as { status: string }).status === 'running', from)
  assert.ok(child.sessionId)
  await fixture.native('turn/end', child.sessionId, from)
  await missing(join(cwd, 'child-approved.txt'))
  assert.equal(fixture.events.slice(from).some(event => event.type === 'approval.requested' && event.sessionId === child.sessionId), false)
  await fixture.stop('parent')
  await fixture.close()
})

test('native background OS process is terminated by Session stop', { timeout: 60_000 }, async t => {
  const { home, cwd } = await workspace(t)
  const fixture = await start(home, cwd)
  t.after(() => fixture.runtime.close({ graceMs: 10_000 }))
  await fixture.create('background', cwd, true)
  const marker = processMarker(cwd)
  await fixture.submit('background', 'background')
  const pid = await marker
  assert.notEqual(pid, process.pid)
  assert.notEqual(pid, fixture.runtime.pid)
  let remains = true
  t.after(() => {
    if (!remains) return
    try { process.kill(pid, 'SIGKILL') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  })
  process.kill(pid, 0)
  const stopped = await fixture.stop('background')
  assert.equal(stopped.confirmed, true, stopped.errors.join('\n'))
  await processExited(pid)
  remains = false
  await fixture.close()
})
