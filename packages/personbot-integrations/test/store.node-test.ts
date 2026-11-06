import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import type { CommandParamsMap, TaskUpdate } from '../../personbot-protocol/src/index.ts';
import { IntegrationConflictError, IntegrationStore } from '../src/index.ts';

const TOKEN = 'test-source-token-0123456789-abcdef';
type SourceParams = CommandParamsMap['personbot.v1.sources.put'];

function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'personbot-integrations-')));
  const path = join(root, 'runtime', 'integrations.sqlite');
  const stores: IntegrationStore[] = [];
  const open = () => {
    const store = new IntegrationStore(path);
    stores.push(store);
    return store;
  };
  t.after(() => {
    for (const store of stores) store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, path, open };
}

function source(store: IntegrationStore, overrides: Partial<SourceParams> = {}) {
  return store.putSource({
    commandId: 'source-create', sourceId: 'source', name: 'Local webhook', originSessionId: 'main',
    goal: 'Inspect the event and report checked findings', criteria: ['Include concrete evidence'],
    enabled: true, callbackMode: 'idempotent', token: TOKEN, ...overrides,
  });
}

function receive(store: IntegrationStore, eventId = 'one', threadId = 'thread', text = 'Inspect this event') {
  return store.receive({ sourceId: 'source', eventId, threadId, text });
}

function update(id: string, taskId = 'task', createdAt = new Date(Date.now() + 1).toISOString()): TaskUpdate {
  return { id, taskId, sessionId: 'main', revision: 2, text: 'A checked result is ready', createdAt, delivered: true };
}

function subscribed(store: IntegrationStore, callbackMode: 'idempotent' | 'at-most-once' = 'idempotent') {
  source(store, { callbackUrl: 'http://127.0.0.1:9099/results', callbackMode });
  return store.putSubscription({
    commandId: 'subscribe', subscriptionId: 'subscription', sourceId: 'source', threadId: 'thread', taskId: 'task', enabled: true,
  });
}

test('write-only token hashes, mutation receipts and revisions survive reopening without leaking credentials', t => {
  const { path, open } = fixture(t);
  const first = open();
  const created = source(first);
  assert.equal(first.authenticate('source', TOKEN), true);
  assert.equal(first.authenticate('source', `${TOKEN}wrong`), false);
  assert.equal(first.authenticate('unknown', TOKEN), false);
  assert.equal(first.authenticate('source', ''), false);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const changed = source(first, { commandId: 'source-edit', expectedRevision: 1, token: undefined, name: 'Edited' });
  assert.equal(changed.revision, 2);
  assert.deepEqual(source(first), created);
  assert.throws(() => source(first, { commandId: 'source-stale', expectedRevision: 1 }), /Record changed/);
  assert.throws(() => source(first, { name: 'Conflicting replay' }), IntegrationConflictError);
  first.close();
  const reopened = open();
  assert.equal(reopened.authenticate('source', TOKEN), true);
  const rotated = source(reopened, { commandId: 'rotate', expectedRevision: 2, token: `${TOKEN}-rotated` });
  assert.equal(rotated.revision, 3);
  assert.equal(reopened.authenticate('source', TOKEN), false);
  assert.equal(reopened.authenticate('source', `${TOKEN}-rotated`), true);
  assert.equal(JSON.stringify(reopened.snapshot()).includes(TOKEN), false);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const commands = db.prepare('SELECT fingerprint, result FROM commands').all();
    assert.equal(JSON.stringify(commands).includes(TOKEN), false);
  } finally { db.close(); }
  reopened.close();
  assert.equal(readFileSync(path).includes(Buffer.from(TOKEN)), false);
});

test('duplicate authenticated event receipt never requeues after completion or disable, while content conflicts reject', t => {
  const { open } = fixture(t);
  const store = open();
  source(store);
  const accepted = receive(store, ' one ', ' thread ');
  const pending = store.pendingEvents();
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.delivery.subscriptionId, undefined);
  assert.match(pending[0]!.delivery.taskId!, /^evt-[a-f0-9]{40}$/);
  store.trackCreatedTask(pending[0]!.delivery.id, pending[0]!.delivery.taskId!);
  assert.equal(store.snapshot().triggers[0]?.status, 'delivered');
  assert.deepEqual(receive(store, 'one', 'thread'), { trigger: accepted.trigger, duplicate: true });
  assert.equal(store.pendingEvents().length, 0);
  source(store, { commandId: 'disable', expectedRevision: 1, token: undefined, enabled: false });
  assert.equal(store.authenticate('source', TOKEN), true);
  assert.deepEqual(receive(store, 'one', 'thread'), { trigger: accepted.trigger, duplicate: true });
  assert.throws(() => receive(store, 'one', 'thread', 'Changed text'), /different content/);
  assert.throws(() => receive(store, 'new-event'), /disabled/);
  assert.equal(store.snapshot().triggers.length, 1);
});

test('event fanout freezes matched tasks and source authority despite later subscription and source edits', t => {
  const { open } = fixture(t);
  const store = open();
  source(store);
  for (const id of ['first', 'second']) store.putSubscription({
    commandId: `subscribe-${id}`, subscriptionId: id, sourceId: 'source', threadId: 'thread', taskId: `task-${id}`, enabled: true,
  });
  receive(store);
  const intents = store.pendingEvents();
  assert.deepEqual(intents.map(item => item.delivery.taskId), ['task-first', 'task-second']);
  assert.throws(() => source(store, { commandId: 'source-move', expectedRevision: 1, token: undefined, originSessionId: 'other-main' }), /cannot change/);
  source(store, { commandId: 'source-edit', expectedRevision: 1, token: undefined, goal: 'A changed future goal' });
  assert.throws(() => store.putSubscription({
    commandId: 'subscription-edit', subscriptionId: 'first', expectedRevision: 1,
    sourceId: 'source', threadId: 'thread', taskId: 'replacement-task', enabled: true,
  }), /cannot change/);
  assert.equal(store.pendingEvents()[0]!.source.originSessionId, 'main');
  assert.equal(store.pendingEvents()[0]!.source.goal, 'Inspect the event and report checked findings');
  assert.deepEqual(store.pendingEvents().map(item => item.delivery.taskId), ['task-first', 'task-second']);
  store.finishEvent(intents[0]!.delivery.id, { state: 'delivered', taskId: 'task-first' });
  assert.equal(store.snapshot().triggers[0]?.status, 'pending');
  store.finishEvent(intents[1]!.delivery.id, { state: 'ignored' });
  assert.equal(store.snapshot().triggers[0]?.status, 'delivered');
  assert.deepEqual(store.snapshot().triggers[0]?.taskIds, ['task-first']);
  store.finishEvent(intents[0]!.delivery.id, { state: 'delivered', taskId: 'task-first' });
  assert.throws(() => store.finishEvent(intents[0]!.delivery.id, { state: 'ignored' }), /different result/);
});

test('created task and automatic subscription settle together and later same-thread events target the same task', t => {
  const { open } = fixture(t);
  const store = open();
  source(store);
  receive(store);
  const first = store.pendingEvents()[0]!;
  assert.throws(() => store.trackCreatedTask(first.delivery.id, 'different-task'), /differs/);
  store.failEvent(first.delivery.id, 'Temporary native service startup failure');
  assert.equal(store.pendingEvents()[0]?.delivery.state, 'pending');
  store.trackCreatedTask(first.delivery.id, first.delivery.taskId!);
  store.trackCreatedTask(first.delivery.id, first.delivery.taskId!);
  assert.equal(store.snapshot().subscriptions.length, 1);
  assert.equal(store.snapshot().triggers[0]?.lastError, undefined);
  store.close();
  const reopened = open();
  receive(reopened, 'second');
  const next = reopened.pendingEvents()[0]!;
  assert.equal(next.delivery.taskId, first.delivery.taskId);
  assert.equal(next.delivery.subscriptionId, reopened.snapshot().subscriptions[0]?.id);
  assert.equal(reopened.snapshot().subscriptions.length, 1);
});

test('tracking does not reenable an owner-disabled reserved subscription and event retry can never retarget', t => {
  const { open } = fixture(t);
  const store = open();
  source(store);
  receive(store);
  const intent = store.pendingEvents()[0]!.delivery;
  const reserved = store.snapshot().subscriptions[0]!;
  store.putSubscription({
    commandId: 'manual-disable', subscriptionId: reserved.id, sourceId: 'source',
    threadId: 'thread', taskId: intent.taskId!, enabled: false, expectedRevision: reserved.revision,
  });
  assert.equal(store.pendingEvents().length, 0);
  store.trackCreatedTask(intent.id, intent.taskId!);
  assert.equal(store.snapshot().subscriptions.length, 1);
  assert.equal(store.getSubscription(reserved.id)?.enabled, false);
  assert.throws(() => store.finishEvent(intent.id, { state: 'delivered', taskId: 'other' }), /different result/);
});

test('back-to-back first-thread events reserve one task atomically and disabled bindings never fall back to creating work', t => {
  const { open } = fixture(t);
  const store = open();
  source(store);
  receive(store, 'first');
  receive(store, 'second');
  const intents = store.pendingEvents();
  assert.equal(intents.length, 1);
  assert.equal(intents[0]!.delivery.subscriptionId, undefined);
  store.trackCreatedTask(intents[0]!.delivery.id, intents[0]!.delivery.taskId!);
  const second = store.pendingEvents()[0]!;
  assert.equal(second.delivery.taskId, intents[0]!.delivery.taskId);
  assert.equal(second.delivery.subscriptionId, store.snapshot().subscriptions[0]?.id);
  const subscription = store.snapshot().subscriptions[0]!;
  store.putSubscription({
    commandId: 'disable-reserved', subscriptionId: subscription.id, sourceId: 'source', threadId: 'thread',
    taskId: subscription.taskId, enabled: false, expectedRevision: subscription.revision,
  });
  receive(store, 'third');
  assert.equal(store.snapshot().subscriptions.length, 1);
  assert.equal(store.pendingEvents().length, 0);
  store.putSubscription({
    commandId: 'enable-reserved', subscriptionId: subscription.id, sourceId: 'source', threadId: 'thread',
    taskId: subscription.taskId, enabled: true, expectedRevision: subscription.revision + 1,
  });
  const resumed = store.pendingEvents();
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0]?.delivery.id, second.delivery.id);
  store.finishEvent(second.delivery.id, { state: 'delivered', taskId: subscription.taskId });
  assert.ok(store.pendingEvents().every(item => item.delivery.subscriptionId && item.delivery.taskId === subscription.taskId));
});

test('held task heads cannot starve later tasks and exclusions apply before the bounded event batch', t => {
  const { open } = fixture(t);
  const store = open();
  source(store);
  for (let index = 0; index < 64; index++) receive(store, `held-${index}`, `held-thread-${index}`);
  const held = store.pendingEvents();
  assert.equal(held.length, 64);
  const eligible = receive(store, 'eligible', 'eligible-thread');
  const later = store.pendingEvents(held.map(item => item.delivery.taskId!));
  assert.equal(later.length, 1);
  assert.equal(later[0]?.trigger.id, eligible.trigger.id);
  assert.equal(store.pendingEvents().length, 64);
  assert.equal(store.pendingEvents()[0]?.trigger.id, eligible.trigger.id);
});

test('live event admission rechecks reserved binding, Source and settled receipt without losing pending work', t => {
  const { open } = fixture(t);
  const store = open();
  source(store);
  receive(store);
  const first = store.pendingEvents()[0]!.delivery;
  const reserved = store.snapshot().subscriptions[0]!;
  assert.equal(store.canDeliverEvent(first.id), true);
  store.putSubscription({
    commandId: 'disable', subscriptionId: reserved.id, sourceId: reserved.sourceId, threadId: reserved.threadId,
    taskId: reserved.taskId, enabled: false, expectedRevision: 1,
  });
  assert.equal(store.canDeliverEvent(first.id), false);
  store.putSubscription({
    commandId: 'enable', subscriptionId: reserved.id, sourceId: reserved.sourceId, threadId: reserved.threadId,
    taskId: reserved.taskId, enabled: true, expectedRevision: 2,
  });
  assert.equal(store.canDeliverEvent(first.id), true);
  source(store, { commandId: 'disable-source', expectedRevision: 1, token: undefined, enabled: false });
  assert.equal(store.canDeliverEvent(first.id), false);
  source(store, { commandId: 'enable-source', expectedRevision: 2, token: undefined });
  assert.equal(store.canDeliverEvent(first.id), true);
  store.trackCreatedTask(first.id, first.taskId!);
  assert.equal(store.canDeliverEvent(first.id), false);
  assert.equal(store.canDeliverEvent('unknown'), false);
});

test('one-shot schedules and coalesced UTC intervals produce one durable occurrence and survive reopening', t => {
  const { open } = fixture(t);
  const store = open();
  source(store);
  store.putSchedule({
    commandId: 'one-shot', scheduleId: 'once', name: 'Once', sourceId: 'source', threadId: 'once',
    text: 'One shot', runAt: '2026-11-05T01:00:00Z', enabled: true,
  });
  store.putSchedule({
    commandId: 'interval', scheduleId: 'interval', name: 'Interval', sourceId: 'source', threadId: 'interval',
    text: 'Latest interval', runAt: '2026-11-05T01:00:00Z', intervalSeconds: 60, enabled: true,
  });
  store.produceDue('2026-11-05T02:00:30Z');
  const snapshot = store.snapshot();
  assert.equal(snapshot.triggers.length, 2);
  assert.equal(snapshot.schedules.find(row => row.id === 'once')?.enabled, false);
  assert.equal(snapshot.schedules.find(row => row.id === 'once')?.nextRunAt, undefined);
  assert.equal(snapshot.schedules.find(row => row.id === 'interval')?.nextRunAt, '2026-11-05T02:01:00.000Z');
  store.produceDue('2026-11-05T02:00:59Z');
  assert.equal(store.snapshot().triggers.length, 2);
  store.close();
  const reopened = open();
  reopened.produceDue('2026-11-05T02:00:59Z');
  assert.equal(reopened.snapshot().triggers.length, 2);
  reopened.produceDue('2026-11-05T02:01:00Z');
  assert.equal(reopened.snapshot().triggers.length, 3);
  const scheduled = snapshot.triggers[0]!;
  const remote = receive(reopened, scheduled.eventId, scheduled.threadId, scheduled.text);
  assert.notEqual(remote.trigger.id, scheduled.id);
  assert.equal(remote.duplicate, false);
});

test('schedule event acceptance and advancing the timer roll back together on a storage failure', t => {
  const { path, open } = fixture(t);
  const store = open();
  source(store);
  store.putSchedule({
    commandId: 'scheduled', scheduleId: 'timer', name: 'Timer', sourceId: 'source', threadId: 'thread',
    text: 'Scheduled event', runAt: '2026-11-05T01:00:00Z', enabled: true,
  });
  const db = new DatabaseSync(path);
  try {
    db.exec("CREATE TRIGGER fixture_fail_schedule BEFORE UPDATE ON schedules BEGIN SELECT RAISE(ABORT, 'fixture schedule failure'); END;");
    assert.throws(() => store.produceDue('2026-11-05T02:00:00Z'), /fixture schedule failure/);
    assert.equal(store.snapshot().triggers.length, 0);
    assert.equal(store.pendingEvents().length, 0);
    assert.equal(store.snapshot().schedules[0]?.nextRunAt, '2026-11-05T01:00:00.000Z');
    db.exec('DROP TRIGGER fixture_fail_schedule');
    store.produceDue('2026-11-05T02:00:00Z');
    assert.equal(store.snapshot().triggers.length, 1);
  } finally { db.close(); }
});

test('a capacity-blocked schedule keeps its due occurrence without stopping other schedule or event dispatch', t => {
  const { open } = fixture(t);
  const store = open();
  source(store);
  for (let index = 0; index < 256; index++) store.putSubscription({
    commandId: `subscription-${index}`, subscriptionId: `subscription-${index}`,
    sourceId: 'source', threadId: 'existing-thread', taskId: `task-${index}`, enabled: true,
  });
  for (const [id, threadId] of [['blocked', 'new-thread'], ['eligible', 'existing-thread']]) store.putSchedule({
    commandId: `schedule-${id}`, scheduleId: id!, name: id!, sourceId: 'source', threadId: threadId!,
    text: 'Due work', runAt: '2026-11-05T01:00:00Z', enabled: true,
  });
  store.produceDue('2026-11-05T02:00:00Z');
  const snapshot = store.snapshot();
  assert.equal(snapshot.triggers.length, 1);
  assert.equal(snapshot.triggers[0]?.threadId, 'existing-thread');
  assert.equal(snapshot.schedules.find(row => row.id === 'blocked')?.nextRunAt, '2026-11-05T01:00:00.000Z');
  assert.equal(snapshot.schedules.find(row => row.id === 'eligible')?.enabled, false);
  assert.ok(store.pendingEvents().length > 0);
});

test('disabled source does not fire schedules and invalid interval or stale edits leave accepted configuration intact', t => {
  const { open } = fixture(t);
  const store = open();
  source(store, { enabled: false });
  const params = {
    commandId: 'schedule', scheduleId: 'timer', name: 'Timer', sourceId: 'source', threadId: 'thread',
    text: 'Scheduled event', runAt: '2026-11-05T01:00:00Z', enabled: true,
  };
  const schedule = store.putSchedule(params);
  store.produceDue('2026-11-05T02:00:00Z');
  assert.equal(store.pendingEvents().length, 0);
  assert.deepEqual(store.putSchedule(params), schedule);
  assert.throws(() => store.putSchedule({ ...params, commandId: 'bad-interval', expectedRevision: 1, intervalSeconds: 59 }), /intervalSeconds/);
  assert.throws(() => store.putSchedule({ ...params, commandId: 'stale-schedule' }), /Record changed/);
  source(store, { commandId: 'enable-source', expectedRevision: 1, token: undefined });
  store.produceDue('2026-11-05T02:00:00Z');
  assert.equal(store.pendingEvents().length, 1);
});

test('callback enqueue is idempotent, independent from App receipt, excludes historical/other-origin updates and freezes destination', t => {
  const { open } = fixture(t);
  const store = open();
  const subscription = subscribed(store);
  store.queueUpdates([
    update('old', 'task', '2020-01-01T00:00:00Z'),
    { ...update('other-origin'), sessionId: 'another-conversation' },
    update('new'),
  ]);
  const first = store.snapshot().deliveries[0]!;
  assert.equal(store.snapshot().deliveries.length, 1);
  assert.equal(first.payload.updateId, 'new');
  assert.equal(first.payload.threadId, subscription.threadId);
  source(store, { commandId: 'destination-edit', expectedRevision: 1, token: undefined, callbackUrl: 'http://localhost:9999/changed' });
  store.queueUpdates([update('new')]);
  assert.equal(store.snapshot().deliveries.length, 1);
  assert.equal(store.snapshot().deliveries[0]?.url, 'http://127.0.0.1:9099/results');
  assert.deepEqual(store.snapshot().deliveries[0]?.payload, first.payload);
  assert.deepEqual(Object.keys(first.payload).sort(), ['createdAt', 'deliveryId', 'revision', 'sourceId', 'taskId', 'text', 'threadId', 'updateId']);
  const snapshot = store.snapshot();
  snapshot.deliveries[0]!.payload.text = 'Changed only in caller';
  assert.notEqual(store.snapshot().deliveries[0]?.payload.text, snapshot.deliveries[0]?.payload.text);
});

test('subscription bindings are immutable and reenabling establishes a fresh result floor without changing queued deliveries', t => {
  const { path, open } = fixture(t);
  const store = open();
  subscribed(store);
  const db = new DatabaseSync(path);
  try { db.exec("UPDATE subscriptions SET data = json_set(data, '$.createdAt', '2020-01-01T00:00:00.000Z') WHERE id = 'subscription'"); }
  finally { db.close(); }
  const subscription = store.getSubscription('subscription')!;
  const params = {
    commandId: 'subscription-edit', subscriptionId: subscription.id, sourceId: subscription.sourceId,
    threadId: subscription.threadId, taskId: subscription.taskId, enabled: true, expectedRevision: 1,
  };
  for (const changed of [{ sourceId: 'other-source' }, { threadId: 'other-thread' }, { taskId: 'other-task' }]) {
    if (changed.sourceId) source(store, { commandId: 'other-source', sourceId: changed.sourceId });
    assert.throws(() => store.putSubscription({ ...params, ...changed }), /cannot change/);
  }
  store.queueUpdates([update('before-disable', 'task', '2025-01-01T00:00:00Z')]);
  const queued = store.snapshot().deliveries[0]!;
  store.putSubscription({ ...params, commandId: 'disable-subscription', enabled: false });
  store.queueUpdates([update('disabled-period', 'task', '2025-06-01T00:00:00Z')]);
  const enabled = store.putSubscription({ ...params, commandId: 'enable-subscription', expectedRevision: 2 });
  assert.notEqual(enabled.createdAt, subscription.createdAt);
  store.queueUpdates([update('disabled-period', 'task', '2025-06-01T00:00:00Z'), update('after-enable')]);
  assert.equal(store.snapshot().deliveries.length, 2);
  assert.deepEqual(store.snapshot().deliveries[0], queued);
  assert.equal(store.snapshot().deliveries[1]?.updateId, 'after-enable');
});

test('callback outbox keeps source/thread order, recovers ambiguous sends and requires stable explicit manual decisions', t => {
  const { open } = fixture(t);
  const store = open();
  subscribed(store, 'at-most-once');
  store.queueUpdates([update('one'), update('two')]);
  let pending = store.pendingDeliveries(new Date().toISOString());
  assert.equal(pending.length, 1);
  const first = store.beginDelivery(pending[0]!.id);
  assert.equal(first.state, 'sending');
  assert.equal(first.attempts, 1);
  assert.throws(() => store.beginDelivery(first.id), /not eligible/);
  assert.throws(() => store.beginDelivery(store.snapshot().deliveries[1]!.id), /earlier callback/);
  assert.equal(store.pendingDeliveries(new Date().toISOString()).length, 0);
  store.close();
  const reopened = open();
  reopened.recover();
  assert.equal(reopened.snapshot().deliveries[0]?.state, 'uncertain');
  assert.equal(reopened.pendingDeliveries(new Date().toISOString()).length, 0);
  const command = { commandId: 'manual-retry', deliveryId: first.id, expectedState: 'uncertain' as const, action: 'retry' as const };
  const retry = reopened.controlDelivery(command);
  assert.equal(retry.state, 'pending');
  const sending = reopened.beginDelivery(first.id);
  reopened.finishDelivery(first.id, { state: 'delivered' });
  assert.deepEqual(reopened.controlDelivery(command), retry);
  assert.equal(reopened.snapshot().deliveries[0]?.state, 'delivered');
  assert.equal(sending.attempts, 1);
  pending = reopened.pendingDeliveries(new Date().toISOString());
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.updateId, 'two');
  assert.throws(() => reopened.controlDelivery({ ...command, commandId: 'stale-decision' }), /state changed/);
});

test('the durable outbox cannot automatically retry an at-most-once sending receipt', t => {
  const { open } = fixture(t);
  const store = open();
  subscribed(store, 'at-most-once');
  store.queueUpdates([update('one')]);
  const first = store.pendingDeliveries(new Date().toISOString())[0]!;
  store.beginDelivery(first.id);
  store.finishDelivery(first.id, { state: 'pending', error: 'A transport cannot prove whether the message arrived' });
  assert.equal(store.snapshot().deliveries[0]?.state, 'uncertain');
  assert.equal(store.pendingDeliveries(new Date().toISOString()).length, 0);
});

test('idempotent in-flight callbacks recover with immutable id/payload, stop after five automatic attempts and allow explicit confirmation', t => {
  const { open } = fixture(t);
  const store = open();
  subscribed(store);
  store.queueUpdates([update('one'), update('two')]);
  const first = store.pendingDeliveries(new Date().toISOString())[0]!;
  store.beginDelivery(first.id);
  store.close();
  const reopened = open();
  reopened.recover();
  assert.deepEqual(reopened.pendingDeliveries(new Date().toISOString())[0]?.payload, first.payload);
  for (let attempt = 2; attempt <= 5; attempt++) {
    const sending = reopened.beginDelivery(first.id);
    assert.equal(sending.attempts, attempt);
    reopened.finishDelivery(first.id, { state: 'pending', error: 'retryable transport error' });
  }
  assert.equal(reopened.snapshot().deliveries[0]?.state, 'failed');
  assert.equal(reopened.pendingDeliveries(new Date().toISOString()).length, 0);
  reopened.controlDelivery({ commandId: 'checked-delivered', deliveryId: first.id, expectedState: 'failed', action: 'mark_delivered' });
  assert.equal(reopened.pendingDeliveries(new Date().toISOString())[0]?.updateId, 'two');
});

test('callback enqueue is atomic and large report text is bounded with an explicit truncation marker', t => {
  const { open } = fixture(t);
  const store = open();
  subscribed(store);
  assert.throws(() => store.queueUpdates([update('good'), { ...update('invalid'), revision: 0 }]), /Invalid task update/);
  assert.equal(store.snapshot().deliveries.length, 0);
  store.queueUpdates([{ ...update('large'), text: '证据'.repeat(20_000) }]);
  const payload = store.snapshot().deliveries[0]!.payload;
  assert.ok(Buffer.byteLength(payload.text as string) <= 32 * 1024);
  assert.match(payload.text as string, /truncated/);
  assert.equal((payload.text as string).includes('\ufffd'), false);
});

test('a full callback backlog still exposes delivery work and admits its next stable row after a slot drains', t => {
  const { open } = fixture(t);
  const store = open();
  subscribed(store);
  const updates = Array.from({ length: 4097 }, (_, index) => update(`update-${index}`));
  store.queueUpdates(updates);
  const first = store.pendingDeliveries(new Date().toISOString())[0]!;
  assert.equal(first.updateId, 'update-0');
  assert.equal(store.snapshot().deliveries.at(-1)?.updateId, 'update-4095');
  store.beginDelivery(first.id);
  store.finishDelivery(first.id, { state: 'delivered' });
  store.queueUpdates(updates);
  assert.equal(store.snapshot().deliveries.at(-1)?.updateId, 'update-4096');
  assert.equal(store.pendingDeliveries(new Date().toISOString())[0]?.updateId, 'update-1');
});

test('manual callback decisions remain discoverable after more than one recent page of later deliveries', t => {
  const { open } = fixture(t);
  const store = open();
  subscribed(store, 'at-most-once');
  store.queueUpdates([update('old-uncertain')]);
  const first = store.pendingDeliveries(new Date().toISOString())[0]!;
  store.beginDelivery(first.id);
  store.finishDelivery(first.id, { state: 'uncertain', error: 'Remote response was lost' });
  store.putSubscription({
    commandId: 'other-subscription', subscriptionId: 'other-subscription', sourceId: 'source',
    threadId: 'other-thread', taskId: 'other-task', enabled: true,
  });
  for (let index = 0; index < 105; index++) {
    store.queueUpdates([update(`other-${index}`, 'other-task')]);
    const next = store.pendingDeliveries(new Date().toISOString())[0]!;
    store.beginDelivery(next.id);
    store.finishDelivery(next.id, { state: 'delivered' });
  }
  assert.equal(store.snapshot().deliveries.length, 100);
  assert.equal(store.snapshot().deliveries.find(row => row.id === first.id)?.state, 'uncertain');
  store.controlDelivery({ commandId: 'checked-old', deliveryId: first.id, expectedState: 'uncertain', action: 'mark_delivered' });
  assert.equal(store.snapshot().deliveries.some(row => row.id === first.id), false);
});

test('snapshots bound serialized bytes and recent count even when JSON escaping expands accepted input', t => {
  const { open } = fixture(t);
  const store = open();
  source(store);
  for (let index = 0; index < 120; index++) receive(store, `event-${index}`, 'thread', '\x01'.repeat(32_000));
  const snapshot = store.snapshot();
  assert.ok(snapshot.triggers.length <= 100);
  assert.ok(snapshot.triggers.length > 0);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) <= 7 * 1024 * 1024);
  assert.equal(snapshot.triggers.at(-1)?.eventId, 'event-119');
  assert.throws(() => receive(store, 'too-big', 'thread', '语'.repeat(12_000)), /UTF-8 bytes/);
});

test('configuration limits reject atomically and preserve earlier stable receipts', t => {
  const { open } = fixture(t);
  const store = open();
  const first = source(store);
  for (let index = 1; index < 32; index++) source(store, { commandId: `create-${index}`, sourceId: `source-${index}` });
  assert.throws(() => source(store, { commandId: 'overflow', sourceId: 'overflow' }), /Source limit/);
  assert.equal(store.snapshot().sources.length, 32);
  assert.deepEqual(source(store), first);
  assert.throws(() => source(store, { commandId: 'rotate-stale', token: 'x'.repeat(32) }), /Record changed/);
  assert.equal(store.authenticate('source', TOKEN), true);
});

test('unsupported database version is rejected without rewriting the version', t => {
  const { path, open } = fixture(t);
  open().close();
  const db = new DatabaseSync(path);
  db.exec('PRAGMA user_version = 2');
  db.close();
  assert.throws(() => open(), /Unsupported integration store version/);
  const check = new DatabaseSync(path, { readOnly: true });
  try { assert.equal((check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 2); }
  finally { check.close(); }
});

test('snapshot byte pressure preserves the oldest manual decision before recent event history', t => {
  const store = fixture(t).open();
  subscribed(store, 'at-most-once');
  store.queueUpdates([{ ...update('old-uncertain-large'), text: '\x01'.repeat(32_000) }]);
  const first = store.pendingDeliveries(new Date().toISOString())[0]!;
  store.beginDelivery(first.id);
  store.finishDelivery(first.id, { state: 'uncertain', error: 'Remote acknowledgment was lost' });
  for (let index = 0; index < 100; index++) receive(store, `large-${index}`, 'thread', '\x01'.repeat(32_000));
  const snapshot = store.snapshot();
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) <= 7 * 1024 * 1024);
  assert.ok(snapshot.triggers.length > 0);
  assert.ok(snapshot.triggers.length < 100);
  assert.equal(snapshot.deliveries.find(row => row.id === first.id)?.state, 'uncertain');
  store.controlDelivery({ commandId: 'resolve-old-large', deliveryId: first.id, expectedState: 'uncertain', action: 'mark_delivered' });
  assert.equal(store.snapshot().deliveries.find(row => row.id === first.id)?.state, 'delivered');
});
