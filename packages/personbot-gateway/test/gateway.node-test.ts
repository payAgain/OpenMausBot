import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { json, readBody } from '../../../server/harness/http.ts';
import { requiredScope, type RequestAuth } from '../../../server/request-auth.ts';
import { createPersonbotRoutes } from '../../../server/routes/personbot.ts';
import { PASS } from '../../../server/routes/table.ts';
import { prepareRuntime } from '../../personbot-runtime-plugin/src/launch.ts';
import { PersonbotGateway, type GatewayFrame } from '../src/index.ts';

interface Snapshot {
  generation: string;
  sessions: { sessionId: string; status: string }[];
  pending: { requestId: string; generation: string; kind: string; sessionId: string; rootSessionId: string }[];
  logs: { events: { type: string; seq: number; data: unknown }[] }[];
}

test('App gateway preserves native effects, idempotency, targeted Stop and restart history', { timeout: 90_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'personbot-gateway-'));
  const home = join(directory, 'home');
  const workspace = join(directory, 'workspace');
  const gateways: PersonbotGateway[] = [];
  const launch = () => {
    const gateway = new PersonbotGateway({
      enabled: true, home, workspace, provider: 'personbot-fixture', model: 'fixture',
      prepare: async () => {
        const options = await prepareRuntime({ home, workspace, provider: 'personbot-fixture', model: 'fixture', fixture: true });
        return {
          ...options,
          env: {
            PATH: process.env.PATH, HOME: home, USERPROFILE: home, TMPDIR: directory,
            DSH_HOME: options.env.DSH_HOME, DSH_PRIMARY_RUNTIME: '', DSH_TELEMETRY_DISABLED: '1',
          },
        };
      },
    });
    gateways.push(gateway);
    return gateway;
  };
  let gateway = launch();
  let auth: RequestAuth = { kind: 'loopback', scopes: ['admin', 'client'] };
  const frames: GatewayFrame[] = [];
  gateway.subscribe(frame => frames.push(frame));
  let live = true;
  const route = () => createPersonbotRoutes({ gateway, live: () => live, onRevoked: () => () => {} });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      const result = await route()({ req, res, url, path: url.pathname, method: req.method ?? 'GET', auth, json, readBody });
      if (result === PASS) json(res, 404, { error: 'unhandled' });
    } catch { json(res, 500, { error: 'fixture handler failed' }); }
  });
  t.after(async () => {
    await Promise.all(gateways.map(item => item.close()));
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const rpc = async <T = unknown>(method: string, params: object = {}): Promise<T> => {
    const response = await fetch(`${base}/api/personbot/rpc`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, params }),
    });
    const answer = await response.json() as T;
    assert.equal(response.status, 200, JSON.stringify(answer));
    return answer;
  };
  const snapshot = (sessionId: string) => rpc<Snapshot>('personbot.v1.snapshots.get', { sessionId });
  const until = async <T>(read: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> => {
    let last: T | undefined;
    for (let i = 0; i < 250; i++) {
      const value = await read();
      last = value;
      if (predicate(value)) return value;
      await delay(40);
    }
    throw new Error(`Gateway fixture condition timed out: ${JSON.stringify(last).slice(-4_000)}`);
  };
  const submit = (sessionId: string, text: string, commandId = randomUUID(), messageId = randomUUID()) =>
    rpc('personbot.v1.messages.submit', { commandId, messageId, sessionId, text, mode: 'followup' });
  assert.equal((await fetch(`${base}/api/personbot/status`).then(r => r.json()) as { state: string }).state, 'stopped');
  for (const path of ['/api/personbot/status', '/api/personbot/events', '/api/personbot/rpc']) {
    assert.equal(requiredScope(path.endsWith('rpc') ? 'POST' : 'GET', path), 'admin');
  }
  auth = { kind: 'loopback', trust: 'service', scopes: ['client'] };
  assert.equal((await fetch(`${base}/api/personbot/status`)).status, 403);
  auth = { kind: 'loopback', scopes: ['admin', 'client'] };
  const invalid = await fetch(`${base}/api/personbot/rpc`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'personbot.v1.shutdown', params: {} }),
  });
  assert.equal(invalid.status, 400);
  assert.equal(gateway.status().state, 'stopped');
  const internal = await fetch(`${base}/api/personbot/rpc`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      method: 'personbot.v1.sources.ingest',
      params: { sourceId: 'source', token: 'x'.repeat(40), eventId: 'event', threadId: 'thread', text: 'external context' },
    }),
  });
  assert.equal(internal.status, 400);
  assert.equal(gateway.status().state, 'stopped');

  await Promise.all(['alpha', 'beta'].map(sessionId => rpc('personbot.v1.sessions.create', { sessionId, conversationId: sessionId })));
  assert.equal(frames.filter(frame => frame.kind === 'gateway' && frame.state === 'ready').length, 1);
  const streamController = new AbortController();
  const stream = await fetch(`${base}/api/personbot/events`, { signal: streamController.signal });
  const reader = stream.body!.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /"state":"ready"/);
  streamController.abort();
  await reader.cancel().catch(() => {});

  const commandId = randomUUID(), messageId = randomUUID();
  await submit('alpha', 'echo gateway-roundtrip', commandId, messageId);
  await submit('alpha', 'echo gateway-roundtrip', commandId, messageId);
  let saved = await until(() => snapshot('alpha'), value => value.logs[0]!.events.some(event => event.type === 'assistant/message'));
  assert.equal(saved.logs[0]!.events.filter(event => event.type === 'user/message'
    && (event.data as { source?: { kind: string } }).source?.kind === 'user').length, 1);
  await submit('alpha', 'approve');
  saved = await until(() => snapshot('alpha'), value => value.pending.length === 1);
  await assert.rejects(access(join(workspace, 'approved.txt')), { code: 'ENOENT' });
  const decision = saved.pending[0]!;
  await rpc('personbot.v1.approvals.resolve', { requestId: decision.requestId, generation: decision.generation, outcome: 'allowed-once' });
  await until(() => readFile(join(workspace, 'approved.txt'), 'utf8').catch(() => ''), value => value === 'approved by personbot fixture\n');
  await until(() => snapshot('alpha'), value => value.pending.length === 0 && value.sessions[0]!.status !== 'running');

  await submit('alpha', 'question');
  saved = await until(() => snapshot('alpha'), value => value.pending.some(item => item.kind === 'question'));
  await rpc('personbot.v1.questions.answer', {
    requestId: saved.pending[0]!.requestId, generation: saved.generation, result: { answers: [{ id: 'format', selected: ['Markdown'] }] },
  });
  await until(() => snapshot('alpha'), value => value.pending.length === 0 && value.sessions[0]!.status !== 'running');
  await submit('alpha', 'child-question');
  saved = await until(() => snapshot('alpha'), value => JSON.stringify(value.logs).includes('human interaction is unavailable'));
  assert.equal(saved.pending.length, 0);
  await until(() => snapshot('alpha'), value => value.pending.length === 0 && value.sessions[0]!.status !== 'running');
  await submit('alpha', 'hold');
  await submit('beta', 'hold');
  await until(() => snapshot('alpha'), value => value.sessions[0]!.status === 'running');
  const stopId = randomUUID();
  const stopped = await rpc<{ confirmed: boolean }>('personbot.v1.sessions.stop', { sessionId: 'alpha', commandId: stopId });
  assert.equal(stopped.confirmed, true);
  assert.equal((await snapshot('beta')).sessions[0]!.status, 'running');
  await submit('alpha', 'hold');
  await rpc('personbot.v1.sessions.stop', { sessionId: 'alpha', commandId: stopId });
  assert.equal((await snapshot('alpha')).sessions[0]!.status, 'running');
  const previousGeneration = (await snapshot('alpha')).generation;
  await gateway.close();
  gateway = launch();
  await rpc('personbot.v1.sessions.resume', { sessionId: 'alpha' });
  saved = await snapshot('alpha');
  assert.notEqual(saved.generation, previousGeneration);
  assert.ok(JSON.stringify(saved.logs).includes('gateway-roundtrip'));
  const expired = await fetch(`${base}/api/personbot/rpc`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'personbot.v1.approvals.resolve', params: { requestId: decision.requestId, generation: decision.generation, outcome: 'allowed-once' } }),
  });
  assert.equal(expired.status, 409);
  live = false;
  assert.equal((await fetch(`${base}/api/personbot/status`)).status, 403);
});

test('disabled gateway and malformed requests never launch a runtime', async () => {
  let starts = 0;
  const gateway = new PersonbotGateway({
    enabled: false, home: '/tmp/personbot-disabled', workspace: '/tmp/personbot-disabled-workspace',
    provider: 'fixture', model: 'fixture',
    prepare: async () => { starts++; throw new Error('must not start'); },
  });
  await assert.rejects(gateway.start(), /disabled/);
  await assert.rejects(gateway.request('personbot.v1.messages.submit', {}), /commandId/);
  await assert.rejects(gateway.request('personbot.v1.sources.ingest', {
    sourceId: 'source', token: 'x'.repeat(40), eventId: 'event', threadId: 'thread', text: 'event',
  }), /Unsupported App runtime method/);
  await assert.rejects(gateway.ingest('source', 'x'.repeat(40), { eventId: 'event', threadId: 'thread', text: 'event' }), /disabled/);
  for (const payload of [null, [], { eventId: 'event', threadId: 'thread', text: 'event', taskId: 'injected' }, { eventId: 'event', text: 'event' }]) {
    await assert.rejects(gateway.ingest('source', 'x'.repeat(40), payload));
  }
  assert.equal(starts, 0);
  await gateway.close();
});

test('gateway ingestion uses only the internal source method and keeps owner management separate', { timeout: 8_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'personbot-source-gateway-'));
  const program = `
    require('node:readline').createInterface({input:process.stdin}).on('line', line => {
      const request = JSON.parse(line);
      if (request.method === 'personbot.v1.shutdown') process.exit(0);
      const {sourceId, eventId, threadId, text, token} = request.params;
      process.stdout.write(JSON.stringify({jsonrpc:'2.0', id:request.id, result:{
        method:request.method, sourceId, eventId, threadId, text, authorized:token === 'x'.repeat(40)
      }}) + '\\n');
    });
  `;
  let starts = 0;
  const gateway = new PersonbotGateway({
    enabled: true, home: join(directory, 'home'), workspace: join(directory, 'workspace'),
    provider: 'fixture', model: 'fixture',
    prepare: async () => {
      starts++;
      return { command: process.execPath, args: ['-e', program], env: { PATH: process.env.PATH, HOME: directory } };
    },
  });
  t.after(async () => { await gateway.close(); await rm(directory, { recursive: true, force: true }); });
  for (const [sourceId, token, payload] of [
    ['source', 'short', { eventId: 'event', threadId: 'thread', text: 'event' }],
    ['source', 'x'.repeat(40), { eventId: 'event', threadId: 'thread', text: 'event', sourceId: 'other' }],
    ['source', 'x'.repeat(40), { eventId: 'event', threadId: 'thread', text: 'x'.repeat(32_769) }],
  ] as const) await assert.rejects(gateway.ingest(sourceId, token, payload));
  assert.equal(starts, 0);
  const payload = { eventId: 'event', threadId: 'thread', text: 'external context' };
  const result = await gateway.ingest('source', 'x'.repeat(40), payload);
  assert.deepEqual(result, { method: 'personbot.v1.sources.ingest', sourceId: 'source', ...payload, authorized: true });
  assert.equal(starts, 1);
  await assert.rejects(gateway.request('personbot.v1.sources.ingest', { sourceId: 'source', token: 'x'.repeat(40), ...payload }), /Unsupported App runtime method/);
  const commands = [
    ['personbot.v1.integrations.snapshot', {}],
    ['personbot.v1.sources.put', {
      commandId: 'source-command', sourceId: 'source', name: 'Source', originSessionId: 'origin',
      enabled: false, goal: 'Read events', criteria: ['Evidence'], token: 'x'.repeat(40), callbackMode: 'idempotent',
    }],
    ['personbot.v1.subscriptions.put', { commandId: 'subscription-command', subscriptionId: 'subscription', sourceId: 'source', threadId: 'thread', taskId: 'task', enabled: true }],
    ['personbot.v1.schedules.put', {
      commandId: 'schedule-command', scheduleId: 'schedule', name: 'Schedule', sourceId: 'source', threadId: 'thread',
      text: 'scheduled context', runAt: '2026-11-06T00:00:00.000Z', enabled: true,
    }],
    ['personbot.v1.deliveries.control', { commandId: 'delivery-command', deliveryId: 'delivery', expectedState: 'uncertain', action: 'mark_delivered' }],
  ] as const;
  for (const [method, params] of commands) {
    assert.equal((await gateway.request(method, params) as { method: string }).method, method);
  }
  assert.equal(starts, 1);
});

test('shutdown closes a child whose initialization has not answered', { timeout: 8_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'personbot-starting-close-'));
  const marker = join(directory, 'ready');
  const program = `
    require('node:fs').writeFileSync(process.argv[1], 'ready');
    require('node:readline').createInterface({input:process.stdin}).on('line', line => {
      if (JSON.parse(line).method === 'personbot.v1.shutdown') process.exit(0);
    });
  `;
  const gateway = new PersonbotGateway({
    enabled: true, home: join(directory, 'home'), workspace: join(directory, 'workspace'),
    provider: 'fixture', model: 'fixture',
    prepare: async () => ({ command: process.execPath, args: ['-e', program, marker], env: { PATH: process.env.PATH, HOME: directory } }),
  });
  t.after(async () => { await gateway.close(); await rm(directory, { recursive: true, force: true }); });
  const started = gateway.start().then(() => 'ready', () => 'rejected');
  for (let attempt = 0; ; attempt++) {
    try { await access(marker); break; }
    catch { if (attempt > 100) throw new Error('Child did not start'); await delay(10); }
  }
  const before = Date.now();
  await gateway.close();
  assert.ok(Date.now() - before < 4_500);
  assert.equal(await started, 'rejected');
  assert.equal(gateway.status().state, 'closing');
  await assert.rejects(gateway.start(), /closing/);
});

test('saved launch settings take effect on a new runtime without changing the active route', { timeout: 8_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'personbot-gateway-settings-'));
  const program = `
    require('node:readline').createInterface({input:process.stdin}).on('line', line => {
      const request = JSON.parse(line);
      if (request.method === 'personbot.v1.shutdown') process.exit(0);
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{
        credential:process.env.DEEPSEEK_API_KEY
      }}) + '\\n');
    });
  `;
  const desired = { provider: 'deepseek-official', model: 'deepseek-flash', env: { DEEPSEEK_API_KEY: 'fixture-first-credential' } };
  let launched = 0;
  const gateways: PersonbotGateway[] = [];
  const create = () => {
    const gateway = new PersonbotGateway({
      enabled: true, home: join(directory, 'home'), workspace: join(directory, 'workspace'),
      provider: 'deepseek-official', model: 'deepseek-flash',
      resolveLaunch: () => desired,
      onLaunch: () => { launched++; },
      prepare: async () => ({ command: process.execPath, args: ['-e', program], env: { PATH: process.env.PATH, HOME: directory } }),
    });
    gateways.push(gateway);
    return gateway;
  };
  t.after(async () => {
    await Promise.all(gateways.map(gateway => gateway.close()));
    await rm(directory, { recursive: true, force: true });
  });
  const first = create();
  assert.equal(first.status().state, 'stopped');
  assert.equal(launched, 0);
  assert.deepEqual(await first.request('personbot.v1.sessions.list', {}), { credential: 'fixture-first-credential' });
  desired.model = 'deepseek-v4-pro';
  desired.env = { DEEPSEEK_API_KEY: 'fixture-rotated-credential' };
  assert.equal(first.status().model, 'deepseek-flash');
  assert.deepEqual(await first.request('personbot.v1.sessions.list', {}), { credential: 'fixture-first-credential' });
  assert.equal(launched, 1);
  assert.ok(!JSON.stringify(first.status()).includes('credential'));
  await first.close();
  const second = create();
  assert.equal(second.status().model, 'deepseek-v4-pro');
  assert.deepEqual(await second.request('personbot.v1.sessions.list', {}), { credential: 'fixture-rotated-credential' });
  assert.equal(launched, 2);
});

test('launch failures redact configured credentials from public gateway status and events', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'personbot-redacted-launch-'));
  const secret = ['fixture', 'private', 'launch', 'credential'].join('-');
  const frames: GatewayFrame[] = [];
  const gateway = new PersonbotGateway({
    enabled: true, home: join(directory, 'home'), workspace: join(directory, 'workspace'),
    provider: 'deepseek-official', model: 'deepseek-flash',
    resolveLaunch: () => ({ provider: 'deepseek-official', model: 'deepseek-flash', env: { DEEPSEEK_API_KEY: secret } }),
    prepare: async () => { throw new Error(`Fixture refused ${secret}`); },
  });
  t.after(async () => { await gateway.close(); await rm(directory, { recursive: true, force: true }); });
  gateway.subscribe(frame => frames.push(frame));
  await assert.rejects(gateway.start(), { message: 'Fixture refused [redacted]' });
  assert.equal(gateway.status().state, 'failed');
  assert.equal(gateway.status().error, 'Fixture refused [redacted]');
  assert.ok(!JSON.stringify(frames).includes(secret));
  await gateway.close();
});
