import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import type { SuperagentBinding, SuperagentDelivery, SuperagentEvent, SuperagentInput, SuperagentMemoryRequest } from '../../../shared/superagent.ts';
import { createSuperagentGateway } from '../src/index.ts';
import { Peer } from '../src/rpc.ts';

async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>, label: string): Promise<T> {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const result = await read();
    if (result !== undefined) return result;
    await delay(25);
  }
  throw new Error(`Timed out: ${label}`);
}

function key(binding: SuperagentBinding): string {
  return createHash('sha256').update(JSON.stringify([binding.botId, binding.threadId, binding.contextId ?? 'default'])).digest('hex');
}

test('private RPC preserves split UTF-8 frames', async () => {
  const input = new PassThrough();
  const peer = new Peer(input, new PassThrough());
  let text: unknown;
  peer.notification = (_method, value) => { text = value; };
  const frame = Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', method: 'text', params: '中文🙂' })}\n`);
  for (const byte of frame) input.write(Buffer.from([byte]));
  assert.equal(await waitFor(() => text, 'UTF-8 frame'), '中文🙂');
  peer.close();
});

test('official Runtime executes native tasks, memory, decisions, recovery and isolated branches', { timeout: 180_000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'omb-official-test-'));
  const workspace = join(home, 'workspace');
  await mkdir(workspace);
  const envNames = ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME', 'DSH_HOME'] as const;
  const prior = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
  for (const name of envNames) { process.env[name] = join(home, name); await mkdir(process.env[name]!, { recursive: true }); }
  let envRevision = 'one';
  let resolveBarrier: (() => Promise<void>) | undefined;
  const memory: SuperagentMemoryRequest[] = [];
  const events: SuperagentEvent[] = [];
  const delivered = new Map<string, SuperagentDelivery>();
  let blockDelivery = false;
  let deliveryAttempts = 0;
  let diagnostics = '';
  let launches = 0;
  const launchConfigurations: Array<{ binding?: SuperagentBinding; pid?: number; envRevision?: string }> = [];
  const options = {
    home, workspace, provider: 'personbot-fixture', model: 'fixture', fixture: true, maxChildren: 2,
    memory: async (request: SuperagentMemoryRequest) => { memory.push(request); return { memories: [{ text: 'jasmine tea', source: 'original OMB memory' }] }; },
    deliver: async (delivery: SuperagentDelivery) => {
      if (delivery.text === 'pending durable reply') {
        deliveryAttempts++;
        if (blockDelivery) throw new Error('Fixture product persistence is temporarily unavailable');
      }
      delivered.set(delivery.messageId, delivery);
    },
    resolveLaunch: async () => { await resolveBarrier?.(); return { env: { PERSONBOT_TEST_CONFIGURATION: envRevision } }; },
    onLaunch: (configuration: { binding?: SuperagentBinding; pid?: number; env: NodeJS.ProcessEnv }) => {
      launches++;
      launchConfigurations.push({ binding: configuration.binding, pid: configuration.pid, envRevision: configuration.env.PERSONBOT_TEST_CONFIGURATION });
    },
    onDiagnostic: (text: string) => { diagnostics = (diagnostics + text).slice(-20_000); },
  };
  let gateway = createSuperagentGateway(options);
  gateway.subscribe(event => events.push(event));
  const binding = { botId: 'private-bot', threadId: 'original-thread', contextId: 'first-context' };
  const input = (requestId: string, text: string, extra: Partial<SuperagentInput> = {}): SuperagentInput => ({ ...binding, requestId, sourceMessageId: `original-${requestId}`, text, ...extra });
  const completed = async (requestId: string) => waitFor(() => events.find(event => event.type === 'completed' && event.requestId === requestId), `${requestId} completed; ${diagnostics}`);
  const reply = (requestId: string) => events.find(event => event.type === 'reply' && event.requestId === requestId && ['answer', 'result', 'reply'].includes(event.purpose));
  const pidAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    await t.test('lazy start and authoritative Chinese source reply', async () => {
      await gateway.start();
      assert.equal(gateway.status().pid, undefined);
      await gateway.submit(input('echo', 'echo 你好官方', { instructions: 'Stable persona: personal test companion', approvalMode: 'ask' }));
      await completed('echo');
      const event = reply('echo');
      assert.equal(event?.type === 'reply' ? event.text : '', '你好官方');
      assert.equal(event?.type === 'reply' ? event.persisted : false, true);
      assert.equal(event?.type === 'reply' ? event.sourceMessageId : '', 'original-echo');
      assert.equal(launches, 1);
    });
    let workerId = '';
    await t.test('real Engine ticket, native write, report and official Outbox result', async () => {
      await gateway.submit(input('write', 'task write official-proof.txt', { approvalMode: 'ask' }));
      await completed('write');
      assert.match(await readFile(join(workspace, 'official-proof.txt'), 'utf8'), /native DSH file tool/);
      const task = events.find(event => event.type === 'task' && event.requestId === 'write' && event.state === 'completed');
      assert.equal(task?.type, 'task');
      workerId = task?.type === 'task' ? task.sessionId! : '';
      const db = new DatabaseSync(join(home, 'official-superagent', key(binding), 'state', 'orchestrator.sqlite'), { readOnly: true });
      assert.equal(db.prepare('SELECT count(*) AS n FROM ticket').get()?.n, 1);
      assert.ok(Number(db.prepare('SELECT count(*) AS n FROM outbox').get()?.n) >= 3);
      db.close();
    });
    await t.test('native worker and router permissions retain Ask instead of upstream full access', async () => {
      const file = join(home, 'official-superagent', key(binding), 'dsh', 'storages', 'session_projcache', 'sessions', `${workerId}.json`);
      const saved = await waitFor(async () => {
        const value = JSON.parse(await readFile(file, 'utf8')) as { record: { rows: { permissions: { val: { preset: string; approval: string } } } } };
        return value.record.rows.permissions.val.preset === 'workspace-write' ? value : undefined;
      }, 'native Ask permission projection');
      assert.equal(saved.record.rows.permissions.val.preset, 'workspace-write');
      assert.equal(saved.record.rows.permissions.val.approval, 'ask');
    });
    await t.test('worker memory bridge uses trusted original bot/thread/context', async () => {
      await gateway.submit(input('memory', 'task memory jasmine tea'));
      await completed('memory');
      assert.ok(memory.some(request => request.operation === 'search' && request.query === 'jasmine tea'));
      for (const request of memory) {
        assert.equal(request.botId, binding.botId);
        assert.equal(request.threadId, binding.threadId);
        assert.equal(request.contextId, binding.contextId);
      }
      const result = reply('memory');
      assert.match(result?.type === 'reply' ? result.text : '', /jasmine tea/);
    });
    await t.test('graceful restart continues actual official worker Session and source persona', async () => {
      const pid = gateway.status().pid!;
      await gateway.close();
      assert.equal(pidAlive(pid), false);
      gateway = createSuperagentGateway(options);
      gateway.subscribe(event => events.push(event));
      await gateway.start();
      assert.equal(gateway.status().pid, undefined);
      await gateway.submit(input('history', 'task history official-proof'));
      await completed('history');
      assert.ok(events.some(event => event.type === 'task' && event.requestId === 'history' && event.sessionId === workerId));
      const bindingDb = new DatabaseSync(join(home, 'official-superagent', 'bindings.sqlite'), { readOnly: true });
      const saved = JSON.parse(String(bindingDb.prepare('SELECT input FROM bindings WHERE id=?').get(key(binding))?.input)) as SuperagentInput;
      assert.match(saved.instructions!, /Stable persona/);
      bindingDb.close();
    });
    await t.test('native approval deny/allow and user question return through private RPC', async () => {
      await gateway.submit(input('deny', 'task approval'));
      const denied = await waitFor(() => events.find(event => event.type === 'approval' && event.requestId === 'deny'), 'native denied approval');
      assert.equal(denied.type, 'approval');
      assert.equal(await gateway.respond({ ...binding, contextId: 'wrong-context' }, denied.type === 'approval' ? denied.decisionId : '', { behavior: 'allow' }), false);
      assert.equal(await gateway.respond(binding, denied.type === 'approval' ? denied.decisionId : '', { behavior: 'deny' }), true);
      await completed('deny');
      await assert.rejects(readFile(join(workspace, 'official-approved.txt')), /ENOENT/);
      await gateway.submit(input('allow', 'task approval'));
      const allowed = await waitFor(() => events.find(event => event.type === 'approval' && event.requestId === 'allow'), 'native allowed approval');
      await gateway.respond(binding, allowed.type === 'approval' ? allowed.decisionId : '', { behavior: 'allow' });
      await completed('allow');
      assert.equal(await readFile(join(workspace, 'official-approved.txt'), 'utf8'), 'approved\n');
      await gateway.submit(input('question', 'task question'));
      const question = await waitFor(() => events.find(event => event.type === 'question' && event.requestId === 'question'), 'native question');
      await gateway.respond(binding, question.type === 'question' ? question.decisionId : '', { behavior: 'answer', message: 'Markdown' });
      await completed('question');
    });
    await t.test('tool-free native upkeep and active settings switch rejection', async () => {
      assert.equal(await gateway.generateText('upkeep prompt'), 'fixture auxiliary: upkeep prompt');
      await gateway.submit(input('hold', 'task hold'));
      await waitFor(() => events.find(event => event.type === 'task' && event.requestId === 'hold' && event.state === 'working'), 'held native worker');
      envRevision = 'two';
      await assert.rejects(gateway.submit(input('changed', 'echo changed configuration')), /configuration/);
      envRevision = 'one';
      await gateway.interrupt(binding);
      await gateway.submit(input('after-continued-stop', 'echo after continued task Stop'));
      await completed('after-continued-stop');
      await gateway.submit(input('after-continued-stop-again', 'echo still stopped'));
      await completed('after-continued-stop-again');
      const db = new DatabaseSync(join(home, 'official-superagent', key(binding), 'state', 'orchestrator.sqlite'), { readOnly: true });
      try {
        const tickets = db.prepare('SELECT value FROM ticket').all().map(row => JSON.parse(String(row.value)) as { ended?: { by: string; outcome: string } });
        assert.equal(tickets.length, 1, 'stale continued task candidates must not create new tickets after Stop');
        assert.ok(tickets.every(ticket => ticket.ended?.by === 'human' && ticket.ended.outcome === 'stopped'));
      } finally { db.close(); }
    });
    await t.test('new branch retires old process, rejects old decisions and starts independent native state', async () => {
      const oldPid = gateway.status().pid!;
      const offset = events.length;
      await gateway.submit(input('branch', 'echo branch-isolated', { contextId: 'fresh-context', approvalMode: 'full' }));
      await completed('branch');
      assert.equal(pidAlive(oldPid), false);
      assert.ok(events.slice(offset).filter(event => event.requestId === 'branch').every(event => event.contextId === 'fresh-context'));
      assert.equal(await gateway.respond(binding, 'retired-decision', { behavior: 'allow' }), false);
      const active = { ...binding, contextId: 'fresh-context' };
      const db = new DatabaseSync(join(home, 'official-superagent', key(active), 'state', 'orchestrator.sqlite'), { readOnly: true });
      assert.equal(db.prepare('SELECT count(*) AS n FROM ticket').get()?.n, 0);
      db.close();
      const files = await readdir(join(home, 'official-superagent', key(active), 'dsh', 'storages', 'session_projcache', 'sessions'));
      const saved = await waitFor(async () => {
        const value = JSON.parse(await readFile(join(home, 'official-superagent', key(active), 'dsh', 'storages', 'session_projcache', 'sessions', files[0]!), 'utf8')) as { record: { rows: { permissions: { val: { sandbox: string; approval: string } } } } };
        return value.record.rows.permissions.val.sandbox === 'danger-full-access' ? value : undefined;
      }, 'native full permission projection');
      assert.equal(saved.record.rows.permissions.val.sandbox, 'danger-full-access');
      assert.equal(saved.record.rows.permissions.val.approval, 'never');
      await gateway.submit(input('full-write', 'task write official-full-proof.txt', active));
      await completed('full-write');
      const task = events.find(event => event.type === 'task' && event.requestId === 'full-write' && event.state === 'completed');
      assert.equal(task?.type, 'task');
      const worker = task?.type === 'task' ? task.sessionId! : '';
      const fullWorker = await waitFor(async () => {
        const value = JSON.parse(await readFile(join(home, 'official-superagent', key(active), 'dsh', 'storages', 'session_projcache', 'sessions', `${worker}.json`), 'utf8')) as { record: { rows: { permissions: { val: { sandbox: string; approval: string } } } } };
        return value.record.rows.permissions.val.sandbox === 'danger-full-access' ? value : undefined;
      }, 'native Full worker permission projection');
      assert.equal(fullWorker.record.rows.permissions.val.sandbox, 'danger-full-access');
      assert.equal(fullWorker.record.rows.permissions.val.approval, 'never');
    });
    await t.test('official attention survives clarification and delivers final result with its actual source request', async () => {
      const attentionBinding = { ...binding, threadId: 'attention-thread' };
      await gateway.submit(input('attention', 'task attention', attentionBinding));
      await completed('attention');
      assert.ok([...delivered.values()].some(value => value.requestId === 'attention' && value.purpose === 'attention' && value.text === 'Which destination?'));
      await gateway.submit(input('clarification', 'attention answer Mars', attentionBinding));
      await completed('clarification');
      assert.ok([...delivered.values()].some(value => value.requestId === 'clarification' && value.sourceMessageId === 'original-clarification' && value.purpose === 'result' && value.text === 'Official attention result: Mars'));
    });
    await t.test('pending official Outbox waits for product persistence and retries durably after restart', async () => {
      const pendingBinding = { ...binding, threadId: 'pending-delivery-thread' };
      blockDelivery = true;
      await gateway.submit(input('pending', 'echo pending durable reply', pendingBinding));
      await waitFor(() => deliveryAttempts > 0 ? true : undefined, 'failed durable delivery attempt');
      assert.equal([...delivered.values()].some(value => value.requestId === 'pending'), false);
      await gateway.close();
      blockDelivery = false;
      gateway = createSuperagentGateway(options);
      gateway.subscribe(event => events.push(event));
      await gateway.submit(input('after-pending', 'echo after restart', pendingBinding));
      await completed('after-pending');
      await waitFor(() => [...delivered.values()].find(value => value.requestId === 'pending'), 'recovered pending Outbox');
      const pending = [...delivered.values()].filter(value => value.requestId === 'pending');
      assert.equal(pending.length, 1);
      assert.equal(pending[0]?.sourceMessageId, 'original-pending');
      assert.ok(deliveryAttempts >= 2);
    });
    await t.test('unexpected process death fails accepted request once and a new request recovers the same binding', async () => {
      const crashBinding = { ...binding, threadId: 'crash-thread' };
      await gateway.submit(input('crash-approval', 'task approval', crashBinding));
      await waitFor(() => events.find(event => event.type === 'approval' && event.requestId === 'crash-approval'), 'approval before crash');
      const pid = gateway.status().pid!;
      process.kill(pid, 'SIGKILL');
      await waitFor(() => events.find(event => event.type === 'failed' && event.requestId === 'crash-approval'), 'correlated process failure');
      assert.equal(events.filter(event => event.type === 'failed' && event.requestId === 'crash-approval').length, 1);
      await gateway.interrupt(crashBinding, { scope: 'request', requestId: 'crash-approval' });
      await gateway.submit(input('after-crash', 'echo recovered binding', crashBinding));
      await completed('after-crash');
      assert.equal(gateway.status().state, 'ready');
      const quarantines = (await gateway.inspect!()).resources.quarantinedWorkspaces ?? [];
      assert.equal(quarantines.length, 1);
      for (const quarantine of quarantines) assert.equal(await gateway.releaseWorkspace!(quarantine.id), true);
    });
    await t.test('stop during asynchronous launch prevents native input admission', async () => {
      const stoppedBinding = { ...binding, threadId: 'launch-stop-thread' };
      let entered = false;
      let release!: () => void;
      const barrier = new Promise<void>(resolve => { release = resolve; });
      resolveBarrier = async () => { entered = true; await barrier; };
      const submitting = gateway.submit(input('stop-before-start', 'echo must not execute', stoppedBinding));
      await waitFor(() => entered ? true : undefined, 'launch settings resolver');
      await gateway.interrupt(stoppedBinding);
      resolveBarrier = undefined;
      release();
      await assert.rejects(submitting, /stopped before admission/);
      assert.equal(events.some(event => event.type === 'started' && event.requestId === 'stop-before-start'), false);
    });
    await t.test('process bound rejects saturation and an idle configuration change restarts safely', async () => {
      const first = { ...binding, threadId: 'bounded-one' };
      const second = { ...binding, threadId: 'bounded-two' };
      await gateway.submit(input('bound-one', 'task hold', first));
      await waitFor(() => events.find(event => event.type === 'task' && event.requestId === 'bound-one' && event.state === 'working'), 'bounded worker one');
      const firstPid = gateway.status().pid!;
      await gateway.submit(input('bound-two', 'task hold', second));
      await waitFor(() => events.find(event => event.type === 'task' && event.requestId === 'bound-two' && event.state === 'working'), 'bounded worker two');
      const secondPid = gateway.status().pid!;
      assert.notEqual(firstPid, secondPid);
      assert.equal(pidAlive(firstPid), true);
      assert.equal(pidAlive(secondPid), true);
      const before = launchConfigurations.filter(value => value.binding?.threadId === 'bounded-three').length;
      await assert.rejects(gateway.submit(input('bound-three', 'echo cannot exceed process bound', { threadId: 'bounded-three' })), /All 2.*busy/);
      assert.equal(launchConfigurations.filter(value => value.binding?.threadId === 'bounded-three').length, before);
      await gateway.interrupt(first);
      await gateway.interrupt(second);
      envRevision = 'three';
      await gateway.submit(input('idle-settings', 'echo new configuration', first));
      await completed('idle-settings');
      assert.equal(pidAlive(firstPid), false);
      assert.ok(launchConfigurations.some(value => value.binding?.threadId === first.threadId
        && value.binding.contextId === first.contextId && value.envRevision === 'three'
        && value.pid === gateway.status().pid && value.pid !== firstPid));
    });
  } finally {
    await gateway.close();
    for (const name of envNames) { if (prior[name] === undefined) delete process.env[name]; else process.env[name] = prior[name]; }
    await rm(home, { recursive: true, force: true });
  }
});
