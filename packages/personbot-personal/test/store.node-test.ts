import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { PersonalConflictError, PersonalStore } from '../src/index.ts';
import { localGit } from '../src/git.ts';

function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'personbot-personal-')));
  const home = join(root, 'home');
  const workspace = join(root, 'source');
  mkdirSync(workspace);
  const stores: PersonalStore[] = [];
  const open = () => {
    const store = new PersonalStore(home, { workspace });
    stores.push(store);
    return store;
  };
  t.after(() => {
    for (const store of stores) store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, home, workspace, open };
}

function memory(store: PersonalStore, id: string, value: string, key = 'language') {
  return store.putMemory({ commandId: `put-${id}`, memoryId: id, scope: 'personal', key, value });
}

test('default project and role persist with private SQLite permissions and independent snapshots', t => {
  const { home, workspace, open } = fixture(t);
  const first = open();
  const snapshot = first.snapshot();
  assert.equal(snapshot.projects[0]?.id, 'default');
  assert.equal(snapshot.projects[0]?.path, workspace);
  assert.equal(snapshot.roles[0]?.id, 'assistant');
  assert.equal(statSync(join(home, 'runtime', 'personal.sqlite')).mode & 0o777, 0o600);
  first.close();
  const reopened = open();
  assert.deepEqual(reopened.snapshot(), snapshot);
  snapshot.projects[0]!.name = 'Changed only locally';
  assert.notEqual(reopened.getProject('default')?.name, snapshot.projects[0]?.name);
});

test('projects canonicalize directories, require Git repository roots and replay before filesystem validation', async t => {
  const { root, workspace, open } = fixture(t);
  const store = open();
  const alias = join(root, 'alias');
  symlinkSync(workspace, alias);
  const params = { commandId: 'project-put', projectId: 'work', name: 'Work', path: alias, kind: 'directory' as const };
  const project = await store.putProject(params);
  assert.equal(project.path, workspace);
  await assert.rejects(store.putProject({ ...params, commandId: 'wrong-kind', projectId: 'nongit', kind: 'git' }));
  await localGit(workspace, 'init');
  const repository = await store.putProject({ ...params, commandId: 'git-put', projectId: 'repo', path: workspace, kind: 'git' });
  assert.equal(repository.kind, 'git');
  const subdir = join(workspace, 'sub');
  mkdirSync(subdir);
  await assert.rejects(store.putProject({ ...params, commandId: 'subdir', projectId: 'subdir', path: subdir, kind: 'git' }), /repository root/);
  rmSync(alias);
  assert.deepEqual(await store.putProject(params), project);
  await assert.rejects(store.putProject({ ...params, name: 'Changed' }), PersonalConflictError);
});

test('role revisions reject stale writes while stable retries return their original result', t => {
  const { open } = fixture(t);
  const store = open();
  const params = { commandId: 'role-create', roleId: 'reviewer', name: 'Reviewer', instructions: 'Check evidence.' };
  const first = store.putRole(params);
  const second = store.putRole({ ...params, commandId: 'role-edit', expectedRevision: 1, instructions: 'Check evidence and limitations.' });
  assert.equal(second.revision, 2);
  assert.deepEqual(store.putRole(params), first);
  assert.throws(() => store.putRole({ ...params, commandId: 'stale-role-edit', expectedRevision: 1 }), /Record changed/);
  const third = store.putRole({ ...params, commandId: 'stale-role-edit', expectedRevision: 2 });
  assert.equal(third.revision, 3);
  assert.throws(() => store.putRole({ ...params, instructions: 'Changed retry body' }), /different operation/);
});

test('human corrections atomically supersede one logical key and keep immutable history across restart', t => {
  const { home, open } = fixture(t);
  const store = open();
  const first = memory(store, 'old', 'English');
  const correction = memory(store, 'corrected', '中文');
  assert.equal(store.snapshot().memories.find(row => row.id === first.id)?.status, 'superseded');
  assert.deepEqual(store.context().memories.map(row => row.value), ['中文']);
  const edited = store.putMemory({
    commandId: 'correction-edit', memoryId: correction.id, expectedRevision: correction.revision,
    scope: 'personal', key: 'language', value: '日本語',
  });
  assert.equal(edited.revision, 2);
  assert.deepEqual(memory(store, 'corrected', '中文'), correction);
  const db = new DatabaseSync(join(home, 'runtime', 'personal.sqlite'), { readOnly: true });
  try {
    const history = db.prepare('SELECT data FROM memory_history WHERE memory_id = ? ORDER BY id').all(correction.id) as { data: string }[];
    assert.deepEqual(history.map(row => (JSON.parse(row.data) as { value: string }).value), ['中文', '日本語']);
  } finally { db.close(); }
  store.close();
  const reopened = open();
  assert.deepEqual(reopened.context().memories.map(row => row.value), ['日本語']);
  assert.equal(reopened.snapshot().memories.filter(row => row.status === 'active').length, 1);
  assert.throws(() => reopened.putMemory({
    commandId: 'change-key', memoryId: correction.id, expectedRevision: 2, scope: 'personal', key: 'other', value: 'Other',
  }), /cannot change its scope or key/);
});

test('agent proposals remain inactive until explicit confirmation and cannot overwrite later corrections', t => {
  const { open } = fixture(t);
  const store = open();
  memory(store, 'original', 'English');
  const params = { commandId: 'proposal', memoryId: 'proposal', scope: 'personal' as const, key: 'language', value: '中文', sourceSessionId: 'main' };
  const proposed = store.proposeMemory(params);
  assert.equal(proposed.status, 'proposed');
  assert.deepEqual(store.context().memories.map(row => row.value), ['English']);
  assert.equal(store.search('中文').length, 0);
  memory(store, 'user-correction', '日本語');
  store.close();
  const reopened = open();
  assert.throws(() => reopened.controlMemory({ commandId: 'confirm-stale', memoryId: proposed.id, expectedRevision: proposed.revision, action: 'confirm' }), /changed after this proposal/);
  assert.deepEqual(reopened.context().memories.map(row => row.value), ['日本語']);
  assert.deepEqual(reopened.proposeMemory(params), proposed);
  const fresh = reopened.proposeMemory({ ...params, commandId: 'fresh-proposal', memoryId: 'fresh-proposal', value: '中文和日本語' });
  const active = reopened.controlMemory({ commandId: 'confirm-fresh', memoryId: fresh.id, expectedRevision: fresh.revision, action: 'confirm' });
  assert.equal(active.status, 'active');
  assert.equal(active.source, 'agent');
  assert.deepEqual(reopened.context().memories.map(row => row.value), ['中文和日本語']);
});

test('forgetting removes active memory from context and invalidates proposals based on the forgotten key', t => {
  const { open } = fixture(t);
  const store = open();
  const active = memory(store, 'active', 'English');
  const proposal = store.proposeMemory({ commandId: 'proposal', memoryId: 'proposal', scope: 'personal', key: 'language', value: '中文', sourceSessionId: 'main' });
  const params = { commandId: 'forget', memoryId: active.id, expectedRevision: active.revision, action: 'forget' as const };
  const forgotten = store.controlMemory(params);
  assert.equal(forgotten.status, 'forgotten');
  assert.deepEqual(store.context().memories, []);
  assert.deepEqual(store.search('English'), []);
  assert.throws(() => store.controlMemory({ commandId: 'confirm', memoryId: proposal.id, expectedRevision: proposal.revision, action: 'confirm' }), /changed after this proposal/);
  memory(store, 'new', 'Other value');
  assert.deepEqual(store.controlMemory(params), forgotten);
  assert.deepEqual(store.context().memories.map(row => row.value), ['Other value']);
});

test('personal and project memory scopes stay isolated and prompt context is bounded', async t => {
  const { root, open } = fixture(t);
  const store = open();
  const otherPath = join(root, 'other');
  mkdirSync(otherPath);
  await store.putProject({ commandId: 'other-project', projectId: 'other', name: 'Other', path: otherPath, kind: 'directory' });
  memory(store, 'personal', 'Personal preference', 'preferences');
  store.putMemory({ commandId: 'default-memory', memoryId: 'default-memory', scope: 'project', projectId: 'default', key: 'project', value: 'Default project' });
  store.putMemory({ commandId: 'other-memory', memoryId: 'other-memory', scope: 'project', projectId: 'other', key: 'project', value: 'Other project' });
  assert.deepEqual(store.context().memories.map(row => row.id), ['personal']);
  assert.deepEqual(new Set(store.context('default').memories.map(row => row.id)), new Set(['personal', 'default-memory']));
  assert.deepEqual(store.search('project', 'default').map(row => row.id), ['default-memory']);
  assert.equal(store.search('Other', 'default').length, 0);
  for (let i = 0; i < 10; i++) memory(store, `long-${i}`, 'x'.repeat(30_000), `long-${i}`);
  const context = store.context();
  assert.ok(context.text.length <= 65_536);
  assert.ok(context.memories.length <= 40);
  assert.throws(() => store.putMemory({ commandId: 'bad-scope', memoryId: 'bad-scope', scope: 'personal', projectId: 'other', key: 'x', value: 'x' }), /cannot have a projectId/);
  assert.throws(() => store.putMemory({ commandId: 'missing-project', memoryId: 'missing-project', scope: 'project', projectId: 'missing', key: 'x', value: 'x' }), /does not exist/);
});

test('unsupported schema versions are rejected without rewriting existing data', t => {
  const { home, open } = fixture(t);
  open().close();
  const path = join(home, 'runtime', 'personal.sqlite');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA user_version = 2');
  db.close();
  assert.throws(() => open(), /Unsupported personal store version/);
  const check = new DatabaseSync(path);
  try { assert.equal((check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 2); }
  finally { check.close(); }
});
