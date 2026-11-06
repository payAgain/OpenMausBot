import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import { IntegrationStore } from '../../personbot-integrations/src/index.ts'
import { parseRequest, type IntegrationSnapshot, type SourceRecord } from '../../personbot-protocol/src/index.ts'
import { SupervisorStore } from '../../personbot-supervisor/src/index.ts'
import { TaskRuntime } from '../src/tasks.ts'
import type { SessionRow } from '../src/store.ts'

const token = 't'.repeat(48)

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

async function fixture(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), 'personbot-event-effects-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  return {
    home,
    supervisor: () => new SupervisorStore(join(home, 'runtime', 'supervisor.sqlite')),
    integrations: () => new IntegrationStore(join(home, 'runtime', 'integrations.sqlite')),
  }
}

function source(store: IntegrationStore, id = 'source'): SourceRecord {
  return store.putSource({
    commandId: `create-${id}`, sourceId: id, name: 'Fixture source', originSessionId: 'main',
    goal: 'Check the provided source context', criteria: ['Provide measured evidence'],
    token, enabled: true, callbackMode: 'idempotent',
  })
}

function runtimeFixture(t: TestContext, home: string, stop?: () => Promise<{ confirmed: boolean; errors: string[] }>) {
  const sessions = new Map<string, SessionRow>([['main', { sessionId: 'main', conversationId: 'main', cwd: home }]])
  const ctx = { tools: { register: () => () => {}, guard: () => () => {} } } as unknown as Context
  const runtime = new TaskRuntime(ctx, home, {
    session: id => sessions.get(id),
    create: async task => { sessions.set(task.workerSessionId, { sessionId: task.workerSessionId, taskId: task.id, cwd: home }) },
    submit: async () => ({ state: 'queued' }),
    hasInput: () => false,
    stop: stop ?? (async () => ({ confirmed: true, errors: [] })),
    running: () => false,
    root: () => undefined,
    taskRoot: () => undefined,
    emit: () => {},
  })
  t.after(async () => { await runtime.close(); runtime.releaseGuard() })
  const snapshot = () => runtime.integrationCommand(parseRequest({
    jsonrpc: '2.0', id: 0, method: 'personbot.v1.integrations.snapshot', params: {},
  })) as IntegrationSnapshot
  return { runtime, snapshot }
}

test('retained events for paused tasks do not starve a later eligible Source', { timeout: 10_000 }, async t => {
  const space = await fixture(t)
  const supervisor = space.supervisor()
  const integrations = space.integrations()
  source(integrations)
  source(integrations, 'healthy')
  for (let index = 0; index < 64; index++) {
    const task = supervisor.create({
      commandId: `task-create-${index}`, taskId: `paused-${index}`, originSessionId: 'main',
      goal: 'Wait for an owner decision', criteria: ['Do not automatically resume'],
    })
    supervisor.control({ commandId: `pause-${index}`, taskId: task.id, expectedRevision: task.revision, action: 'pause' })
    const stop = supervisor.pendingEffects().find(effect => effect.taskId === task.id && effect.kind === 'stop')!
    supervisor.finishStop(stop.id, true, [])
    integrations.putSubscription({
      commandId: `subscribe-${index}`, subscriptionId: `subscription-${index}`,
      sourceId: 'source', threadId: `thread-${index}`, taskId: task.id, enabled: true,
    })
    integrations.receive({ sourceId: 'source', eventId: `held-${index}`, threadId: `thread-${index}`, text: 'Retained external data' })
  }
  integrations.receive({ sourceId: 'healthy', eventId: 'eligible', threadId: 'healthy-thread', text: 'Eligible external data' })
  supervisor.close()
  integrations.close()
  const { runtime, snapshot } = runtimeFixture(t, space.home)
  runtime.start()
  const deadline = Date.now() + 2500
  while (Date.now() < deadline && !runtime.snapshot().tasks.some(task => task.id.startsWith('evt-'))) await delay(20)
  assert.equal(runtime.snapshot().tasks.filter(task => task.id.startsWith('evt-')).length, 1,
    'A full prefix of paused event intents must not monopolize all Source dispatch')
  assert.equal(snapshot().triggers.find(trigger => trigger.eventId === 'eligible')?.status, 'delivered')
  assert.equal(runtime.snapshot().tasks.filter(task => task.stage === 'paused').length, 64)
})

for (const disabled of ['source', 'subscription'] as const) {
  test(`disabling a ${disabled} during native drain does not wake its waiting task`, { timeout: 10_000 }, async t => {
    const space = await fixture(t)
    const supervisor = space.supervisor()
    const integrations = space.integrations()
    source(integrations)
    const task = supervisor.create({
      commandId: 'create-task', taskId: 'waiting-task', originSessionId: 'main',
      goal: 'Wait for an event', criteria: ['Inspect the event without changing authorization'],
    })
    supervisor.markDispatched(`dispatch:${task.currentExecutionId}`)
    supervisor.report(task.id, task.currentExecutionId!, { outcome: 'waiting_event', summary: 'Waiting for input', evidence: [] })
    supervisor.finishStop(`seal:${task.currentExecutionId}`, true, [])
    integrations.putSubscription({
      commandId: 'subscribe', subscriptionId: 'subscription', sourceId: 'source', threadId: 'thread', taskId: task.id, enabled: true,
    })
    integrations.receive({ sourceId: 'source', eventId: 'waiting-event', threadId: 'thread', text: 'External source data' })
    supervisor.close()
    integrations.close()
    const enteredStop = deferred<void>()
    const stopped = deferred<{ confirmed: boolean; errors: string[] }>()
    const { runtime, snapshot } = runtimeFixture(t, space.home, async () => {
      enteredStop.resolve()
      return stopped.promise
    })
    runtime.start()
    await enteredStop.promise
    runtime.integrationCommand(parseRequest({
      jsonrpc: '2.0', id: 0,
      method: disabled === 'source' ? 'personbot.v1.sources.put' : 'personbot.v1.subscriptions.put',
      params: disabled === 'source' ? {
        commandId: 'disable-source', sourceId: 'source', name: 'Fixture source', originSessionId: 'main',
        goal: 'Check the provided source context', criteria: ['Provide measured evidence'],
        enabled: false, callbackMode: 'idempotent', expectedRevision: 1,
      } : {
        commandId: 'disable-subscription', subscriptionId: 'subscription', sourceId: 'source',
        threadId: 'thread', taskId: task.id, enabled: false, expectedRevision: 1,
      },
    }))
    stopped.resolve({ confirmed: true, errors: [] })
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(runtime.snapshot().executions.length, 1, 'A revoked event binding must remain retained after its native stop resolves')
    assert.equal(runtime.snapshot().tasks[0]?.stage, 'waiting_event')
    assert.equal(snapshot().triggers[0]?.status, 'pending')
  })
}

test('shutdown while an event is draining leaves the inbox durable without allocating a new execution', { timeout: 10_000 }, async t => {
  const space = await fixture(t)
  const supervisor = space.supervisor()
  const integrations = space.integrations()
  source(integrations)
  const task = supervisor.create({
    commandId: 'create-task', taskId: 'shutdown-task', originSessionId: 'main',
    goal: 'Wait for an event', criteria: ['Keep pending input across shutdown'],
  })
  supervisor.markDispatched(`dispatch:${task.currentExecutionId}`)
  supervisor.report(task.id, task.currentExecutionId!, { outcome: 'waiting_event', summary: 'Waiting for input', evidence: [] })
  supervisor.finishStop(`seal:${task.currentExecutionId}`, true, [])
  integrations.putSubscription({
    commandId: 'subscribe', subscriptionId: 'subscription', sourceId: 'source', threadId: 'thread', taskId: task.id, enabled: true,
  })
  integrations.receive({ sourceId: 'source', eventId: 'shutdown-event', threadId: 'thread', text: 'External source data' })
  supervisor.close()
  integrations.close()
  const enteredStop = deferred<void>()
  const stopped = deferred<{ confirmed: boolean; errors: string[] }>()
  const { runtime } = runtimeFixture(t, space.home, async () => {
    enteredStop.resolve()
    return stopped.promise
  })
  runtime.start()
  await enteredStop.promise
  const closing = runtime.close()
  stopped.resolve({ confirmed: true, errors: [] })
  await closing
  const savedTasks = space.supervisor()
  const savedEvents = space.integrations()
  try {
    assert.equal(savedTasks.snapshot().executions.length, 1)
    assert.equal(savedTasks.getTask(task.id)?.stage, 'waiting_event')
    assert.equal(savedEvents.snapshot().triggers[0]?.status, 'pending')
    assert.equal(savedEvents.pendingEvents().length, 1)
  } finally {
    savedTasks.close()
    savedEvents.close()
  }
})
