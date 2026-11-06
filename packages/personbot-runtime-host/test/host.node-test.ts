import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { spawnRuntime, RuntimeProtocolError, RuntimeRpcError } from '../src/index.ts';

const fixture = fileURLToPath(new URL('./fixture.mjs', import.meta.url));

function launch(mode = 'normal', extra: Parameters<typeof spawnRuntime>[0] = { command: process.execPath }) {
  return spawnRuntime({
    ...extra,
    command: process.execPath,
    args: [fixture, mode],
    defaultTimeoutMs: 2_000,
  });
}

test('correlates concurrent requests and forwards domain notifications', async t => {
  const host = launch();
  t.after(() => host.close());
  const notifications: unknown[] = [];
  const unsubscribe = host.onNotification(event => notifications.push(event));
  const slow = host.request('later', { delay: 40, value: 'slow' });
  const fast = host.request('later', { delay: 0, value: 'fast' });
  assert.equal(await fast, 'fast');
  assert.equal(await slow, 'slow');
  assert.deepEqual(await host.request('echo', { text: '你好' }), { text: '你好' });
  assert.equal(await host.request('fragmented'), '你好');
  await host.request('notify');
  assert.deepEqual(notifications, [{ method: 'personbot.v1.event', params: { type: 'fixture.progress' } }]);
  unsubscribe();
  await host.request('notify');
  assert.equal(notifications.length, 1);
});

test('preserves structured RPC errors without poisoning the connection', async t => {
  const host = launch();
  t.after(() => host.close());
  await assert.rejects(host.request('error'), error => {
    assert.ok(error instanceof RuntimeRpcError);
    assert.equal(error.code, -32001);
    assert.deepEqual(error.data, { reason: 'fixture' });
    return true;
  });
  assert.deepEqual(await host.request('echo', { alive: true }), { alive: true });
});

test('timeout and abort reject local waits while late replies remain harmless', async t => {
  const host = launch();
  t.after(() => host.close());
  await host.request('echo');
  await assert.rejects(host.request('later', { delay: 50, value: 'late' }, { timeoutMs: 5 }), /timed out/);
  const controller = new AbortController();
  const aborted = host.request('later', { delay: 50, value: 'aborted' }, { signal: controller.signal });
  controller.abort(new Error('Caller stopped waiting'));
  await assert.rejects(aborted, /Caller stopped waiting/);
  await host.request('later', { delay: 80, value: 'barrier' });
  assert.equal(await host.request('later', { delay: 0, value: 'still alive' }), 'still alive');
  await assert.rejects(host.request('echo', {}, { signal: controller.signal }), /Caller stopped waiting/);
});

test('child exit rejects every pending request and later calls', async t => {
  const host = launch();
  t.after(() => host.close());
  const pending = assert.rejects(host.request('later', { delay: 60_000 }), /Runtime exited/);
  const exitRequest = assert.rejects(host.request('exit'), /Runtime exited/);
  await Promise.all([pending, exitRequest]);
  assert.equal((await host.closed).code, 7);
  await assert.rejects(host.request('echo'), /closed/);
});

test('spawn failure is observable without an unhandled child error', async t => {
  const host = spawnRuntime({ command: '/personbot-fixture/nonexistent-executable' });
  t.after(() => host.close());
  await assert.rejects(host.request('echo'), /ENOENT/);
  assert.match((await host.closed).error?.message ?? '', /ENOENT/);
});

for (const method of ['bad-json', 'bad-response', 'oversize']) {
  test(`rejects protocol corruption: ${method}`, async t => {
    const host = launch('normal', { command: process.execPath, maxLineBytes: 512 });
    t.after(() => host.close());
    await assert.rejects(host.request(method, { size: 513 }), RuntimeProtocolError);
    assert.ok((await host.closed).error instanceof RuntimeProtocolError);
  });
}

test('bounds diagnostic stderr and exits gracefully', async () => {
  const host = launch('normal', { command: process.execPath, stderrLimitBytes: 16 });
  await host.request('stderr', { text: `${'x'.repeat(100)}tail` });
  assert.equal(host.stderrTail, `${'x'.repeat(12)}tail`);
  const result = await host.close();
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.equal(await host.close(), result);
  await assert.rejects(host.request('echo'), /closed/);
});

test('close escalates an unresponsive owned child to SIGKILL', async () => {
  const host = launch('ignore-signals');
  await host.request('echo');
  const pending = assert.rejects(host.request('later', { delay: 60_000 }), /Runtime exited/);
  const result = await host.close({ graceMs: 20, terminateMs: 20 });
  await pending;
  assert.equal(result.signal, 'SIGKILL');
});

test('invalid limits fail before launching a child', () => {
  assert.throws(() => spawnRuntime({ command: process.execPath, defaultTimeoutMs: -1 }), RangeError);
  assert.throws(() => spawnRuntime({ command: process.execPath, maxLineBytes: 0 }), RangeError);
});

test('notification consumer failures report errors and preserve other listeners and pending work', async t => {
  const errors: Error[] = [];
  const host = launch('normal', {
    command: process.execPath,
    onNotificationError: error => {
      errors.push(error);
      throw new Error('Diagnostic consumer failed');
    },
  });
  t.after(() => host.close());
  const notifications: unknown[] = [];
  host.onNotification(() => { throw new Error('Projection failed'); });
  host.onNotification(notification => notifications.push(notification));
  const pending = host.request('later', { delay: 20, value: 'still pending' });
  assert.deepEqual(await host.request('notify'), {});
  assert.equal(await pending, 'still pending');
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.message, 'Projection failed');
  assert.deepEqual(notifications, [{ method: 'personbot.v1.event', params: { type: 'fixture.progress' } }]);
  assert.deepEqual(await host.request('echo', { alive: true }), { alive: true });
  const result = await host.close();
  assert.equal(result.code, 0);
  assert.equal(result.error, undefined);
});

test('notification consumer failure without an error hook leaves the transport usable', async t => {
  const host = launch();
  t.after(() => host.close());
  host.onNotification(() => { throw new Error('Projection failed'); });
  assert.deepEqual(await host.request('notify'), {});
  assert.deepEqual(await host.request('echo', { alive: true }), { alive: true });
});
