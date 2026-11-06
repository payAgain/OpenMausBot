import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { RuntimeStore, StoreConflictError } from '../src/store.ts';

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'personbot-ledger-'));
  const path = join(directory, 'runtime.sqlite');
  const stores: RuntimeStore[] = [];
  t.after(() => {
    for (const store of stores) store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    path,
    open() {
      const store = new RuntimeStore(path);
      stores.push(store);
      return store;
    },
  };
}

test('bindings and input receipts survive reopening with WAL, FULL and private database permissions', (t) => {
  const f = fixture(t);
  let store = f.open();
  const session = { sessionId: 'worker-one', taskId: 'task-one', cwd: '/tmp/project' };
  const input = { commandId: 'command-one', sessionId: 'worker-one', messageId: 'message-one', text: '继续原任务\n保留上下文', mode: 'followup' as const };
  assert.deepEqual(store.createSession(session), session);
  assert.equal(store.beginInput(input).state, 'accepted');
  store.close();
  store = f.open();
  assert.deepEqual(store.getSession(session.sessionId), session);
  assert.deepEqual(store.listSessions(), [session]);
  assert.deepEqual(store.pendingInputs(session.sessionId), [{ ...input, state: 'accepted' }]);
  assert.equal(store.markQueued(input.commandId).state, 'queued');
  store.close();
  store = f.open();
  assert.deepEqual(store.pendingInputs(session.sessionId), []);
  assert.deepEqual(store.beginInput(input), { ...input, state: 'queued' });
  if (process.platform !== 'win32') assert.equal(statSync(f.path).mode & 0o777, 0o600);
  const db = new DatabaseSync(f.path);
  try {
    assert.equal(db.prepare('PRAGMA journal_mode').get()?.journal_mode, 'wal');
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 5);
  } finally {
    db.close();
  }
});

test('identical session retries preserve one binding and changed bindings are rejected', (t) => {
  const store = fixture(t).open();
  const session = { sessionId: 'chat-one', conversationId: 'conversation-one', cwd: '/tmp/workspace' };
  assert.deepEqual(store.createSession(session), session);
  assert.deepEqual(store.createSession({ ...session }), session);
  assert.throws(() => store.createSession({ ...session, cwd: '/tmp/other' }), StoreConflictError);
  assert.throws(() => store.createSession({ ...session, conversationId: undefined, taskId: 'task-one' }), StoreConflictError);
  assert.throws(() => store.createSession({ ...session, taskId: 'task-one' }), TypeError);
  assert.deepEqual(store.listSessions(), [session]);
});

test('role and project snapshots stay bound while accepted input keeps its original memory revision after reopening', t => {
  const f = fixture(t);
  let store = f.open();
  const session = {
    sessionId: 'bound', cwd: '/tmp/project', conversationId: 'conversation',
    projectId: 'project', project: { id: 'project', path: '/tmp/project', kind: 'git' as const },
    roleId: 'reviewer', roleRevision: 3, roleInstructions: 'Check concrete evidence.',
  };
  store.createSession(session);
  const input = { commandId: 'context-input', sessionId: 'bound', messageId: 'context-message', text: 'Continue', mode: 'followup' as const };
  const original = { text: 'The corrected fact.', roleId: 'reviewer', roleRevision: 3, memories: [{ id: 'preference', revision: 2 }] };
  store.beginInput(input, () => original);
  assert.deepEqual(store.inputContext(input.commandId, () => { throw new Error('The accepted input must already own its context'); }), original);
  const failed = { ...input, commandId: 'failed-context', messageId: 'failed-message' };
  assert.throws(() => store.beginInput(failed, () => { throw new Error('Context cannot be frozen'); }), /cannot be frozen/);
  assert.equal(store.getInput(failed.commandId), undefined);
  store.close();
  store = f.open();
  assert.deepEqual(store.getSession('bound'), session);
  assert.deepEqual(store.inputContext(input.commandId, () => {
    throw new Error('A replay must not retrieve newer memory');
  }), original);
  assert.throws(() => store.createSession({ ...session, roleRevision: 4 }), StoreConflictError);
  assert.throws(() => store.createSession({ ...session, project: { ...session.project, path: '/tmp/elsewhere' } }), StoreConflictError);
});

test('input acceptance and its frozen context commit together and context failure leaves no reserved command', t => {
  const f = fixture(t);
  let store = f.open();
  store.createSession({ sessionId: 'bound', cwd: '/tmp/project', conversationId: 'conversation' });
  const input = { commandId: 'atomic-context', sessionId: 'bound', messageId: 'context-message', text: 'Continue', mode: 'followup' as const };
  assert.throws(() => store.beginInput(input, () => {
    throw new Error('Fixture failed before the context snapshot could be frozen');
  }), /Fixture failed/);
  assert.equal(store.getInput(input.commandId), undefined);
  assert.deepEqual(store.pendingInputs('bound'), []);
  const original = { text: 'Fact at initial acceptance.', memories: [{ id: 'preference', revision: 2 }] };
  assert.equal(store.beginInput(input, () => original).state, 'accepted');
  store.close();
  store = f.open();
  assert.equal(store.beginInput(input, () => {
    throw new Error('A receipt retry must not read newer memory');
  }).state, 'accepted');
  assert.deepEqual(store.inputContext(input.commandId, () => {
    throw new Error('A recovered input must already have its original context');
  }), original);
});

test('a version-four runtime store upgrades without changing legacy Session bindings or accepted inputs', t => {
  const f = fixture(t);
  const session = { sessionId: 'legacy', cwd: '/tmp/legacy', conversationId: 'conversation' };
  let store = f.open();
  store.createSession(session);
  const input = { commandId: 'legacy-input', sessionId: 'legacy', messageId: 'legacy-message', text: 'Keep context', mode: 'followup' as const };
  store.beginInput(input);
  store.close();
  const db = new DatabaseSync(f.path);
  try {
    db.exec('DROP TABLE input_context; ALTER TABLE sessions DROP COLUMN binding; PRAGMA user_version = 4;');
  } finally { db.close(); }
  store = f.open();
  assert.deepEqual(store.getSession('legacy'), session);
  assert.deepEqual(store.pendingInputs('legacy'), [{ ...input, state: 'accepted' }]);
  assert.deepEqual(store.inputContext(input.commandId, () => ({ text: '', memories: [] })), { text: '', memories: [] });
});

test('command identities are global and message identities are unique within each Session', (t) => {
  const store = fixture(t).open();
  for (const sessionId of ['one', 'two']) store.createSession({ sessionId, cwd: '/tmp/project' });
  const input = { commandId: 'command-one', sessionId: 'one', messageId: 'message-one', text: 'work', mode: 'followup' as const };
  const accepted = store.beginInput(input);
  assert.deepEqual(store.beginInput(input), accepted);
  assert.throws(() => store.beginInput({ ...input, text: 'changed' }), StoreConflictError);
  assert.throws(() => store.beginInput({ ...input, mode: 'steer' }), StoreConflictError);
  assert.throws(() => store.beginInput({ ...input, sessionId: 'two' }), StoreConflictError);
  assert.throws(() => store.beginInput({ ...input, commandId: 'new-command' }), StoreConflictError);
  assert.equal(store.beginInput({ ...input, commandId: 'second-command', sessionId: 'two' }).state, 'accepted');
  assert.deepEqual(store.pendingInputs('one'), [accepted]);
  assert.throws(() => store.beginInput({ ...input, commandId: 'orphan', sessionId: 'missing' }), /Unknown Session/);
});

test('stop cancellation only changes undelivered inputs of its Session', (t) => {
  const store = fixture(t).open();
  for (const sessionId of ['one', 'two']) store.createSession({ sessionId, cwd: '/tmp/project' });
  const input = { commandId: 'queued', sessionId: 'one', messageId: 'message-queued', text: 'work', mode: 'followup' as const };
  store.beginInput(input);
  store.markQueued('queued');
  store.beginInput({ ...input, commandId: 'cancelled', messageId: 'message-cancelled' });
  store.beginInput({ ...input, commandId: 'unaffected', messageId: 'message-unaffected', sessionId: 'two' });
  assert.equal(store.cancelPending('one'), 1);
  assert.equal(store.cancelPending('one'), 0);
  assert.equal(store.getInput('queued')?.state, 'queued');
  assert.equal(store.getInput('cancelled')?.state, 'cancelled');
  assert.equal(store.getInput('unaffected')?.state, 'accepted');
  assert.equal(store.beginInput({ ...input, commandId: 'cancelled', messageId: 'message-cancelled' }).state, 'cancelled');
  assert.throws(() => store.markQueued('cancelled'), StoreConflictError);
  assert.throws(() => store.markQueued('missing'), /Unknown input command/);
  assert.deepEqual(store.pendingInputs('one'), []);
  assert.equal(store.pendingInputs('two').length, 1);
});
