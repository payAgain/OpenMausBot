import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SupervisorStore } from '../../personbot-supervisor/src/index.ts'
import { TaskRuntime } from '../src/tasks.ts'
import type { InputParams, SessionRow } from '../src/store.ts'

test('shutdown keeps rejecting tool effects until native execution trees have drained', async t => {
  const home = await mkdtemp(join(tmpdir(), 'personbot-task-shutdown-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  let check: ((exec: { agent?: Agent }) => string | undefined) | undefined
  let released = false
  const ctx = {
    tools: {
      register: () => () => {},
      guard: (callback: typeof check) => {
        check = callback
        return () => { released = true }
      },
    },
  } as unknown as Context
  const runtime = new TaskRuntime(ctx, home, {
    session: () => undefined,
    create: async () => {},
    submit: async () => {},
    hasInput: () => false,
    stop: async () => ({ confirmed: true, errors: [] }),
    running: () => false,
    root: () => undefined,
    taskRoot: () => undefined,
    emit: () => {},
  })
  const agent = { id: 'worker-fixture' } as Agent
  assert.equal(check?.({ agent }), undefined)
  await runtime.close()
  assert.equal(released, false)
  assert.match(check?.({ agent }) ?? '', /shutting down/)
  assert.doesNotThrow(() => runtime.waiting(agent.id, false))
  runtime.releaseGuard()
  assert.equal(released, true)
})

test('a delayed report seal cannot stop a newer execution of the same worker Session', async t => {
  const home = await mkdtemp(join(tmpdir(), 'personbot-task-effects-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const seed = new SupervisorStore(join(home, 'runtime', 'supervisor.sqlite'))
  const task = seed.create({
    commandId: 'create-task', taskId: 'fenced-task', originSessionId: 'main',
    goal: 'Verify execution fencing', criteria: ['Only the current execution may be stopped'],
  })
  seed.markDispatched(`dispatch:${task.currentExecutionId}`)
  const reported = seed.report(task.id, task.currentExecutionId!, {
    outcome: 'waiting_event', summary: 'Waiting for explicit continuation', evidence: [],
  })
  seed.control({
    commandId: 'pause-task', taskId: task.id, expectedRevision: reported.revision, action: 'pause',
  })
  const stop = seed.pendingEffects().find(effect => effect.kind === 'stop' && effect.payload.seal !== true)!
  seed.finishStop(stop.id, true, [])
  const stopped = seed.getTask(task.id)!
  const resumed = seed.control({
    commandId: 'resume-task', taskId: task.id, expectedRevision: stopped.revision, action: 'resume',
  })
  assert.equal(seed.getEffect(`seal:${task.currentExecutionId}`)?.state, 'pending')
  seed.close()
  let stops = 0
  const ctx = { tools: { register: () => () => {}, guard: () => () => {} } } as unknown as Context
  const runtime = new TaskRuntime(ctx, home, {
    session: id => ({ sessionId: id, taskId: task.id, cwd: home }),
    create: async () => {},
    submit: async () => ({ state: 'queued' }),
    hasInput: () => false,
    stop: async () => { stops++; return { confirmed: true, errors: [] } },
    running: () => false,
    root: () => undefined,
    taskRoot: () => undefined,
    emit: () => {},
  })
  t.after(async () => { await runtime.close(); runtime.releaseGuard() })
  runtime.start()
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(runtime.snapshot().tasks[0]?.currentExecutionId, resumed.currentExecutionId)
  assert.equal(runtime.snapshot().tasks[0]?.stage, 'working')
  assert.equal(stops, 1, 'Only the new dispatch may drain the previous native root before opening it')
})

test('a queued supplement reaches the first worker once through its own durable steer effect', async t => {
  const home = await mkdtemp(join(tmpdir(), 'personbot-task-supplement-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const seed = new SupervisorStore(join(home, 'runtime', 'supervisor.sqlite'))
  const task = seed.create({
    commandId: 'create-task', taskId: 'supplement-task', originSessionId: 'main',
    goal: 'Produce a checked report', criteria: ['Use the requested output format'],
  })
  const command = {
    commandId: 'supplement-before-start', taskId: task.id, expectedRevision: task.revision,
    action: 'supplement' as const, text: 'Include the original measurements',
  }
  seed.control(command)
  seed.control(command)
  seed.close()
  const inputs: InputParams[] = []
  const sessions = new Map<string, SessionRow>()
  const ctx = { tools: { register: () => () => {}, guard: () => () => {} } } as unknown as Context
  const runtime = new TaskRuntime(ctx, home, {
    session: id => sessions.get(id),
    create: async task => { sessions.set(task.workerSessionId, { sessionId: task.workerSessionId, taskId: task.id, cwd: home }) },
    submit: async input => { inputs.push(input); return { state: 'queued' } },
    hasInput: () => false,
    stop: async () => ({ confirmed: true, errors: [] }),
    running: () => false,
    root: () => undefined,
    taskRoot: () => undefined,
    emit: () => {},
  })
  t.after(async () => { await runtime.close(); runtime.releaseGuard() })
  runtime.start()
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(inputs.length, 2)
  assert.equal(inputs[0]?.mode, 'followup')
  assert.doesNotMatch(inputs[0]!.text, /Include the original measurements/)
  assert.equal(inputs[1]?.mode, 'steer')
  assert.match(inputs[1]!.text, /Include the original measurements/)
  assert.equal(inputs[1]?.sessionId, task.workerSessionId)
  assert.equal(runtime.snapshot().tasks[0]?.currentExecutionId, task.currentExecutionId)
  assert.equal(runtime.snapshot().tasks[0]?.messages?.length, 1)
})

test('a tool-valid report can include forty textual evidence entries and forty owned artifacts', async t => {
  const home = await mkdtemp(join(tmpdir(), 'personbot-task-report-capacity-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const seed = new SupervisorStore(join(home, 'runtime', 'supervisor.sqlite'))
  const task = seed.create({
    commandId: 'create-report', taskId: 'report-capacity', originSessionId: 'main',
    goal: 'Deliver a report with supporting files', criteria: ['Every artifact belongs to this execution'],
  })
  seed.close()
  const tools = new Map<string, { execute(args: unknown, exec: unknown): Promise<unknown> }>()
  const ctx = { tools: {
    register: (tool: { name: string; execute(args: unknown, exec: unknown): Promise<unknown> }) => { tools.set(tool.name, tool); return () => {} },
    guard: () => () => {},
  } } as unknown as Context
  const artifacts = Array.from({ length: 40 }, (_, index) => `artifact-${index}`)
  let validated = false
  const runtime = new TaskRuntime(ctx, home, {
    session: id => ({ sessionId: id, taskId: task.id, cwd: home }),
    create: async () => {},
    submit: async () => ({ state: 'queued' }),
    hasInput: () => false,
    stop: async () => ({ confirmed: true, errors: [] }),
    running: () => false,
    root: agent => agent.id,
    taskRoot: agent => agent.id,
    emit: () => {},
    artifacts: (taskId, executionId, ids) => {
      assert.equal(taskId, task.id)
      assert.equal(executionId, task.currentExecutionId)
      assert.deepEqual(ids, artifacts)
      validated = true
    },
  })
  t.after(async () => { await runtime.close(); runtime.releaseGuard() })
  runtime.start()
  await new Promise<void>(resolve => setImmediate(resolve))
  await tools.get('personbot_task_report')!.execute({
    executionId: task.currentExecutionId, outcome: 'review', summary: 'All supporting files are published.',
    evidence: Array.from({ length: 40 }, (_, index) => `Measured result ${index}`), artifactIds: artifacts,
  }, { signal: new AbortController().signal, agent: { id: task.workerSessionId }, concludeTurn() {} })
  assert.equal(validated, true)
  const reported = runtime.snapshot().tasks[0]!
  assert.equal(reported.stage, 'awaiting_review')
  assert.equal(reported.report?.evidence.length, 80)
  assert.deepEqual(reported.report?.artifactIds, artifacts)
})
