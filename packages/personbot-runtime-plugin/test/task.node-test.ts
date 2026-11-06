import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  EVENT_METHOD,
  type RuntimeEvent,
  type TaskAction,
  type TaskRecord,
  type TaskSnapshot,
} from '../../personbot-protocol/src/index.ts';
import { spawnRuntime, type RuntimeHost } from '../../personbot-runtime-host/src/index.ts';
import { prepareRuntime } from '../src/launch.ts';

interface NativeEvent {
  type: string;
  seq: number;
  data: {
    id?: string;
    source?: { kind: string };
    content?: { type: string; text?: string }[];
    message?: { content: { type: string; text?: string }[] };
  };
}

interface NativeSnapshot {
  logs: { sessionId: string; events: NativeEvent[]; nextSeq: number; hasMore: boolean }[];
}

class TaskFixture {
  readonly events: RuntimeEvent[] = [];
  readonly runtime: RuntimeHost;

  constructor(runtime: RuntimeHost) {
    this.runtime = runtime;
    runtime.onNotification(notification => {
      if (notification.method === EVENT_METHOD) this.events.push(notification.params as RuntimeEvent);
    });
  }

  list(originSessionId?: string): Promise<TaskSnapshot> {
    return this.runtime.request('personbot.v1.tasks.list', originSessionId ? { originSessionId } : {});
  }

  create(goal: string, taskId = randomUUID(), commandId = randomUUID()): Promise<TaskRecord> {
    return this.runtime.request('personbot.v1.tasks.create', {
      commandId,
      taskId,
      originSessionId: 'main',
      goal,
      criteria: ['Fixture evidence is present'],
      context: 'Keep this explicit context across executions.',
    });
  }

  control(task: TaskRecord, action: TaskAction, text?: string, commandId = randomUUID()): Promise<TaskRecord> {
    return this.runtime.request('personbot.v1.tasks.control', {
      commandId,
      taskId: task.id,
      expectedRevision: task.revision,
      action,
      ...(text === undefined ? {} : { text }),
    });
  }

  submit(text: string, sessionId = 'main'): Promise<unknown> {
    const identity = randomUUID();
    return this.runtime.request('personbot.v1.messages.submit', {
      commandId: `command-${identity}`,
      messageId: `message-${identity}`,
      sessionId,
      text,
      mode: 'followup',
    });
  }

  async until<T>(read: () => Promise<T>, matches: (value: T) => boolean, description: string): Promise<T> {
    const deadline = Date.now() + 15_000;
    let latest: T | undefined;
    while (Date.now() < deadline) {
      latest = await read();
      if (matches(latest)) return latest;
      await delay(25);
    }
    assert.fail(`${description}; last value ${JSON.stringify(latest)}\n${this.runtime.stderrTail}`);
  }

  async task(taskId: string, stage?: TaskRecord['stage'], lifecycle?: TaskRecord['lifecycle']): Promise<TaskRecord> {
    const snapshot = await this.until(
      () => this.list(),
      value => value.tasks.some(task => task.id === taskId
        && (stage === undefined || task.stage === stage)
        && (lifecycle === undefined || task.lifecycle === lifecycle)),
      `Task ${taskId} did not reach ${stage ?? lifecycle ?? 'stored'}`,
    );
    return snapshot.tasks.find(task => task.id === taskId)!;
  }

  async settled(taskId: string, stage: TaskRecord['stage']): Promise<TaskRecord> {
    const snapshot = await this.until(
      () => this.list(),
      value => {
        const task = value.tasks.find(row => row.id === taskId);
        return task?.stage === stage
          && task.stopState !== 'pending'
          && value.executions.find(execution => execution.id === task.currentExecutionId)?.status === 'ended';
      },
      `Task ${taskId} did not settle in ${stage}`,
    );
    return snapshot.tasks.find(task => task.id === taskId)!;
  }

  async native(type: string, sessionId: string, from = 0): Promise<RuntimeEvent> {
    await this.until(
      async () => this.events.slice(from),
      events => events.some(event => event.type === 'session.event' && event.sessionId === sessionId
        && (event.payload as { event: NativeEvent }).event.type === type),
      `${sessionId} did not emit ${type}`,
    );
    return this.events.slice(from).find(event => event.type === 'session.event' && event.sessionId === sessionId
      && (event.payload as { event: NativeEvent }).event.type === type)!;
  }

  async pending(kind: 'approval' | 'question', sessionId: string): Promise<RuntimeEvent> {
    const type = kind === 'approval' ? 'approval.requested' : 'question.requested';
    await this.until(
      async () => this.events,
      events => events.some(event => event.type === type && event.sessionId === sessionId),
      `${sessionId} did not request ${kind}`,
    );
    return this.events.find(event => event.type === type && event.sessionId === sessionId)!;
  }

  async history(sessionId: string): Promise<NativeEvent[]> {
    const events: NativeEvent[] = [];
    let fromSeq = 0;
    for (;;) {
      const snapshot = await this.runtime.request<NativeSnapshot>('personbot.v1.snapshots.get', {
        sessionId, fromSeq, limit: 100,
      });
      const log = snapshot.logs.find(entry => entry.sessionId === sessionId);
      assert.ok(log, `Missing native log for ${sessionId}`);
      events.push(...log.events);
      if (!log.hasMore) return events;
      assert.ok(log.nextSeq > fromSeq);
      fromSeq = log.nextSeq;
    }
  }

  async close(): Promise<void> {
    const exit = await this.runtime.close({ graceMs: 10_000 });
    assert.equal(exit.code, 0, JSON.stringify(exit));
  }
}

async function fixtureSpace(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'personbot-task-test-'));
  const cwd = join(directory, 'workspace');
  const home = join(directory, 'home');
  await mkdir(cwd);
  await mkdir(home);
  const hosts = new Set<RuntimeHost>();
  t.after(async () => {
    await Promise.all([...hosts].map(host => host.close({ graceMs: 10_000 })));
    await rm(directory, { recursive: true, force: true });
  });
  const start = async (createMain = true): Promise<TaskFixture> => {
    const options = await prepareRuntime({
      home, workspace: cwd, provider: 'personbot-fixture', model: 'fixture', fixture: true,
    });
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
    };
    const runtime = spawnRuntime({ ...options, env, defaultTimeoutMs: 25_000 });
    hosts.add(runtime);
    const fixture = new TaskFixture(runtime);
    await runtime.request('personbot.v1.initialize', { protocolVersion: 1 });
    if (createMain) {
      await runtime.request('personbot.v1.sessions.create', {
        sessionId: 'main', conversationId: 'conversation-main', cwd,
      });
    }
    return fixture;
  };
  return { home, cwd, directory, start };
}

function textOf(events: NativeEvent[]): string {
  return events.filter(event => event.type === 'assistant/message')
    .flatMap(event => event.data.message?.content ?? [])
    .filter(block => block.type === 'text').map(block => block.text).join('\n');
}

function workerInputs(events: NativeEvent[]): NativeEvent[] {
  return events.filter(event => event.type === 'user/message' && event.data.source?.kind === 'user');
}

test('chat creates an independent task and stays responsive while its worker runs', { timeout: 60_000 }, async t => {
  const { start } = await fixtureSpace(t);
  const fixture = await start();
  await fixture.submit('task task-hold');
  await fixture.native('turn/end', 'main');
  const snapshot = await fixture.until(() => fixture.list(), value => value.tasks.length === 1, 'Chat did not create one task');
  const task = snapshot.tasks[0]!;
  assert.equal(task.goal, 'task-hold');
  await fixture.native('request/context', task.workerSessionId);
  const from = fixture.events.length;
  await fixture.submit('echo main remains responsive');
  await fixture.native('turn/end', 'main', from);
  assert.match(textOf(await fixture.history('main')), /main remains responsive/);
  assert.equal((await fixture.task(task.id)).lifecycle, 'open');
  await fixture.control(await fixture.task(task.id), 'cancel');
  await fixture.close();
});

test('task creation retries do not duplicate native execution and success requires acceptance', { timeout: 60_000 }, async t => {
  const { start } = await fixtureSpace(t);
  const fixture = await start();
  const taskId = randomUUID();
  const commandId = randomUUID();
  const created = await fixture.create('task-review', taskId, commandId);
  const review = await fixture.settled(taskId, 'awaiting_review');
  await fixture.native('turn/end', review.workerSessionId);
  assert.equal(review.lifecycle, 'open');
  assert.deepEqual(review.report?.evidence, ['fixture:verified']);
  assert.deepEqual(await fixture.create('task-review', taskId, commandId), created);
  assert.equal((await fixture.list()).tasks.length, 1);
  assert.equal(workerInputs(await fixture.history(review.workerSessionId)).length, 1);
  await assert.rejects(fixture.runtime.request('personbot.v1.tasks.create', {
    commandId, taskId, originSessionId: 'main', goal: 'changed goal',
    criteria: ['Fixture evidence is present'], context: 'Keep this explicit context across executions.',
  }), /conflict|reused|different/i);
  await assert.rejects(fixture.control(created, 'accept'), /revision|changed|stale/i);
  const accepted = await fixture.control(review, 'accept');
  assert.equal(accepted.lifecycle, 'completed');
  assert.equal((await fixture.list()).executions.find(execution => execution.id === review.currentExecutionId)?.outcome, 'succeeded');
  await fixture.close();
});

test('plain model completion and evidence-free claims cannot complete a business task', { timeout: 60_000 }, async t => {
  const { start } = await fixtureSpace(t);
  const fixture = await start();
  const unreported = await fixture.create('task-no-report');
  const blocked = await fixture.task(unreported.id, 'blocked');
  assert.equal(blocked.lifecycle, 'open');
  assert.equal((await fixture.list()).executions.find(execution => execution.id === blocked.currentExecutionId)?.outcome, 'unknown');
  const empty = await fixture.create('task-no-evidence');
  const rejected = await fixture.task(empty.id, 'blocked');
  assert.equal(rejected.lifecycle, 'open');
  await assert.rejects(fixture.control(rejected, 'accept'), /review|accept|stage|evidence/i);
  const failure = await fixture.create('task-fail');
  await fixture.task(failure.id, 'failed');
  assert.equal((await fixture.list()).executions.find(execution => execution.taskId === failure.id)?.outcome, 'failed');
  await fixture.close();
});

test('pause stops one worker and resume retains its Session, context and prior execution', { timeout: 60_000 }, async t => {
  const { start } = await fixtureSpace(t);
  const fixture = await start();
  const first = await fixture.create('task-hold');
  const other = await fixture.create('task-hold');
  await fixture.native('request/context', first.workerSessionId);
  await fixture.native('request/context', other.workerSessionId);
  const working = await fixture.task(first.id, 'working');
  await fixture.control(working, 'pause');
  const paused = await fixture.settled(first.id, 'paused');
  assert.equal(paused.lifecycle, 'open');
  assert.equal((await fixture.task(other.id)).stage, 'working');
  const from = fixture.events.length;
  const resumeCommand = randomUUID();
  const receipt = await fixture.control(paused, 'resume', undefined, resumeCommand);
  const resumed = await fixture.task(first.id, 'working');
  await fixture.native('request/header', first.workerSessionId, from);
  assert.equal(resumed.workerSessionId, first.workerSessionId);
  assert.notEqual(resumed.currentExecutionId, working.currentExecutionId);
  assert.equal(resumed.context, first.context);
  assert.deepEqual(await fixture.control(paused, 'resume', undefined, resumeCommand), receipt);
  await assert.rejects(fixture.control(paused, 'resume'), /revision|changed|stale/i);
  const sessions = await fixture.runtime.request<{ sessions: { sessionId: string; status: string }[] }>(
    'personbot.v1.sessions.list',
  );
  assert.equal(sessions.sessions.find(session => session.sessionId === first.workerSessionId)?.status, 'running');
  const history = await fixture.history(first.workerSessionId);
  assert.equal(workerInputs(history).length, 2);
  assert.equal((await fixture.list()).executions.filter(execution => execution.taskId === first.id).length, 2);
  await Promise.all([
    fixture.control(await fixture.task(first.id), 'cancel'),
    fixture.control(await fixture.task(other.id), 'cancel'),
  ]);
  await fixture.close();
});

test('managed workers reject direct Session mutations that bypass task state', { timeout: 60_000 }, async t => {
  const { start, cwd } = await fixtureSpace(t);
  const fixture = await start();
  const task = await fixture.create('task-hold');
  await fixture.native('request/context', task.workerSessionId);
  await assert.rejects(fixture.submit('echo bypass', task.workerSessionId), /task|worker|supervis/i);
  await assert.rejects(fixture.runtime.request('personbot.v1.sessions.stop', {
    commandId: randomUUID(), sessionId: task.workerSessionId,
  }), /task|worker|supervis/i);
  await assert.rejects(fixture.runtime.request('personbot.v1.sessions.resume', {
    sessionId: task.workerSessionId,
  }), /task|worker|supervis/i);
  await assert.rejects(fixture.runtime.request('personbot.v1.sessions.create', {
    sessionId: task.workerSessionId, cwd, taskId: task.id,
  }), /task|worker|supervis/i);
  await assert.rejects(fixture.runtime.request('personbot.v1.sessions.create', {
    sessionId: task.workerSessionId, cwd, conversationId: 'bypass-conversation',
  }), /task|worker|supervis/i);
  await fixture.control(await fixture.task(task.id), 'cancel');
  await fixture.close();
});

test('independent task questions and approvals reach the main App decision flow', { timeout: 60_000 }, async t => {
  const { start, cwd } = await fixtureSpace(t);
  const fixture = await start();
  const questionTask = await fixture.create('task-question');
  const question = await fixture.pending('question', questionTask.workerSessionId);
  assert.equal((await fixture.task(questionTask.id)).lifecycle, 'open');
  await fixture.runtime.request('personbot.v1.questions.answer', {
    requestId: (question.payload as { requestId: string }).requestId,
    generation: question.generation,
    result: { answers: [{ id: 'format', selected: ['Markdown'] }] },
  });
  await fixture.task(questionTask.id, 'awaiting_review');
  const approvedTask = await fixture.create('task-approved');
  const approval = await fixture.pending('approval', approvedTask.workerSessionId);
  const controlledPath = join(cwd, `${approvedTask.id}-approved.txt`);
  await assert.rejects(access(controlledPath), { code: 'ENOENT' });
  await fixture.runtime.request('personbot.v1.approvals.resolve', {
    requestId: (approval.payload as { requestId: string }).requestId,
    generation: approval.generation,
    outcome: 'allowed-once',
  });
  await fixture.task(approvedTask.id, 'awaiting_review');
  assert.equal(await readFile(controlledPath, 'utf8'), 'approved by personbot task fixture\n');
  const deniedTask = await fixture.create('task-approved');
  const denied = await fixture.pending('approval', deniedTask.workerSessionId);
  await fixture.runtime.request('personbot.v1.approvals.resolve', {
    requestId: (denied.payload as { requestId: string }).requestId,
    generation: denied.generation,
    outcome: 'rejected',
  });
  await fixture.task(deniedTask.id, 'blocked');
  await assert.rejects(access(join(cwd, `${deniedTask.id}-approved.txt`)), { code: 'ENOENT' });
  await fixture.close();
});

test('active task crash becomes unknown and requires explicit continuation', { timeout: 60_000 }, async t => {
  const { start } = await fixtureSpace(t);
  let fixture = await start();
  const created = await fixture.create('task-hold');
  await fixture.native('request/context', created.workerSessionId);
  const working = await fixture.task(created.id, 'working');
  assert.ok(fixture.runtime.pid);
  process.kill(fixture.runtime.pid, 'SIGKILL');
  await fixture.runtime.closed;
  fixture = await start(false);
  const interrupted = await fixture.task(created.id, 'blocked');
  const snapshot = await fixture.list();
  assert.equal(interrupted.lifecycle, 'open');
  assert.equal(snapshot.executions.find(execution => execution.id === working.currentExecutionId)?.outcome, 'unknown');
  assert.equal(fixture.events.some(event => event.sessionId === created.workerSessionId
    && event.type === 'session.stream' && (event.payload as { type: string }).type === 'start'), false);
  const from = fixture.events.length;
  await fixture.control(interrupted, 'resume', 'Inspect prior effects before continuing.');
  await fixture.native('request/header', created.workerSessionId, from);
  const resumed = await fixture.task(created.id, 'working');
  assert.equal(resumed.workerSessionId, created.workerSessionId);
  assert.notEqual(resumed.currentExecutionId, working.currentExecutionId);
  await fixture.control(resumed, 'cancel');
  await fixture.close();
});

test('waiting task survives restart without model polling and resumes the same native context', { timeout: 60_000 }, async t => {
  const { start } = await fixtureSpace(t);
  let fixture = await start();
  const created = await fixture.create('task-wait');
  const waiting = await fixture.settled(created.id, 'waiting_event');
  await fixture.native('turn/end', created.workerSessionId);
  const before = await fixture.history(created.workerSessionId);
  await fixture.close();
  fixture = await start(false);
  assert.equal((await fixture.task(created.id)).stage, 'waiting_event');
  assert.deepEqual(await fixture.history(created.workerSessionId), before);
  const from = fixture.events.length;
  await fixture.control(await fixture.task(created.id), 'resume', 'The awaited input is available.');
  const review = await fixture.task(created.id, 'awaiting_review');
  await fixture.native('turn/end', created.workerSessionId, from);
  assert.equal(review.workerSessionId, waiting.workerSessionId);
  assert.equal(review.lifecycle, 'open');
  assert.equal(workerInputs(await fixture.history(created.workerSessionId)).length, 2);
  await fixture.close();
});

test('durable result outbox returns one attributed notice across runtime restart', { timeout: 60_000 }, async t => {
  const { start } = await fixtureSpace(t);
  let fixture = await start();
  const created = await fixture.create('task-review');
  await fixture.settled(created.id, 'awaiting_review');
  await fixture.native('turn/end', created.workerSessionId);
  const delivered = await fixture.until(
    () => fixture.list(),
    value => value.updates.some(update => update.taskId === created.id && update.delivered),
    'Task result was not durably delivered to the origin conversation',
  );
  assert.equal(delivered.updates.filter(update => update.taskId === created.id).length, 1);
  await fixture.close();
  fixture = await start(false);
  await fixture.runtime.request('personbot.v1.sessions.resume', { sessionId: 'main' });
  assert.equal(fixture.events.some(event => event.sessionId === 'main'
    && event.type === 'session.event' && (event.payload as { event: NativeEvent }).event.type === 'request/context'), false);
  const from = fixture.events.length;
  await fixture.submit('echo inspect task result');
  await fixture.native('turn/end', 'main', from);
  const origin = await fixture.history('main');
  const notices = origin.filter(event => event.type === 'user/message'
    && event.data.source?.kind === 'personbot-supervisor');
  assert.equal(notices.length, 1);
  assert.match(JSON.stringify(notices[0]), /Fixture completed task-review/);
  assert.equal((await fixture.list()).updates.filter(update => update.taskId === created.id).length, 1);
  await fixture.close();
});

test('persisted wake time advances a waiting task exactly once', { timeout: 60_000 }, async t => {
  const { start } = await fixtureSpace(t);
  const fixture = await start();
  const task = await fixture.create('task-timer');
  await fixture.task(task.id, 'waiting_event');
  const review = await fixture.task(task.id, 'awaiting_review');
  assert.equal(review.lifecycle, 'open');
  const snapshot = await fixture.list();
  assert.equal(snapshot.executions.filter(execution => execution.taskId === task.id).length, 2);
  assert.equal(workerInputs(await fixture.history(task.workerSessionId)).length, 2);
  await fixture.close();
});

test('a terminal worker report drains already running native background processes', { timeout: 60_000 }, async t => {
  const { start, cwd } = await fixtureSpace(t);
  const fixture = await start();
  const task = await fixture.create('task-background-wait');
  const pid = await fixture.until(
    async () => {
      try { return Number(await readFile(join(cwd, `${task.id}-background.pid`), 'utf8')); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
        throw error;
      }
    },
    value => Number.isSafeInteger(value) && value > 0,
    'Owned task background process did not publish its PID',
  );
  t.after(() => {
    try { process.kill(pid, 'SIGKILL'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  });
  await fixture.task(task.id, 'waiting_event');
  await fixture.native('turn/end', task.workerSessionId);
  const stopped = await fixture.until(
    async () => {
      try { process.kill(pid, 0); return false; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
        throw error;
      }
    },
    value => value,
    'Worker reported waiting but its background process remains alive',
  );
  assert.equal(stopped, true);
  assert.equal((await fixture.settled(task.id, 'waiting_event')).stopState, 'confirmed');
  assert.equal(fixture.events.filter(event => event.sessionId === task.workerSessionId
    && event.type === 'session.stream' && (event.payload as { type: string }).type === 'start').length, 2);
  await fixture.close();
});

test('a terminal worker report drains a held native child without another root model call', { timeout: 60_000 }, async t => {
  const { start } = await fixtureSpace(t);
  const fixture = await start();
  const task = await fixture.create('task-child-wait');
  const child = await fixture.until(
    async () => fixture.events,
    events => events.some(event => event.type === 'session.status'
      && event.sessionId !== 'main' && event.sessionId !== task.workerSessionId
      && (event.payload as { status: string }).status === 'running'),
    'Task did not start its held native child',
  );
  const childId = child.find(event => event.type === 'session.status'
    && event.sessionId !== 'main' && event.sessionId !== task.workerSessionId
    && (event.payload as { status: string }).status === 'running')!.sessionId!;
  await fixture.native('request/context', childId);
  const waiting = await fixture.settled(task.id, 'waiting_event');
  assert.equal(waiting.stopState, 'confirmed');
  const childStatuses = fixture.events.filter(event =>
    event.type === 'session.status' && event.sessionId === childId);
  const latestChildStatus = childStatuses.at(-1);
  assert.ok(latestChildStatus);
  assert.equal((latestChildStatus.payload as { status: string }).status, 'idle');
  assert.equal(fixture.events.filter(event => event.sessionId === task.workerSessionId
    && event.type === 'session.stream' && (event.payload as { type: string }).type === 'start').length, 2);
  assert.equal((await fixture.history(task.workerSessionId)).filter(event => event.type === 'turn/start').length, 1);
  await fixture.close();
});

test('a task root may end its turn while a native child works and report after its return', { timeout: 60_000 }, async t => {
  const { start, home } = await fixtureSpace(t);
  const fixture = await start();
  const task = await fixture.create('task-child-join');
  const children = await fixture.until(
    async () => fixture.events,
    events => events.some(event => event.type === 'session.status'
      && event.sessionId !== 'main' && event.sessionId !== task.workerSessionId
      && (event.payload as { status: string }).status === 'running'),
    'Task did not start its asynchronous native child',
  );
  const childId = children.find(event => event.type === 'session.status'
    && event.sessionId !== 'main' && event.sessionId !== task.workerSessionId
    && (event.payload as { status: string }).status === 'running')!.sessionId!;
  await fixture.native('request/context', childId);
  await fixture.native('turn/end', task.workerSessionId);
  assert.equal((await fixture.task(task.id)).stage, 'working');
  const workerStatuses = fixture.events.filter(event =>
    event.type === 'session.status' && event.sessionId === task.workerSessionId);
  const latestWorkerStatus = workerStatuses.at(-1);
  assert.ok(latestWorkerStatus);
  assert.equal((latestWorkerStatus.payload as { status: string }).status, 'idle');
  const from = fixture.events.length;
  await fixture.submit('echo main responds while the task joins its child');
  await fixture.native('turn/end', 'main', from);
  assert.match(textOf(await fixture.history('main')), /main responds while the task joins its child/);
  assert.equal((await fixture.task(task.id)).stage, 'working');
  const childStatuses = fixture.events.filter(event => event.type === 'session.status' && event.sessionId === childId);
  const latestChildStatus = childStatuses.at(-1);
  assert.ok(latestChildStatus);
  assert.equal((latestChildStatus.payload as { status: string }).status, 'running');
  await writeFile(join(home, `${task.id}-child-release`), 'release\n');
  const review = await fixture.settled(task.id, 'awaiting_review');
  assert.equal(review.stopState, 'confirmed');
  assert.equal(review.currentExecutionId, task.currentExecutionId);
  const snapshot = await fixture.list();
  assert.equal(snapshot.executions.filter(execution => execution.taskId === task.id).length, 1);
  const history = await fixture.history(task.workerSessionId);
  assert.equal(workerInputs(history).length, 1);
  assert.equal(history.filter(event => event.type === 'turn/start').length, 2);
  assert.equal(history.filter(event => event.type === 'user/message'
    && event.data.source?.kind === 'subagent-settled').length, 1);
  await fixture.close();
});

test('pause and cancel can drain a task while its idle root joins a held native child', { timeout: 60_000 }, async t => {
  const { start } = await fixtureSpace(t);
  const fixture = await start();
  for (const action of ['pause', 'cancel'] as const) {
    const from = fixture.events.length;
    const task = await fixture.create('task-child-join');
    await fixture.native('turn/end', task.workerSessionId, from);
    const children = await fixture.until(
      async () => fixture.events.slice(from),
      events => events.some(event => event.type === 'session.event'
        && event.sessionId !== 'main' && event.sessionId !== task.workerSessionId
        && (event.payload as { event: NativeEvent }).event.type === 'request/context'),
      'Task child did not enter its held native model request',
    );
    const childId = children.find(event => event.type === 'session.event'
      && event.sessionId !== 'main' && event.sessionId !== task.workerSessionId
      && (event.payload as { event: NativeEvent }).event.type === 'request/context')!.sessionId!;
    const working = await fixture.task(task.id);
    assert.equal(working.stage, 'working');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        fixture.control(working, action),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`${action} was blocked by native child join`)), 3_000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    const stopped = await fixture.settled(task.id, 'paused');
    assert.equal(stopped.stopState, 'confirmed');
    assert.equal(stopped.lifecycle, action === 'cancel' ? 'cancelled' : 'open');
    const childStatuses = fixture.events.filter(event =>
      event.type === 'session.status' && event.sessionId === childId);
    const latestChildStatus = childStatuses.at(-1);
    assert.ok(latestChildStatus);
    assert.equal((latestChildStatus.payload as { status: string }).status, 'idle');
    assert.equal((await fixture.list()).executions.filter(execution => execution.taskId === task.id).length, 1);
  }
  await fixture.close();
});

test('four worker roots run concurrently and the fifth starts only after a slot drains', { timeout: 60_000 }, async t => {
  const { start } = await fixtureSpace(t);
  const fixture = await start();
  const tasks = await Promise.all(Array.from({ length: 5 }, () => fixture.create('task-hold')));
  const admitted = await fixture.until(
    () => fixture.list(),
    value => value.tasks.filter(task => task.stage === 'working').length === 4
      && value.tasks.filter(task => task.stage === 'queued').length === 1,
    'Supervisor did not admit exactly four native worker roots',
  );
  const queued = admitted.tasks.find(task => task.stage === 'queued')!;
  const running = admitted.tasks.filter(task => task.stage === 'working');
  await Promise.all(running.map(task => fixture.native('request/context', task.workerSessionId)));
  assert.equal(fixture.events.some(event => event.sessionId === queued.workerSessionId
    && event.type === 'session.stream' && (event.payload as { type: string }).type === 'start'), false);
  const from = fixture.events.length;
  await fixture.submit('echo main remains responsive at worker capacity');
  await fixture.native('turn/end', 'main', from);
  assert.match(textOf(await fixture.history('main')), /main remains responsive at worker capacity/);
  await fixture.control(await fixture.task(running[0]!.id), 'cancel');
  await fixture.settled(running[0]!.id, 'paused');
  await fixture.task(queued.id, 'working');
  await fixture.native('request/context', queued.workerSessionId);
  const rootIds = new Set(tasks.map(task => task.workerSessionId));
  const active = new Set<string>();
  let maximum = 0;
  for (const event of fixture.events) {
    if (event.type !== 'session.status' || !event.sessionId || !rootIds.has(event.sessionId)) continue;
    if ((event.payload as { status: string }).status === 'running') active.add(event.sessionId);
    else active.delete(event.sessionId);
    maximum = Math.max(maximum, active.size);
  }
  assert.equal(maximum, 4);
  assert.equal(active.size, 4);
  for (const task of tasks) assert.equal(workerInputs(await fixture.history(task.workerSessionId)).length, 1);
  const remaining = (await fixture.list()).tasks.filter(task => task.lifecycle === 'open');
  await Promise.all(remaining.map(task => fixture.control(task, 'cancel')));
  await fixture.close();
});

test('cancelling a task after runtime loss preserves unknown prior execution effects', { timeout: 60_000 }, async t => {
  const { start, cwd } = await fixtureSpace(t);
  let fixture = await start();
  const task = await fixture.create('task-background-hold');
  const pid = await fixture.until(
    async () => {
      try { return Number(await readFile(join(cwd, `${task.id}-background.pid`), 'utf8')); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
        throw error;
      }
    },
    value => Number.isSafeInteger(value) && value > 0,
    'Owned crash fixture background process did not publish its PID',
  );
  t.after(() => {
    try { process.kill(pid, 'SIGKILL'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  });
  await fixture.task(task.id, 'working');
  assert.ok(fixture.runtime.pid);
  process.kill(fixture.runtime.pid, 'SIGKILL');
  await fixture.runtime.closed;
  let survived = true;
  try { process.kill(pid, 0); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    survived = false;
  }
  t.diagnostic(`Owned native background process survived runtime SIGKILL: ${survived}`);
  fixture = await start(false);
  const interrupted = await fixture.task(task.id, 'blocked');
  const oldExecutionId = interrupted.currentExecutionId;
  assert.equal((await fixture.list()).executions.find(execution => execution.id === oldExecutionId)?.outcome, 'unknown');
  await fixture.control(interrupted, 'cancel');
  await fixture.settled(task.id, 'paused');
  assert.equal((await fixture.task(task.id)).lifecycle, 'cancelled');
  assert.equal((await fixture.list()).executions.find(execution => execution.id === oldExecutionId)?.outcome, 'unknown');
  await fixture.close();
});

test('task notice arriving during an active chat does not start an additional model turn', { timeout: 60_000 }, async t => {
  const { start, home } = await fixtureSpace(t);
  const fixture = await start();
  const marker = join(home, 'release-main-fixture');
  await fixture.submit(`wait-fixture ${marker}`);
  await fixture.native('request/context', 'main');
  const task = await fixture.create('task-review');
  await fixture.settled(task.id, 'awaiting_review');
  await fixture.until(
    () => fixture.list(),
    value => value.updates.some(update => update.taskId === task.id && !update.delivered),
    'Task result was not durably retained while source chat ran',
  );
  assert.equal(fixture.events.filter(event => event.sessionId === 'main'
    && event.type === 'session.stream' && (event.payload as { type: string }).type === 'start').length, 1);
  await writeFile(marker, 'release\n');
  await fixture.native('turn/end', 'main');
  await fixture.until(
    () => fixture.runtime.request<{ sessions: { sessionId: string; status: string }[] }>('personbot.v1.sessions.list'),
    value => value.sessions.some(session => session.sessionId === 'main' && session.status === 'idle'),
    'Source chat did not return to idle',
  );
  await fixture.until(
    () => fixture.list(),
    value => value.updates.some(update => update.taskId === task.id && update.delivered),
    'Deferred task result was not queued after source chat returned to idle',
  );
  assert.equal((await fixture.history('main')).filter(event => event.type === 'turn/start').length, 1);
  const from = fixture.events.length;
  await fixture.submit('echo consume the deferred task notice');
  await fixture.native('turn/end', 'main', from);
  const history = await fixture.history('main');
  assert.equal(history.filter(event => event.type === 'turn/start').length, 2);
  assert.equal(fixture.events.filter(event => event.sessionId === 'main'
    && event.type === 'session.stream' && (event.payload as { type: string }).type === 'start').length, 2);
  assert.equal(history.filter(event => event.type === 'user/message'
    && event.data.source?.kind === 'personbot-supervisor').length, 1);
  await fixture.close();
});
