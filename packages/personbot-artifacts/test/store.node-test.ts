import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';
import {
  ArtifactConflictError,
  ArtifactStore,
  MAX_ARTIFACT_BYTES,
  MAX_ARTIFACT_CHUNK_BYTES,
  type PublishArtifactParams,
} from '../src/index.ts';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'personbot-artifact-test-'));
  const home = join(directory, 'home');
  const cwd = join(directory, 'workspace');
  await mkdir(home);
  await mkdir(cwd);
  const stores = new Set<ArtifactStore>();
  const start = () => {
    const store = new ArtifactStore(home);
    stores.add(store);
    return store;
  };
  t.after(async () => {
    for (const store of stores) store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const request = (path = 'result.md', extra: Partial<PublishArtifactParams> = {}): PublishArtifactParams => ({
    commandId: randomUUID(),
    artifactId: randomUUID(),
    sessionId: 'worker-task',
    originSessionId: 'main',
    taskId: 'task',
    executionId: 'execution',
    projectId: 'project',
    cwd,
    path,
    ...extra,
  });
  return { directory, home, cwd, start, request };
}

test('published bytes are immutable, attributed and available after source deletion and store restart', async t => {
  const { home, cwd, start, request } = await fixture(t);
  let store = start();
  const bytes = Buffer.from('# 独立产物\n\nverified output\n');
  await writeFile(join(cwd, 'result.md'), bytes);
  const record = await store.publish(request());
  assert.equal(record.name, 'result.md');
  assert.equal(record.mediaType, 'text/markdown');
  assert.equal(record.size, bytes.length);
  assert.equal(record.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(record.sessionId, 'worker-task');
  assert.equal(record.originSessionId, 'main');
  assert.equal(record.taskId, 'task');
  assert.equal(record.executionId, 'execution');
  assert.equal(record.projectId, 'project');
  assert.equal((await stat(join(home, 'runtime', 'artifacts.sqlite'))).mode & 0o777, 0o600);
  assert.equal((await stat(join(home, 'artifacts', 'blobs', record.sha256))).mode & 0o777, 0o600);
  await writeFile(join(cwd, 'result.md'), 'changed source');
  assert.deepEqual(Buffer.from((await store.read({ artifactId: record.id })).dataBase64, 'base64'), bytes);
  await unlink(join(cwd, 'result.md'));
  store.close();
  store = start();
  assert.deepEqual(store.get(record.id), record);
  assert.deepEqual(store.list().artifacts, [record]);
  const chunk = await store.read({ artifactId: record.id });
  assert.deepEqual(Buffer.from(chunk.dataBase64, 'base64'), bytes);
  assert.equal(chunk.offset, 0);
  assert.equal(chunk.nextOffset, record.size);
  assert.equal(chunk.eof, true);
});

test('stable command replay happens before filesystem access and conflicting identities cannot replace artifacts', async t => {
  const { cwd, start, request } = await fixture(t);
  const store = start();
  await writeFile(join(cwd, 'result.md'), 'original bytes');
  const params = request();
  const record = await store.publish(params);
  await unlink(join(cwd, 'result.md'));
  assert.deepEqual(await store.publish(params), record);
  await assert.rejects(store.publish({ ...params, path: 'other.md' }), ArtifactConflictError);
  await assert.rejects(store.publish({ ...params, originSessionId: 'another-origin' }), ArtifactConflictError);
  await assert.rejects(store.publish({ ...params, name: 'renamed.md' }), ArtifactConflictError);
  await assert.rejects(store.publish({ ...params, commandId: randomUUID() }), ArtifactConflictError);
  assert.equal(store.list().artifacts.length, 1);
  assert.equal(Buffer.from((await store.read({ artifactId: record.id })).dataBase64, 'base64').toString(), 'original bytes');
});

test('concurrent repeated publication has one receipt and a failed request does not reserve its command', async t => {
  const { cwd, start, request } = await fixture(t);
  const store = start();
  const missing = request('not-yet.txt');
  await assert.rejects(store.publish(missing), { code: 'ENOENT' });
  await writeFile(join(cwd, 'not-yet.txt'), 'now present');
  const results = await Promise.all(Array.from({ length: 8 }, () => store.publish(missing)));
  for (const result of results) assert.deepEqual(result, results[0]);
  assert.equal(store.list().artifacts.length, 1);
  await assert.rejects(store.publish({ ...missing, sessionId: 'conflicting-owner' }), ArtifactConflictError);
  await writeFile(join(cwd, 'next.txt'), 'queue remains usable');
  await store.publish(request('next.txt'));
  assert.equal(store.list().artifacts.length, 2);
});

test('source paths must be regular files inside the canonical Session workspace', async t => {
  const { directory, cwd, start, request } = await fixture(t);
  const store = start();
  await writeFile(join(directory, 'outside.txt'), 'private outside bytes');
  await writeFile(join(cwd, 'inside.txt'), 'allowed bytes');
  await mkdir(join(cwd, 'folder'));
  await symlink(join(directory, 'outside.txt'), join(cwd, 'escape.txt'));
  await symlink(directory, join(cwd, 'escape-directory'));
  await symlink(join(cwd, 'inside.txt'), join(cwd, 'internal-link.txt'));
  await assert.rejects(store.publish(request('../outside.txt')), /workspace/);
  await assert.rejects(store.publish(request(join(directory, 'outside.txt'))), /workspace/);
  await assert.rejects(store.publish(request('escape.txt')), /symlink|workspace/);
  await assert.rejects(store.publish(request('escape-directory/outside.txt')), /symlink|workspace/);
  await assert.rejects(store.publish(request('folder')), /regular file/);
  await assert.rejects(store.publish(request('.', { name: 'directory' })), /workspace/);
  const internal = await store.publish(request('internal-link.txt'));
  assert.equal(Buffer.from((await store.read({ artifactId: internal.id })).dataBase64, 'base64').toString(), 'allowed bytes');
  assert.equal(store.list().artifacts.length, 1);
});

test('non-regular sources are rejected without waiting for a FIFO writer', { skip: process.platform === 'win32', timeout: 5_000 }, async t => {
  const { cwd, start, request } = await fixture(t);
  const store = start();
  await promisify(execFile)('mkfifo', [join(cwd, 'pipe')]);
  await assert.rejects(store.publish(request('pipe')), /regular file/);
  assert.equal(store.list().artifacts.length, 0);
});

test('binary artifacts support bounded exact chunk reads and empty EOF', async t => {
  const { cwd, start, request } = await fixture(t);
  const store = start();
  const bytes = randomBytes(MAX_ARTIFACT_CHUNK_BYTES + 37);
  await writeFile(join(cwd, 'binary.bin'), bytes);
  const record = await store.publish(request('binary.bin', { name: 'download.bin' }));
  assert.equal(record.mediaType, 'application/octet-stream');
  const chunks: Buffer[] = [];
  let offset = 0;
  for (;;) {
    const chunk = await store.read({ artifactId: record.id, offset, limit: 128 * 1024 });
    const data = Buffer.from(chunk.dataBase64, 'base64');
    assert.equal(chunk.offset, offset);
    assert.equal(chunk.nextOffset, offset + data.length);
    assert.ok(data.length <= 128 * 1024);
    chunks.push(data);
    offset = chunk.nextOffset;
    if (chunk.eof) break;
  }
  assert.deepEqual(Buffer.concat(chunks), bytes);
  const eof = await store.read({ artifactId: record.id, offset: record.size });
  assert.equal(eof.eof, true);
  assert.equal(eof.dataBase64, '');
  assert.equal(eof.nextOffset, record.size);
  for (const invalid of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, record.size + 1]) {
    await assert.rejects(store.read({ artifactId: record.id, offset: invalid }), /offset/);
  }
  for (const invalid of [0, -1, 0.5, Number.NaN, MAX_ARTIFACT_CHUNK_BYTES + 1]) {
    await assert.rejects(store.read({ artifactId: record.id, limit: invalid }), /limit/);
  }
});

test('empty files are valid artifacts and the 20 MiB publication limit is enforced', async t => {
  const { cwd, start, request } = await fixture(t);
  const store = start();
  await writeFile(join(cwd, 'empty.txt'), '');
  const empty = await store.publish(request('empty.txt'));
  assert.equal(empty.size, 0);
  assert.equal((await store.read({ artifactId: empty.id })).eof, true);
  const file = await open(join(cwd, 'limit.bin'), 'w');
  try {
    await file.truncate(MAX_ARTIFACT_BYTES + 1);
  } finally {
    await file.close();
  }
  await assert.rejects(store.publish(request('limit.bin')), /20 MiB/);
  assert.equal(store.list().artifacts.length, 1);
  const limit = await open(join(cwd, 'limit.bin'), 'w');
  try {
    await limit.truncate(MAX_ARTIFACT_BYTES);
  } finally {
    await limit.close();
  }
  const maximum = await store.publish(request('limit.bin'));
  assert.equal(maximum.size, MAX_ARTIFACT_BYTES);
  const tail = await store.read({ artifactId: maximum.id, offset: MAX_ARTIFACT_BYTES - 3 });
  assert.equal(Buffer.from(tail.dataBase64, 'base64').length, 3);
  assert.equal(tail.eof, true);
});

test('blob hash, size and missing-file validation prevent serving changed immutable content', async t => {
  const { home, cwd, start, request } = await fixture(t);
  const store = start();
  await writeFile(join(cwd, 'result.md'), 'original');
  const record = await store.publish(request());
  const blob = join(home, 'artifacts', 'blobs', record.sha256);
  await writeFile(blob, 'modified');
  await assert.rejects(store.read({ artifactId: record.id }), /integrity/);
  await writeFile(blob, 'size changed');
  await assert.rejects(store.read({ artifactId: record.id }), /invalid/);
  await unlink(blob);
  await assert.rejects(store.read({ artifactId: record.id }), /missing/);
  assert.deepEqual(store.get(record.id), record);
});

test('an immutable blob cannot be replaced with a symlink to another filesystem path', async t => {
  const { directory, home, cwd, start, request } = await fixture(t);
  const store = start();
  await writeFile(join(cwd, 'result.md'), 'original');
  const record = await store.publish(request());
  const blob = join(home, 'artifacts', 'blobs', record.sha256);
  await unlink(blob);
  await writeFile(join(directory, 'outside.txt'), 'original');
  await symlink(join(directory, 'outside.txt'), blob);
  await assert.rejects(store.read({ artifactId: record.id }), /invalid|inaccessible/);
});

test('origin and task filters preserve attribution and returned snapshots cannot mutate stored records', async t => {
  const { cwd, start, request } = await fixture(t);
  const store = start();
  await writeFile(join(cwd, 'result.md'), 'shared bytes');
  const worker = await store.publish(request());
  const main = await store.publish(request('result.md', {
    sessionId: 'main', originSessionId: 'main', taskId: undefined, executionId: undefined,
  }));
  const other = await store.publish(request('result.md', {
    sessionId: 'other-worker', originSessionId: 'other-main', taskId: 'other-task',
  }));
  assert.deepEqual(store.list({ sessionId: 'main' }).artifacts.map(record => record.id), [worker.id, main.id]);
  assert.deepEqual(store.list({ sessionId: 'worker-task' }).artifacts.map(record => record.id), [worker.id]);
  assert.deepEqual(store.list({ sessionId: 'main', taskId: 'task' }).artifacts.map(record => record.id), [worker.id]);
  assert.deepEqual(store.list({ taskId: 'other-task' }).artifacts.map(record => record.id), [other.id]);
  assert.equal(store.list({ sessionId: 'main', taskId: 'other-task' }).artifacts.length, 0);
  const snapshot = store.list();
  snapshot.artifacts[0]!.name = 'mutated';
  const copy = store.get(worker.id)!;
  copy.sessionId = 'forged';
  assert.equal(store.get(worker.id)?.name, 'result.md');
  assert.equal(store.get(worker.id)?.sessionId, 'worker-task');
  assert.equal(store.get('missing'), undefined);
  await assert.rejects(store.read({ artifactId: 'missing' }), /Unknown/);
});

test('invalid metadata does not create records or consume publication commands', async t => {
  const { cwd, start, request } = await fixture(t);
  const store = start();
  await writeFile(join(cwd, 'result.md'), 'bytes');
  for (const name of ['../escape', 'folder/name', 'folder\\name', 'bad\r\nheader', '.', '', 'x'.repeat(257)]) {
    await assert.rejects(store.publish(request('result.md', { name })), /name/);
  }
  await assert.rejects(store.publish(request('result.md', { sessionId: '' })), /sessionId/);
  await assert.rejects(store.publish(request('result.md', { commandId: 'bad\0id' })), /commandId/);
  await assert.rejects(store.publish(request('result.md', { cwd: 'relative' })), /absolute/);
  assert.equal(store.list().artifacts.length, 0);
  await store.publish(request());
  assert.equal(store.list().artifacts.length, 1);
});

test('a future database version is rejected without modifying persisted metadata', async t => {
  const { home, cwd, start, request } = await fixture(t);
  const store = start();
  await writeFile(join(cwd, 'result.md'), 'preserved');
  const record = await store.publish(request());
  store.close();
  const path = join(home, 'runtime', 'artifacts.sqlite');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA user_version = 99');
  db.close();
  assert.throws(() => new ArtifactStore(home), /Unsupported artifact store version/);
  const check = new DatabaseSync(path);
  try {
    const row = check.prepare('SELECT data FROM artifacts WHERE id = ?').get(record.id) as { data: string };
    assert.deepEqual(JSON.parse(row.data), record);
    assert.equal((check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 99);
  } finally {
    check.close();
  }
  assert.equal(await readFile(join(home, 'artifacts', 'blobs', record.sha256), 'utf8'), 'preserved');
});
