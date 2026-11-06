import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import test, { type TestContext } from 'node:test';
import type { ChannelDeliveryRecord } from '../../personbot-protocol/src/index.ts';
import { deliverCallback, validateCallbackUrl } from '../src/index.ts';

async function fixture(t: TestContext, handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>) {
  const server = createServer((req, res) => { void Promise.resolve(handler(req, res)).catch(() => res.destroy()); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  return `http://127.0.0.1:${address.port}/callback`;
}

function delivery(url: string, overrides: Partial<ChannelDeliveryRecord> = {}): ChannelDeliveryRecord {
  return {
    id: 'callback-stable', sourceId: 'source', threadId: 'thread', taskId: 'task', updateId: 'update',
    url, mode: 'idempotent', state: 'sending', attempts: 1,
    createdAt: '2026-11-05T00:00:00Z', updatedAt: '2026-11-05T00:00:00Z',
    payload: { deliveryId: 'callback-stable', text: 'A verified result' },
    ...overrides,
  };
}

async function read(req: IncomingMessage): Promise<string> {
  const parts: Buffer[] = [];
  for await (const part of req) parts.push(Buffer.from(part));
  return Buffer.concat(parts).toString('utf8');
}

test('destinations reject credentials, fragments, cleartext remote and hostile loopback lookalikes', () => {
  for (const value of [
    'http://example.com/result', 'ftp://127.0.0.1/result', 'https://user:password@example.com/result',
    'https://example.com/result#fragment', 'https://example.com/result#',
    'http://127.0.0.1.evil.example/result', 'http://localhost.evil.example/result',
    'http://localhost./result', '/relative', 'https://example.com/\nheader',
  ]) assert.throws(() => validateCallbackUrl(value));
  assert.equal(validateCallbackUrl('https://example.com/result'), 'https://example.com/result');
  assert.equal(validateCallbackUrl('http://127.0.0.1:1234/result'), 'http://127.0.0.1:1234/result');
  assert.equal(validateCallbackUrl('http://[::1]:1234/result'), 'http://[::1]:1234/result');
});

test('successful callback sends immutable JSON and a stable idempotency key without consuming the response body', async t => {
  let seen: { key?: string; body: unknown } | undefined;
  const url = await fixture(t, async (req, res) => {
    seen = { key: req.headers['idempotency-key'] as string | undefined, body: JSON.parse(await read(req)) };
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('x'.repeat(512 * 1024));
  });
  const record = delivery(url);
  assert.deepEqual(await deliverCallback(record), { state: 'delivered' });
  assert.deepEqual(seen, { key: record.id, body: record.payload });
});

test('redirects are never followed and idempotent HTTP failures receive bounded retry timing', async t => {
  let targetCalls = 0;
  const target = await fixture(t, (_req, res) => { targetCalls++; res.end('unexpected'); });
  const url = await fixture(t, (_req, res) => { res.writeHead(302, { location: target }); res.end(); });
  const before = Date.now();
  const result = await deliverCallback(delivery(url));
  assert.equal(result.state, 'pending');
  assert.match(result.error!, /HTTP 302/);
  assert.ok(Date.parse(result.nextAttemptAt!) >= before + 900);
  assert.ok(Date.parse(result.nextAttemptAt!) <= Date.now() + 30_000);
  assert.equal(targetCalls, 0);
  assert.equal((await deliverCallback(delivery(url, { attempts: 5 }))).state, 'failed');
});

test('receiver idempotency can absorb a retry after accepting bytes and losing its first response', async t => {
  const keys: string[] = [];
  const uniqueEffects = new Set<string>();
  let calls = 0;
  const url = await fixture(t, async (req, res) => {
    await read(req);
    calls++;
    const key = String(req.headers['idempotency-key']);
    keys.push(key);
    uniqueEffects.add(key);
    if (calls === 1) req.socket.destroy();
    else { res.writeHead(204); res.end(); }
  });
  const first = await deliverCallback(delivery(url));
  assert.equal(first.state, 'pending');
  const second = await deliverCallback(delivery(url, { attempts: 2 }));
  assert.equal(second.state, 'delivered');
  assert.deepEqual(keys, ['callback-stable', 'callback-stable']);
  assert.equal(uniqueEffects.size, 1);
});

test('at-most-once network ambiguity and non-success response require manual review without an automatic retry time', async t => {
  let key: string | undefined;
  const url = await fixture(t, async (req, res) => {
    key = req.headers['idempotency-key'] as string | undefined;
    await read(req);
    res.writeHead(503);
    res.end('unavailable');
  });
  const result = await deliverCallback(delivery(url, { mode: 'at-most-once' }));
  assert.equal(result.state, 'uncertain');
  assert.equal(result.nextAttemptAt, undefined);
  assert.equal(key, undefined);
});

test('shutdown abort preserves ambiguity and invalid configuration performs no network attempt', async t => {
  const controller = new AbortController();
  let calls = 0;
  const url = await fixture(t, async req => {
    await read(req);
    calls++;
    controller.abort();
  });
  const result = await deliverCallback(delivery(url, { mode: 'at-most-once' }), controller.signal);
  assert.equal(result.state, 'uncertain');
  assert.equal(calls, 1);
  assert.deepEqual(await deliverCallback(delivery(url, { state: 'pending' })), {
    state: 'failed', error: 'Invalid callback delivery configuration',
  });
  assert.equal(calls, 1);
});
