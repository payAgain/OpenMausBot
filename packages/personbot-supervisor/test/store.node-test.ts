import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { MAX_TEXT_LENGTH, type CommandParamsMap, type TaskRecord, type TaskReport } from '../../personbot-protocol/src/index.ts';
import { SupervisorStore, SupervisorConflictError } from '../src/index.ts';

const REVIEW: TaskReport = { outcome: 'review', summary: 'Report prepared and checked.', evidence: ['report.md exists; fixture validation passed'] };

function fixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), 'personbot-supervisor-store-'));
  const path = join(home, 'supervisor.sqlite');
  const stores: SupervisorStore[] = [];
  const open = () => {
    const store = new SupervisorStore(path);
    stores.push(store);
    return store;
  };
  t.after(() => {
    for (const store of stores) store.close();
    rmSync(home, { recursive: true, force: true });
  });
  return { open, path };
}

function create(store: SupervisorStore, taskId = 'task-one') {
  return store.create({
    commandId: `create-${taskId}`,
    taskId,
    originSessionId: 'chat-one',
    goal: 'Prepare a checked report',
    criteria: ['Report includes a verified result'],
    context: 'Explicit originating context.',
  });
}

function control(store: SupervisorStore, task: TaskRecord, action: CommandParamsMap['personbot.v1.tasks.control']['action'], text?: string) {
  return store.control({ commandId: `${action}-${task.id}-${task.revision}`, taskId: task.id, expectedRevision: task.revision, action, ...(text ? { text } : {}) });
}

function dispatch(store: SupervisorStore, taskId = 'task-one') {
  const effect = store.pendingEffects().find(item => item.kind === 'dispatch' && item.taskId === taskId);
  assert.ok(effect);
  store.markDispatched(effect.id);
  return store.getTask(taskId)!;
}

function seal(store: SupervisorStore, task: TaskRecord): TaskRecord {
  const effect = store.pendingEffects().find(item => item.id === `seal:${task.currentExecutionId}`);
  assert.ok(effect);
  store.finishStop(effect.id, true, []);
  return store.getTask(task.id)!;
}

test('task, execution, command receipt and dispatch survive reopening with private database permissions', t => {
  const { open, path } = fixture(t);
  const first = open();
  const task = create(first);
  assert.equal(task.lifecycle, 'open');
  assert.equal(task.stage, 'queued');
  assert.equal(task.workerSessionId, 'worker-task-one');
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const effect = first.pendingEffects()[0]!;
  assert.equal(effect.kind, 'dispatch');
  assert.match(String(effect.payload.text), /structured report/);
  assert.equal(task.context, 'Explicit originating context.');
  first.close();
  const reopened = open();
  assert.deepEqual(reopened.getTask(task.id), task);
  assert.deepEqual(reopened.pendingEffects(), [effect]);
  assert.equal(reopened.snapshot().executions[0]?.status, 'pending');
});

test('command retries return original snapshots, conflict on changed body and preserve one execution', () => {
  const store = new SupervisorStore(':memory:');
  try {
    const first = create(store);
    dispatch(store);
    assert.equal(store.getTask(first.id)?.stage, 'working');
    assert.deepEqual(create(store), first);
    assert.equal(store.snapshot().executions.length, 1);
    assert.throws(() => store.create({
      commandId: 'create-task-one', taskId: 'task-one', originSessionId: 'chat-one', goal: 'Changed goal', criteria: ['changed'],
    }), SupervisorConflictError);
    assert.throws(() => store.control({
      commandId: 'create-task-one', taskId: 'task-one', expectedRevision: 2, action: 'pause',
    }), SupervisorConflictError);
  } finally { store.close(); }
});

test('worker review is not business completion; explicit human acceptance records success', () => {
  const store = new SupervisorStore(':memory:');
  try {
    const running = dispatch(store, create(store).id);
    const reported = store.report(running.id, running.currentExecutionId!, REVIEW);
    assert.equal(reported.stage, 'awaiting_review');
    assert.equal(reported.lifecycle, 'open');
    assert.equal(reported.stopState, 'pending');
    assert.equal(store.getExecution(running.currentExecutionId!)?.outcome, 'unknown');
    assert.equal(store.getExecution(running.currentExecutionId!)?.effectsUnknown, undefined);
    assert.throws(() => control(store, reported, 'accept'), /Stop is unconfirmed/);
    const completed = control(store, seal(store, reported), 'accept');
    assert.equal(completed.lifecycle, 'completed');
    assert.equal(store.getExecution(running.currentExecutionId!)?.outcome, 'succeeded');
    assert.throws(() => control(store, completed, 'resume'), /already closed/);
  } finally { store.close(); }
});

test('evidence and explicit completion criteria are required', () => {
  const store = new SupervisorStore(':memory:');
  try {
    assert.throws(() => store.create({ commandId: 'x', taskId: 'a', originSessionId: 'c', goal: 'g', criteria: [] }), /completion criteria/);
    const running = dispatch(store, create(store).id);
    assert.throws(() => store.report(running.id, running.currentExecutionId!, { ...REVIEW, evidence: [] }), /evidence/);
    assert.equal(store.getTask(running.id)?.stage, 'working');
    assert.throws(() => control(store, running, 'accept'), /Only a reported task/);
  } finally { store.close(); }
});

test('duplicate worker reports are idempotent and changed or retired reports are rejected', () => {
  const store = new SupervisorStore(':memory:');
  try {
    const running = dispatch(store, create(store).id);
    const review = store.report(running.id, running.currentExecutionId!, REVIEW);
    const before = store.snapshot();
    assert.deepEqual(store.report(running.id, running.currentExecutionId!, REVIEW), review);
    assert.deepEqual(store.snapshot(), before);
    assert.throws(() => store.report(running.id, running.currentExecutionId!, { ...REVIEW, summary: 'Changed' }), /different final report/);
    const revised = control(store, seal(store, review), 'revise', 'Include a second checked result');
    assert.equal(revised.workerSessionId, running.workerSessionId);
    assert.notEqual(revised.currentExecutionId, running.currentExecutionId);
    assert.throws(() => store.report(running.id, running.currentExecutionId!, REVIEW), /retired execution/);
    assert.equal(store.getTask(running.id)?.stage, 'queued');
  } finally { store.close(); }
});

test('report-before-native-delivery-ack cannot be overwritten back to running', () => {
  const store = new SupervisorStore(':memory:');
  try {
    const pending = create(store);
    const effect = store.pendingEffects()[0]!;
    const review = store.report(pending.id, pending.currentExecutionId!, REVIEW);
    store.markDispatched(effect.id);
    assert.deepEqual(store.getTask(pending.id), review);
    assert.equal(store.getExecution(pending.currentExecutionId!)?.status, 'ended');
    assert.equal(store.getEffect(effect.id)?.state, 'done');
  } finally { store.close(); }
});

test('stale revision rejects a command without reserving its retry identity', () => {
  const store = new SupervisorStore(':memory:');
  try {
    const queued = create(store);
    const running = dispatch(store);
    assert.throws(() => store.control({
      commandId: 'pause-retry', taskId: queued.id, expectedRevision: queued.revision, action: 'pause',
    }), /Task changed/);
    const paused = store.control({ commandId: 'pause-retry', taskId: queued.id, expectedRevision: running.revision, action: 'pause' });
    assert.equal(paused.stage, 'paused');
  } finally { store.close(); }
});

test('control admission validates before native work and receipt replay cannot stop a newer execution', () => {
  const store = new SupervisorStore(':memory:');
  try {
    const running = dispatch(store, create(store).id);
    const params = { commandId: 'pause-admission', taskId: running.id, expectedRevision: running.revision, action: 'pause' as const };
    assert.equal(store.controlReceipt(params), undefined);
    assert.equal(store.getTask(running.id)?.stage, 'working');
    const paused = store.control(params);
    const stop = store.pendingEffects().find(effect => effect.kind === 'stop')!;
    store.finishStop(stop.id, true, []);
    const resumed = control(store, store.getTask(paused.id)!, 'resume');
    assert.deepEqual(store.controlReceipt(params), paused);
    assert.equal(store.getTask(running.id)?.currentExecutionId, resumed.currentExecutionId);
    assert.throws(() => store.controlReceipt({ ...params, action: 'cancel' }), /different operation/);
    assert.throws(() => store.controlReceipt({ ...params, commandId: 'new-stale-command' }), /Task changed/);
  } finally { store.close(); }
});

test('pause revokes pending dispatch and waits for confirmed stop before resume in same Session', () => {
  const store = new SupervisorStore(':memory:');
  try {
    const queued = create(store);
    const dispatchEffect = store.pendingEffects()[0]!;
    const paused = control(store, queued, 'pause');
    assert.equal(store.getEffect(dispatchEffect.id)?.state, 'done');
    const stop = store.pendingEffects().find(effect => effect.kind === 'stop')!;
    assert.equal(store.getExecution(queued.currentExecutionId!)?.status, 'stopping');
    assert.throws(() => control(store, paused, 'pause'), /already paused/);
    assert.throws(() => control(store, paused, 'resume'), /has not stopped/);
    store.markDispatched(dispatchEffect.id);
    assert.equal(store.getTask(queued.id)?.stage, 'paused');
    store.finishStop(stop.id, true, []);
    const resumed = control(store, store.getTask(queued.id)!, 'resume');
    assert.equal(resumed.stage, 'queued');
    assert.equal(resumed.workerSessionId, queued.workerSessionId);
    assert.equal(store.getExecution(queued.currentExecutionId!)?.outcome, 'interrupted');
    assert.notEqual(resumed.currentExecutionId, queued.currentExecutionId);
    assert.equal(store.snapshot().executions.filter(execution => execution.status !== 'ended').length, 1);
  } finally { store.close(); }
});

test('supplements retain their exact execution and immutable workspace through receipt replay and explicit resume', () => {
  const store = new SupervisorStore(':memory:');
  try {
    const binding = {
      projectId: 'project', roleId: 'reviewer',
      workspace: { kind: 'git-worktree' as const, path: '/tmp/tasks/task-one', sourcePath: '/tmp/project', projectId: 'project' },
    };
    const queued = store.create({
      commandId: 'create-task', taskId: 'task-one', originSessionId: 'chat-one',
      goal: 'Prepare a checked report', criteria: ['Report includes a verified result'],
    }, binding);
    const params = { commandId: 'supplement-one', taskId: queued.id, expectedRevision: queued.revision, action: 'supplement' as const, text: 'Include one appendix.' };
    const supplemented = store.control(params);
    assert.equal(supplemented.stage, 'queued');
    assert.equal(supplemented.currentExecutionId, queued.currentExecutionId);
    assert.deepEqual(supplemented.messages?.map(({ id, text, executionId }) => ({ id, text, executionId })), [
      { id: params.commandId, text: params.text, executionId: queued.currentExecutionId },
    ]);
    const effect = store.pendingEffects().find(item => item.payload.supplement === true)!;
    assert.equal(effect.executionId, queued.currentExecutionId);
    assert.equal(effect.payload.commandId, params.commandId);
    store.markDispatched(`dispatch:${queued.currentExecutionId}`);
    store.markDispatched(effect.id);
    const running = store.getTask(queued.id)!;
    assert.equal(running.stage, 'working');
    assert.deepEqual(store.controlReceipt(params), supplemented);
    assert.equal(store.snapshot().executions.length, 1);
    const paused = control(store, running, 'pause');
    const stop = store.pendingEffects().find(item => item.kind === 'stop')!;
    store.finishStop(stop.id, true, []);
    const resumed = control(store, store.getTask(paused.id)!, 'resume');
    assert.notEqual(resumed.currentExecutionId, queued.currentExecutionId);
    assert.deepEqual(resumed.workspace, binding.workspace);
    assert.equal(resumed.messages?.[0]?.executionId, queued.currentExecutionId);
    const next = control(store, resumed, 'supplement', 'Preserve the appendix and add one validation.');
    assert.equal(next.messages?.[1]?.executionId, resumed.currentExecutionId);
    assert.deepEqual(store.control(params), supplemented);
    assert.deepEqual(store.getTask(queued.id), next);
  } finally { store.close(); }
});

test('accepted supplements cannot grow a persistent task beyond its transport frame budget', () => {
  const store = new SupervisorStore(':memory:');
  try {
    let current = create(store);
    const supplement = 'x'.repeat(MAX_TEXT_LENGTH);
    let rejected = false;
    for (let index = 0; index < 10; index++) {
      const before = current;
      try { current = control(store, current, 'supplement', supplement); }
      catch (error) {
        assert.ok(error instanceof TypeError || error instanceof SupervisorConflictError);
        assert.deepEqual(store.getTask(current.id), before);
        rejected = true;
        break;
      }
      assert.ok(Buffer.byteLength(JSON.stringify(current)) < 8 * 1024 * 1024,
        'A valid supplement made the persistent task exceed the runtime transport frame budget');
    }
    assert.equal(rejected, true, 'Supplement admission must enforce a task size budget before persistence');
  } finally { store.close(); }
});

test('cancel after worker report still drains the exact native worker tree', () => {
  const store = new SupervisorStore(':memory:');
  try {
    const running = dispatch(store, create(store).id);
    const review = store.report(running.id, running.currentExecutionId!, REVIEW);
    const cancelled = control(store, review, 'cancel');
    assert.equal(cancelled.lifecycle, 'cancelled');
    assert.equal(store.getExecution(running.currentExecutionId!)?.status, 'stopping');
    const priorSeal = store.pendingEffects().find(effect => effect.payload.seal === true)!;
    store.finishStop(priorSeal.id, true, []);
    assert.equal(store.getExecution(running.currentExecutionId!)?.status, 'stopping');
    assert.equal(store.getTask(running.id)?.stopState, 'pending');
    const stop = store.pendingEffects().find(effect => effect.kind === 'stop' && effect.payload.seal !== true)!;
    store.finishStop(stop.id, true, []);
    assert.equal(store.getExecution(running.currentExecutionId!)?.outcome, 'cancelled');
  } finally { store.close(); }
});

test('unconfirmed stop records unknown and explicit stop retry is required before resume', () => {
  const store = new SupervisorStore(':memory:');
  try {
    const running = dispatch(store, create(store).id);
    const paused = control(store, running, 'pause');
    const stop = store.pendingEffects().find(effect => effect.kind === 'stop')!;
    store.finishStop(stop.id, false, ['fixture background did not drain']);
    const failedStop = store.getTask(paused.id)!;
    assert.equal(store.getExecution(running.currentExecutionId!)?.outcome, 'unknown');
    assert.equal(store.getExecution(running.currentExecutionId!)?.effectsUnknown, true);
    assert.match(failedStop.lastError!, /background/);
    assert.equal(store.getEffect(stop.id)?.state, 'failed');
    assert.throws(() => control(store, failedStop, 'resume'), /Stop is unconfirmed/);
    const retry = control(store, failedStop, 'pause');
    const secondStop = store.pendingEffects().find(effect => effect.kind === 'stop')!;
    assert.notEqual(secondStop.id, stop.id);
    store.finishStop(stop.id, true, []);
    assert.equal(store.getExecution(running.currentExecutionId!)?.status, 'stopping');
    store.finishStop(secondStop.id, true, []);
    assert.equal(store.getExecution(running.currentExecutionId!)?.outcome, 'unknown');
    assert.equal(store.getExecution(running.currentExecutionId!)?.effectsUnknown, true);
    const resumed = control(store, store.getTask(retry.id)!, 'resume');
    assert.equal(resumed.stage, 'queued');
  } finally { store.close(); }
});

test('cancel is durable before stopping and targets one task while others keep working', () => {
  const store = new SupervisorStore(':memory:');
  try {
    const first = dispatch(store, create(store).id);
    const second = dispatch(store, create(store, 'task-two').id);
    const cancelled = control(store, first, 'cancel');
    assert.equal(cancelled.lifecycle, 'cancelled');
    assert.equal(store.getExecution(first.currentExecutionId!)?.status, 'stopping');
    assert.equal(store.getTask(second.id)?.stage, 'working');
    assert.throws(() => store.report(first.id, first.currentExecutionId!, REVIEW), /cannot submit/);
    const effect = store.pendingEffects().find(item => item.kind === 'stop')!;
    store.finishStop(effect.id, true, []);
    assert.equal(store.getExecution(first.currentExecutionId!)?.outcome, 'cancelled');
    assert.equal(store.getTask(second.id)?.stage, 'working');
  } finally { store.close(); }
});

test('waiting_event consumes no execution and due wake allocates exactly one continuation', () => {
  const store = new SupervisorStore(':memory:');
  try {
    const running = dispatch(store, create(store).id);
    const wakeAt = new Date(Date.now() + 60_000).toISOString();
    const waiting = store.report(running.id, running.currentExecutionId!, { outcome: 'waiting_event', summary: 'Wait for the declared time', evidence: [], wakeAt });
    store.wakeDue(new Date(Date.parse(wakeAt) - 1).toISOString());
    assert.equal(store.getTask(waiting.id)?.stage, 'waiting_event');
    assert.equal(store.snapshot().executions.filter(item => item.status !== 'ended').length, 0);
    store.wakeDue(wakeAt);
    assert.equal(store.getTask(waiting.id)?.stage, 'waiting_event');
    seal(store, waiting);
    store.wakeDue(wakeAt);
    store.wakeDue(new Date(Date.parse(wakeAt) + 1).toISOString());
    const resumed = store.getTask(waiting.id)!;
    assert.equal(resumed.stage, 'queued');
    assert.equal(resumed.wakeAt, undefined);
    assert.equal(store.snapshot().executions.length, 2);
    assert.equal(store.pendingEffects().filter(item => item.kind === 'dispatch').length, 1);
    assert.match(String(store.pendingEffects().find(item => item.kind === 'dispatch')?.payload.text), /declared wait expired/);
  } finally { store.close(); }
});

test('confirmed manual event wait persists across restart and requires an explicit resume', t => {
  const { open } = fixture(t);
  const store = open();
  const running = dispatch(store, create(store).id);
  const waiting = seal(store, store.report(running.id, running.currentExecutionId!, { outcome: 'waiting_event', summary: 'Wait for input', evidence: [] }));
  store.close();
  const reopened = open();
  reopened.recover();
  reopened.wakeDue(new Date(Date.now() + 86_400_000).toISOString());
  assert.deepEqual(reopened.getTask(waiting.id), waiting);
  assert.equal(reopened.pendingEffects().filter(effect => effect.kind === 'dispatch').length, 0);
  const resumed = control(reopened, waiting, 'resume', 'The awaited input arrived');
  assert.equal(resumed.stage, 'queued');
});

test('report drain confirmation preserves each semantic outcome and is idempotent', () => {
  const store = new SupervisorStore(':memory:');
  try {
    for (const outcome of ['review', 'waiting_event', 'blocked', 'failed'] as const) {
      const running = dispatch(store, create(store, `task-${outcome}`).id);
      const report = { ...REVIEW, outcome };
      const reported = store.report(running.id, running.currentExecutionId!, report);
      const pendingSeal = store.pendingEffects().find(item => item.id === `seal:${running.currentExecutionId}`)!;
      assert.equal(pendingSeal.payload.seal, true);
      assert.equal(reported.stopState, 'pending');
      const sealed = seal(store, reported);
      assert.equal(sealed.stopState, 'confirmed');
      assert.equal(sealed.stage, outcome === 'review' ? 'awaiting_review' : outcome);
      assert.equal(store.getExecution(running.currentExecutionId!)?.outcome, outcome === 'failed' ? 'failed' : outcome === 'waiting_event' ? 'interrupted' : 'unknown');
      store.finishStop(pendingSeal.id, false, ['late duplicate callback']);
      assert.deepEqual(store.getTask(running.id), sealed);
      assert.deepEqual(store.report(running.id, running.currentExecutionId!, report), sealed);
    }
  } finally { store.close(); }
});

test('failed report drain blocks acceptance and recovery until an explicit new stop confirms', () => {
  const store = new SupervisorStore(':memory:');
  try {
    const running = dispatch(store, create(store).id);
    const review = store.report(running.id, running.currentExecutionId!, REVIEW);
    store.finishStop(`seal:${running.currentExecutionId}`, false, ['fixture child still active']);
    const blocked = store.getTask(review.id)!;
    assert.equal(blocked.stage, 'blocked');
    assert.equal(blocked.stopState, 'unknown');
    assert.equal(store.getExecution(running.currentExecutionId!)?.outcome, 'unknown');
    assert.throws(() => control(store, blocked, 'accept'), /Only a reported task/);
    assert.throws(() => control(store, blocked, 'resume'), /Stop is unconfirmed/);
    const paused = control(store, blocked, 'pause');
    const stop = store.pendingEffects().find(effect => effect.kind === 'stop')!;
    store.finishStop(stop.id, true, []);
    const stopped = store.getTask(paused.id)!;
    assert.equal(stopped.stopState, 'confirmed');
    const resumed = control(store, stopped, 'resume');
    assert.equal(resumed.stopState, undefined);
    assert.equal(resumed.stage, 'queued');
    assert.notEqual(resumed.currentExecutionId, running.currentExecutionId);
  } finally { store.close(); }
});

test('runtime recovery blocks entered execution as unknown, preserves unattempted dispatch and does not repeat work', t => {
  const { open } = fixture(t);
  const store = open();
  const running = dispatch(store, create(store).id);
  const queued = create(store, 'task-two');
  store.close();
  const reopened = open();
  reopened.recover();
  const interrupted = reopened.getTask(running.id)!;
  assert.equal(interrupted.stage, 'blocked');
  assert.equal(reopened.getExecution(running.currentExecutionId!)?.outcome, 'unknown');
  assert.equal(reopened.getExecution(running.currentExecutionId!)?.effectsUnknown, true);
  assert.match(interrupted.lastError!, /External effects may be unknown/);
  assert.deepEqual(reopened.getTask(queued.id), queued);
  assert.equal(reopened.pendingEffects().filter(effect => effect.kind === 'dispatch').length, 1);
  const before = reopened.snapshot();
  reopened.recover();
  assert.deepEqual(reopened.snapshot(), before);
});

test('recovery preserves stop intent and marks pending native stops unknown before local confirmation', t => {
  const { open } = fixture(t);
  const store = open();
  const stopped = (['pause', 'cancel'] as const).map(action => {
    const running = dispatch(store, create(store, `task-${action}`).id);
    const task = control(store, running, action);
    const effect = store.pendingEffects().find(item => item.kind === 'stop' && item.taskId === task.id)!;
    return { task, effect };
  });
  store.close();
  const reopened = open();
  reopened.recover();
  for (const { task, effect } of stopped) {
    const recovered = reopened.getTask(task.id)!;
    const execution = reopened.getExecution(task.currentExecutionId!)!;
    assert.equal(recovered.lifecycle, task.lifecycle);
    assert.equal(recovered.stage, 'paused');
    assert.equal(recovered.stopState, 'pending');
    assert.equal(execution.status, 'stopping');
    assert.equal(execution.outcome, 'unknown');
    assert.equal(execution.effectsUnknown, true);
    assert.match(execution.summary!, /External effects may be unknown/);
    assert.equal(reopened.getEffect(effect.id)?.state, 'pending');
  }
  const before = reopened.snapshot();
  reopened.recover();
  assert.deepEqual(reopened.snapshot(), before);
  for (const { task, effect } of stopped) {
    const summary = reopened.getExecution(task.currentExecutionId!)!.summary;
    reopened.finishStop(effect.id, true, []);
    assert.equal(reopened.getTask(task.id)?.lifecycle, task.lifecycle);
    assert.equal(reopened.getTask(task.id)?.stopState, 'confirmed');
    assert.equal(reopened.getExecution(task.currentExecutionId!)?.outcome, 'unknown');
    assert.equal(reopened.getExecution(task.currentExecutionId!)?.effectsUnknown, true);
    assert.equal(reopened.getExecution(task.currentExecutionId!)?.summary, summary);
  }
});

test('recovery blocks unsealed reports and timers while preserving evidence and unknown prior effects', t => {
  const { open } = fixture(t);
  const store = open();
  const wakeAt = new Date(Date.now() + 60_000).toISOString();
  const reports = (['review', 'waiting_event', 'blocked', 'failed'] as const).map(outcome => {
    const running = dispatch(store, create(store, `task-${outcome}`).id);
    const report = { ...REVIEW, outcome, ...(outcome === 'waiting_event' ? { wakeAt } : {}) };
    return store.report(running.id, running.currentExecutionId!, report);
  });
  store.close();
  const reopened = open();
  reopened.recover();
  for (const reported of reports) {
    const recovered = reopened.getTask(reported.id)!;
    assert.equal(recovered.stage, 'blocked');
    assert.equal(recovered.lifecycle, 'open');
    assert.equal(recovered.stopState, 'pending');
    assert.deepEqual(recovered.report, reported.report);
    assert.equal(recovered.wakeAt, undefined);
    const execution = reopened.getExecution(reported.currentExecutionId!)!;
    assert.equal(execution.status, 'ended');
    assert.equal(execution.outcome, 'unknown');
    assert.equal(execution.effectsUnknown, true);
    assert.match(execution.summary!, /Report prepared and checked/);
    assert.match(execution.summary!, /External effects may be unknown/);
    assert.throws(() => control(reopened, recovered, 'resume'), /Stop is unconfirmed/);
    assert.throws(() => control(reopened, recovered, 'accept'), /Only a reported task/);
  }
  const before = reopened.snapshot();
  reopened.recover();
  assert.deepEqual(reopened.snapshot(), before);
  for (const reported of reports) {
    const recovered = seal(reopened, reported);
    assert.equal(recovered.stage, 'blocked');
    assert.equal(recovered.stopState, 'confirmed');
    assert.equal(reopened.getExecution(reported.currentExecutionId!)?.outcome, 'unknown');
    assert.equal(reopened.getExecution(reported.currentExecutionId!)?.effectsUnknown, true);
    assert.throws(() => control(reopened, recovered, 'accept'), /Only a reported task/);
  }
  reopened.wakeDue(new Date(Date.parse(wakeAt) + 60_000).toISOString());
  assert.equal(reopened.snapshot().executions.length, reports.length);
  assert.equal(reopened.pendingEffects().some(effect => effect.kind === 'dispatch'), false);
  const task = reopened.getTask(reports[0]!.id)!;
  const resumed = control(reopened, task, 'resume', 'Prior effects checked; continue explicitly');
  assert.notEqual(resumed.currentExecutionId, task.currentExecutionId);
  assert.equal(reopened.getExecution(resumed.currentExecutionId!)?.effectsUnknown, undefined);
  assert.equal(reopened.getExecution(task.currentExecutionId!)?.effectsUnknown, true);
});

test('recovery ignores confirmed stop receipts and older pending seals behind a confirmed newer stop', t => {
  const { open } = fixture(t);
  const store = open();
  const running = dispatch(store, create(store).id);
  const reported = store.report(running.id, running.currentExecutionId!, REVIEW);
  const paused = control(store, reported, 'pause');
  const stop = store.pendingEffects().find(effect => effect.kind === 'stop' && effect.payload.seal !== true)!;
  store.finishStop(stop.id, true, []);
  const before = store.snapshot();
  store.close();
  const reopened = open();
  reopened.recover();
  assert.deepEqual(reopened.snapshot(), before);
  assert.equal(reopened.getExecution(paused.currentExecutionId!)?.effectsUnknown, undefined);
  assert.equal(reopened.getEffect(`seal:${paused.currentExecutionId}`)?.state, 'pending');
});

test('confirmed local cancellation after runtime loss cannot erase prior unknown effects', t => {
  const { open } = fixture(t);
  const store = open();
  const running = dispatch(store, create(store).id);
  store.close();
  const reopened = open();
  reopened.recover();
  const interrupted = reopened.getTask(running.id)!;
  const prior = reopened.getExecution(running.currentExecutionId!)!;
  assert.equal(prior.effectsUnknown, true);
  const cancelled = control(reopened, interrupted, 'cancel');
  const stop = reopened.pendingEffects().find(effect => effect.kind === 'stop')!;
  assert.equal(reopened.getExecution(prior.id)?.effectsUnknown, true);
  reopened.finishStop(stop.id, true, []);
  assert.equal(reopened.getTask(cancelled.id)?.lifecycle, 'cancelled');
  assert.equal(reopened.getTask(cancelled.id)?.stopState, 'confirmed');
  const settled = reopened.getExecution(prior.id)!;
  assert.equal(settled.outcome, 'unknown');
  assert.equal(settled.effectsUnknown, true);
  assert.equal(settled.summary, prior.summary);
});

test('explicit resume starts a new execution while prior crash uncertainty remains durable', () => {
  const store = new SupervisorStore(':memory:');
  try {
    const running = dispatch(store, create(store).id);
    store.interrupt(running.id, running.currentExecutionId!, 'Crash effects require external verification');
    const blocked = store.getTask(running.id)!;
    const paused = control(store, blocked, 'pause');
    const stop = store.pendingEffects().find(effect => effect.kind === 'stop')!;
    store.finishStop(stop.id, false, ['Local drain also failed']);
    assert.match(store.getExecution(running.currentExecutionId!)?.summary ?? '', /Crash effects require external verification/);
    assert.match(store.getExecution(running.currentExecutionId!)?.summary ?? '', /Local drain also failed/);
    control(store, store.getTask(paused.id)!, 'pause');
    const retry = store.pendingEffects().find(effect => effect.kind === 'stop')!;
    store.finishStop(retry.id, true, []);
    const resumed = control(store, store.getTask(paused.id)!, 'resume');
    assert.equal(store.getExecution(running.currentExecutionId!)?.outcome, 'unknown');
    assert.equal(store.getExecution(running.currentExecutionId!)?.effectsUnknown, true);
    assert.equal(store.getExecution(resumed.currentExecutionId!)?.effectsUnknown, undefined);
    assert.notEqual(resumed.currentExecutionId, running.currentExecutionId);
  } finally { store.close(); }
});

test('outbox receipt and stable notification effect survive uncertain delivery and settle once', t => {
  const { open } = fixture(t);
  const store = open();
  const running = dispatch(store, create(store).id);
  store.report(running.id, running.currentExecutionId!, REVIEW);
  const effect = store.pendingEffects().find(item => item.kind === 'notify')!;
  const update = store.snapshot().updates[0]!;
  assert.equal(effect.payload.updateId, update.id);
  assert.equal(effect.payload.sessionId, 'chat-one');
  assert.equal(effect.payload.text, update.text);
  store.failEffect(effect.id, 'fixture connection ended');
  store.close();
  const reopened = open();
  assert.equal(reopened.getEffect(effect.id)?.attempts, 1);
  assert.equal(reopened.getEffect(effect.id)?.state, 'pending');
  assert.equal(reopened.snapshot().updates[0]?.delivered, false);
  reopened.markNotified(effect.id);
  reopened.markNotified(effect.id);
  assert.equal(reopened.snapshot().updates.length, 1);
  assert.equal(reopened.snapshot().updates[0]?.delivered, true);
  assert.equal(reopened.getEffect(effect.id)?.state, 'done');
});

test('approval waiting changes only the active task and does not reopen settled reports', () => {
  const store = new SupervisorStore(':memory:');
  try {
    const running = dispatch(store, create(store).id);
    store.setWaitingPerson(running.id, true);
    const waiting = store.getTask(running.id)!;
    assert.equal(waiting.stage, 'waiting_person');
    store.setWaitingPerson(running.id, true);
    assert.deepEqual(store.getTask(running.id), waiting);
    store.setWaitingPerson(running.id, false);
    assert.equal(store.getTask(running.id)?.stage, 'working');
    const review = store.report(running.id, running.currentExecutionId!, REVIEW);
    store.setWaitingPerson(running.id, false);
    assert.deepEqual(store.getTask(running.id), review);
  } finally { store.close(); }
});

test('approval can arrive before delivery acknowledgment without losing the waiting stage', () => {
  const store = new SupervisorStore(':memory:');
  try {
    const queued = create(store);
    const effect = store.pendingEffects()[0]!;
    store.setWaitingPerson(queued.id, true);
    assert.equal(store.getTask(queued.id)?.stage, 'waiting_person');
    store.markDispatched(effect.id);
    assert.equal(store.getExecution(queued.currentExecutionId!)?.status, 'running');
    assert.equal(store.getTask(queued.id)?.stage, 'waiting_person');
    store.setWaitingPerson(queued.id, false);
    assert.equal(store.getTask(queued.id)?.stage, 'working');
  } finally { store.close(); }
});

test('read snapshots are independent copies and origin filtering includes only related history', () => {
  const store = new SupervisorStore(':memory:');
  try {
    const first = create(store);
    store.create({ commandId: 'other', taskId: 'other', originSessionId: 'other-chat', goal: 'Other', criteria: ['Other evidence'] });
    const snapshot = store.snapshot('chat-one');
    assert.equal(snapshot.tasks.length, 1);
    assert.equal(snapshot.executions.length, 1);
    snapshot.tasks[0]!.criteria.push('locally modified');
    assert.deepEqual(store.getTask(first.id)?.criteria, ['Report includes a verified result']);
    assert.equal(store.snapshot('missing').tasks.length, 0);
  } finally { store.close(); }
});

test('unknown schema version is rejected without modifying the database', t => {
  const { path } = fixture(t);
  const database = new DatabaseSync(path);
  database.exec('PRAGMA user_version = 2');
  database.close();
  assert.throws(() => new SupervisorStore(path), /Unsupported supervisor store version: 2/);
  const reopened = new DatabaseSync(path);
  assert.equal((reopened.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 2);
  reopened.close();
});

test('external event commands replay before current state and never unpause or accept a task', t => {
  const { open } = fixture(t);
  const first = open();
  const task = create(first);
  const delivered = first.receiveEvent('event-one', task.id, 'Untrusted source context: first');
  assert.equal(delivered?.currentExecutionId, task.currentExecutionId);
  assert.equal(delivered?.messages?.length, 1);
  const supplement = first.pendingEffects().find(effect => effect.payload.commandId === 'event-one');
  assert.equal(supplement?.payload.external, true);
  const paused = control(first, first.getTask(task.id)!, 'pause');
  assert.equal(first.receiveEvent('event-two', task.id, 'Untrusted source context: second'), undefined);
  assert.deepEqual(first.receiveEvent('event-one', task.id, 'Untrusted source context: first'), delivered);
  assert.equal(first.getTask(task.id)?.stage, paused.stage);
  assert.throws(() => first.receiveEvent('event-one', task.id, 'changed context'), /different context/);
  first.close();
  const second = open();
  assert.deepEqual(second.eventReceipt('event-one', task.id, 'Untrusted source context: first'), delivered);
  assert.equal(second.getTask(task.id)?.messages?.length, 1);
});

test('external events wake only confirmed waiting executions and preserve the worker session', t => {
  const store = fixture(t).open();
  const task = create(store);
  dispatch(store);
  store.report(task.id, task.currentExecutionId!, { outcome: 'waiting_event', summary: 'Awaiting source', evidence: [] });
  assert.equal(store.receiveEvent('wake-one', task.id, 'Untrusted source data'), undefined);
  seal(store, store.getTask(task.id)!);
  const woken = store.receiveEvent('wake-one', task.id, 'Untrusted source data')!;
  assert.equal(woken.workerSessionId, task.workerSessionId);
  assert.notEqual(woken.currentExecutionId, task.currentExecutionId);
  assert.equal(woken.stage, 'queued');
  assert.equal(store.snapshot().executions.length, 2);
  assert.deepEqual(store.receiveEvent('wake-one', task.id, 'Untrusted source data'), woken);
  assert.equal(store.snapshot().executions.length, 2);
  assert.match(String(store.pendingEffects().find(effect => effect.executionId === woken.currentExecutionId)?.payload.text), /Untrusted source data/);
});
