import assert from 'node:assert/strict'
import { fork, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { watch } from 'node:fs'
import { access, appendFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { EVENT_METHOD, type RuntimeEvent } from '../../personbot-protocol/src/index.ts'
import { spawnRuntime, type RuntimeHost } from '../../personbot-runtime-host/src/index.ts'
import { prepareRuntime } from '../src/launch.ts'
import { RuntimeStore } from '../src/store.ts'

interface NativeEvent {
  type: string
  seq: number
  data: {
    id?: string
    target?: string
    removedCount?: number
    inserted?: { id: string }[]
    message?: { content: { type: string; text?: string }[] }
  }
}

interface SessionView {
  sessionId: string
  status: string
  pendingStops: string[]
}

interface Snapshot {
  sessions: SessionView[]
  logs: { sessionId: string; events: NativeEvent[]; nextSeq: number; hasMore: boolean }[]
}

interface IsolatedWorkspace {
  home: string
  cwd: string
  marker: string
  hosts: Set<RuntimeHost>
  processes: Set<LeaseProcess>
}

class RecoveryRuntime {
  readonly host: RuntimeHost
  readonly events: RuntimeEvent[] = []
  private readonly observers = new Set<() => void>()

  constructor(host: RuntimeHost) {
    this.host = host
    host.onNotification(notification => {
      if (notification.method !== EVENT_METHOD) return
      this.events.push(notification.params as RuntimeEvent)
      for (const observer of this.observers) observer()
    })
  }

  create(sessionId: string, cwd: string) {
    return this.host.request('personbot.v1.sessions.create', {
      sessionId, cwd, conversationId: `chat-${sessionId}`,
    })
  }

  submit(sessionId: string, text: string, identity: string) {
    return this.host.request<{ state: string }>('personbot.v1.messages.submit', {
      commandId: `command-${identity}`, sessionId, messageId: `message-${identity}`, text, mode: 'followup',
    })
  }

  turnEnded(sessionId: string, from = 0, count = 1): Promise<void> {
    return new Promise((resolve, reject) => {
      const check = () => {
        if (this.events.slice(from).filter(event => event.type === 'session.event' && event.sessionId === sessionId &&
          (event.payload as { event: NativeEvent }).event.type === 'turn/end').length >= count) finish()
      }
      const timer = setTimeout(() => {
        const observed = this.events.slice(from).map(event => event.type === 'session.event'
          ? (event.payload as { event: NativeEvent }).event.type : event.type)
        finish(new Error(`Expected ${count} native turn endings; observed ${observed.join(', ')}.\n${this.host.stderrTail}`))
      }, 15_000)
      const finish = (error?: Error) => {
        clearTimeout(timer)
        this.observers.delete(check)
        if (error) reject(error)
        else resolve()
      }
      this.observers.add(check)
      void this.host.closed.then(exit => {
        if (this.observers.has(check)) finish(new Error(`Runtime exited before turn ended: ${JSON.stringify(exit)}`))
      })
      check()
    })
  }

  async allEvents(sessionId: string): Promise<NativeEvent[]> {
    const events: NativeEvent[] = []
    let fromSeq = 0
    for (;;) {
      const snapshot = await this.host.request<Snapshot>('personbot.v1.snapshots.get', {
        sessionId, fromSeq, limit: 100,
      })
      const log = snapshot.logs.find(entry => entry.sessionId === sessionId)
      assert.ok(log)
      events.push(...log.events)
      if (!log.hasMore) return events
      assert.ok(log.nextSeq > fromSeq)
      fromSeq = log.nextSeq
    }
  }

  async close(): Promise<void> {
    const exit = await this.host.close({ graceMs: 10_000, terminateMs: 1_000 })
    assert.equal(exit.code, 0, `Runtime did not shut down cleanly: ${JSON.stringify(exit)}\n${this.host.stderrTail}`)
  }
}

async function workspace(t: TestContext): Promise<IsolatedWorkspace> {
  const directory = await mkdtemp(join(tmpdir(), 'personbot-recovery-test-'))
  const home = join(directory, 'home')
  const cwd = join(directory, 'workspace')
  await Promise.all([mkdir(home), mkdir(cwd)])
  const hosts = new Set<RuntimeHost>()
  const processes = new Set<LeaseProcess>()
  t.after(async () => {
    for (const entry of processes) {
      if (entry.child.exitCode === null && entry.child.signalCode === null) entry.child.kill('SIGKILL')
    }
    await Promise.all([...processes].map(entry => entry.closed))
    await Promise.all([...hosts].map(host => host.close({ graceMs: 10_000 })))
    await rm(directory, { recursive: true, force: true })
  })
  return { home, cwd, marker: join(cwd, 'claimed-input.json'), hosts, processes }
}

function isolatedEnv(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    TEMP: process.env.TEMP ?? tmpdir(),
    SystemRoot: process.env.SystemRoot,
    LANG: 'en_US.UTF-8',
    DSH_PRIMARY_RUNTIME: '',
    DSH_TELEMETRY_DISABLED: '1',
  }
}

async function start(fixture: IsolatedWorkspace, pause = false): Promise<RecoveryRuntime> {
  const options = await prepareRuntime({
    home: fixture.home, workspace: fixture.cwd, provider: 'personbot-fixture', model: 'fixture', fixture: true,
  })
  if (pause) {
    const plugin = new URL('./recovery-fixture.ts', import.meta.url).href
    await appendFile(join(fixture.home, 'dsh', 'profiles', 'personbot', 'cordis.patch.yml'),
      `- insert:\n    - id: personbot-recovery-fixture\n      name: ${JSON.stringify(plugin)}\n`)
  }
  const runtime = new RecoveryRuntime(spawnRuntime({
    ...options,
    env: {
      ...isolatedEnv(fixture.home),
      DSH_HOME: options.env.DSH_HOME,
      ...(pause ? { PERSONBOT_RECOVERY_MARKER: fixture.marker } : {}),
    },
    defaultTimeoutMs: 25_000,
  }))
  fixture.hosts.add(runtime.host)
  try {
    await runtime.host.request('personbot.v1.initialize', { protocolVersion: 1 })
    return runtime
  } catch (error) {
    await runtime.host.close({ shutdownMethod: null, graceMs: 0 })
    throw new Error(`Could not initialize recovery fixture.\n${runtime.host.stderrTail}`, { cause: error })
  }
}

async function marker(path: string): Promise<{ sessionId: string; messageIds: string[] }> {
  return new Promise((resolve, reject) => {
    const watcher = watch(join(path, '..'), () => { void inspect() })
    const timer = setTimeout(() => finish(new Error('Native pre-step did not reach the recovery barrier')), 15_000)
    const finish = (error?: Error, content?: { sessionId: string; messageIds: string[] }) => {
      clearTimeout(timer)
      watcher.close()
      if (error) reject(error)
      else resolve(content!)
    }
    const inspect = async () => {
      try {
        const text = await readFile(path, 'utf8')
        if (text) finish(undefined, JSON.parse(text) as { sessionId: string; messageIds: string[] })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') finish(error as Error)
      }
    }
    watcher.once('error', error => finish(error))
    void inspect()
  })
}

function text(events: NativeEvent[]): string {
  return events.filter(event => event.type === 'assistant/message')
    .flatMap(event => event.data.message?.content ?? [])
    .filter(block => block.type === 'text').map(block => block.text).join('\n')
}

for (const mode of ['crash', 'shutdown'] as const) {
  test(`claimed input survives native ${mode} before user/message is committed`, { timeout: 60_000 }, async t => {
    const isolated = await workspace(t)
    let runtime = await start(isolated, true)
    const sessionId = `claim-${mode}`
    const identity = randomUUID()
    const laterIdentity = randomUUID()
    await runtime.create(sessionId, isolated.cwd)
    const entered = marker(isolated.marker)
    const [receipt, barrier] = await Promise.all([runtime.submit(sessionId, 'echo claimed-input', identity), entered])
    assert.equal(receipt.state, 'queued')
    assert.deepEqual(barrier, { sessionId, messageIds: [`message-${identity}`] })
    assert.equal((await runtime.submit(sessionId, 'echo later-input', laterIdentity)).state, 'queued')
    const before = await runtime.allEvents(sessionId)
    const mutations = before.filter(event => event.type === 'agent/inbox/spliced')
    assert.ok(mutations.some(event => event.data.inserted?.some(message => message.id === `message-${identity}`)))
    assert.ok(mutations.some(event => event.data.removedCount === 1 && event.data.inserted?.length === 0))
    assert.equal(before.some(event => event.type === 'user/message' && event.data.id === `message-${identity}`), false)

    if (mode === 'crash') {
      assert.ok(runtime.host.pid)
      process.kill(runtime.host.pid, 'SIGKILL')
      assert.equal((await runtime.host.closed).signal, 'SIGKILL')
    } else {
      await runtime.close()
    }
    runtime = await start(isolated)
    const from = runtime.events.length
    await runtime.host.request('personbot.v1.sessions.resume', { sessionId })
    await runtime.turnEnded(sessionId, from, 2)
    const after = await runtime.allEvents(sessionId)
    assert.equal(after.filter(event => event.type === 'user/message' && event.data.id === `message-${identity}`).length, 1)
    assert.equal(after.filter(event => event.type === 'user/message' && event.data.id === `message-${laterIdentity}`).length, 1)
    assert.equal(text(after), 'claimed-input\nlater-input')
    assert.equal((await runtime.submit(sessionId, 'echo claimed-input', identity)).state, 'queued')
    await runtime.close()
  })
}

test('retrying an old input cannot reopen a Session with an unfinished durable Stop', { timeout: 60_000 }, async t => {
  const isolated = await workspace(t)
  let runtime = await start(isolated)
  const sessionId = 'stop-retry'
  const identity = randomUUID()
  const stopCommand = randomUUID()
  await runtime.create(sessionId, isolated.cwd)
  const from = runtime.events.length
  await runtime.submit(sessionId, 'echo before-stop', identity)
  await runtime.turnEnded(sessionId, from)
  await runtime.close()
  const store = new RuntimeStore(join(isolated.home, 'runtime', 'personbot.sqlite'))
  try {
    store.beginStop(stopCommand, sessionId)
    assert.deepEqual(store.pendingStops(sessionId), [stopCommand])
  } finally {
    store.close()
  }
  runtime = await start(isolated)
  const before = await runtime.allEvents(sessionId)
  const eventOffset = runtime.events.length
  assert.equal((await runtime.submit(sessionId, 'echo before-stop', identity)).state, 'cancelled')
  const list = await runtime.host.request<{ sessions: SessionView[] }>('personbot.v1.sessions.list')
  assert.equal(list.sessions.find(session => session.sessionId === sessionId)?.status, 'closed')
  assert.deepEqual(list.sessions.find(session => session.sessionId === sessionId)?.pendingStops, [stopCommand])
  assert.deepEqual(await runtime.allEvents(sessionId), before)
  assert.equal(runtime.events.slice(eventOffset).some(event => event.sessionId === sessionId), false)
  await assert.rejects(runtime.host.request('personbot.v1.sessions.resume', { sessionId }), /unfinished stop/)
  const stopped = await runtime.host.request<{ confirmed: boolean }>('personbot.v1.sessions.stop', {
    sessionId, commandId: stopCommand,
  })
  assert.equal(stopped.confirmed, true)
  await runtime.close()
})

test('a materialized Session refuses to replace missing native history', { timeout: 60_000 }, async t => {
  const isolated = await workspace(t)
  let runtime = await start(isolated)
  const sessionId = 'missing-history'
  await runtime.create(sessionId, isolated.cwd)
  const from = runtime.events.length
  await runtime.submit(sessionId, 'echo original-context', randomUUID())
  await runtime.turnEnded(sessionId, from)
  await runtime.close()
  const store = new RuntimeStore(join(isolated.home, 'runtime', 'personbot.sqlite'))
  try {
    assert.equal(store.isNativeReady(sessionId), true)
  } finally {
    store.close()
  }
  const dshHome = join(isolated.home, 'dsh')
  const entries = await readdir(dshHome, { recursive: true, withFileTypes: true })
  const directories = entries.filter(entry => entry.isDirectory() && entry.name === sessionId)
  assert.equal(directories.length, 1)
  const nativeDirectory = join(directories[0]!.parentPath, sessionId)
  await rm(nativeDirectory, { recursive: true })

  runtime = await start(isolated)
  await assert.rejects(runtime.host.request('personbot.v1.sessions.resume', { sessionId }), /Native history is missing/)
  await assert.rejects(runtime.create(sessionId, isolated.cwd), /Native history is missing/)
  await assert.rejects(access(nativeDirectory), { code: 'ENOENT' })
  const listed = await runtime.host.request<{ sessions: SessionView[] }>('personbot.v1.sessions.list')
  assert.equal(listed.sessions.find(session => session.sessionId === sessionId)?.status, 'closed')
  await runtime.close()
})

interface LeaseProcess {
  child: ChildProcess
  result: Promise<{ state: string; message?: string }>
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
}

function leaseProcess(path: string, home: string): LeaseProcess {
  const child = fork(fileURLToPath(new URL('./recovery-fixture.ts', import.meta.url)), ['lease', path], {
    env: isolatedEnv(home), stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  const result = new Promise<{ state: string; message?: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Lease process did not report ownership')), 10_000)
    child.once('message', message => {
      clearTimeout(timer)
      resolve(message as { state: string; message?: string })
    })
    child.once('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    void closed.then(exit => {
      clearTimeout(timer)
      reject(new Error(`Lease process exited before reporting ownership: ${JSON.stringify(exit)}`))
    })
  })
  return { child, result, closed }
}

test('kernel runtime lease excludes concurrent processes and releases after a holder crash', { timeout: 30_000 }, async t => {
  const isolated = await workspace(t)
  const path = join(isolated.home, 'runtime.lock')
  await writeFile(path, '')
  const original = await stat(path, { bigint: true })
  const spawn = () => {
    const entry = leaseProcess(path, isolated.home)
    isolated.processes.add(entry)
    return entry
  }
  const holder = spawn()
  assert.equal((await holder.result).state, 'acquired')
  const contenders = Array.from({ length: 4 }, spawn)
  const results = await Promise.all(contenders.map(entry => entry.result))
  for (const result of results) {
    assert.equal(result.state, 'rejected')
    assert.match(result.message ?? '', /already running/)
  }
  assert.ok(holder.child.pid)
  process.kill(holder.child.pid, 'SIGKILL')
  assert.equal((await holder.closed).signal, 'SIGKILL')
  const replacement = spawn()
  assert.equal((await replacement.result).state, 'acquired')
  const current = await stat(path, { bigint: true })
  assert.equal(current.ino, original.ino)
  assert.equal(current.dev, original.dev)
  replacement.child.send('release')
  assert.equal((await replacement.closed).code, 0)
})
