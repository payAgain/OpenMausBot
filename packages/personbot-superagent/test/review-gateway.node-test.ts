import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rename, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import type { SuperagentEvent, SuperagentInput } from '../../../shared/superagent.ts';
import { createSuperagentGateway } from '../src/index.ts';

async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>, label: string): Promise<T> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await delay(30);
  }
  throw new Error(`Timed out: ${label}`);
}

async function isolated<T>(run: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), 'omb-reviewed-native-'));
  const names = ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME', 'DSH_HOME'] as const;
  const prior = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    for (const name of names) { process.env[name] = join(home, name); await mkdir(process.env[name]!, { recursive: true }); }
    return await run(home);
  } finally {
    for (const name of names) { if (prior[name] === undefined) delete process.env[name]; else process.env[name] = prior[name]; }
    await rm(home, { recursive: true, force: true });
  }
}

test('native cwd is immutable, workspace forks retain old tasks and task Stop is independent', { timeout: 90_000 }, () => isolated(async home => {
  const first = join(home, 'workspace-one');
  const second = join(home, 'workspace-two');
  await mkdir(first);
  await mkdir(second);
  await symlink(second, join(home, 'workspace-alias'));
  const events: SuperagentEvent[] = [];
  let diagnostics = '';
  const gateway = createSuperagentGateway({
    home, workspace: first, provider: 'fixture', model: 'fixture', fixture: true,
    memory: async () => ({}), onDiagnostic: text => { diagnostics = (diagnostics + text).slice(-15_000); },
  });
  gateway.subscribe(event => events.push(event));
  const original = { botId: 'bot', threadId: 'chat', contextId: 'first' };
  const input = (requestId: string, text: string, extra: Partial<SuperagentInput> = {}): SuperagentInput => ({ ...original, requestId, sourceMessageId: `source-${requestId}`, text, cwd: first, ...extra });
  try {
    await gateway.submit(input('old-prior-task', 'task write initial-directory-proof.txt'));
    await waitFor(() => events.find(event => event.type === 'completed' && event.requestId === 'old-prior-task'), 'preceding original task');
    await gateway.submit(input('old-task', 'task hold'));
    const task = await waitFor(() => events.find(event => event.type === 'task' && event.requestId === 'old-task' && event.state === 'working'), `old native task ${diagnostics}`);
    assert.equal(task.type, 'task');
    await assert.rejects(gateway.submit(input('wrong-cwd', 'echo wrong directory', { cwd: second })), /fixed working directory/);
    await gateway.submit(input('new-task', 'task write new-directory-proof.txt', {
      contextId: 'second', cwd: second, contextTransition: 'workspace', previousContextId: 'first',
    }));
    await waitFor(() => events.find(event => event.type === 'completed' && event.requestId === 'new-task'), `new directory completion ${diagnostics}`);
    assert.match(await readFile(join(second, 'new-directory-proof.txt'), 'utf8'), /native DSH file tool/);
    await assert.rejects(readFile(join(first, 'new-directory-proof.txt')), /ENOENT/);
    assert.equal(gateway.isActiveBinding!(original), true);
    const snapshot = await gateway.inspect!();
    assert.equal(snapshot.bindings.filter(binding => binding.active).length, 2);
    assert.equal(snapshot.tasks.find(value => value.ticketId === (task.type === 'task' ? task.ticketId : ''))?.ended, false);
    await gateway.submit(input('ordinary-continuation', 'echo continue in new directory', { contextId: 'second', cwd: second }));
    await waitFor(() => events.find(event => event.type === 'completed' && event.requestId === 'ordinary-continuation'), 'ordinary workspace continuation');
    assert.equal(gateway.isActiveBinding!(original), true);
    assert.equal((await gateway.inspect!()).tasks.find(value => value.ticketId === (task.type === 'task' ? task.ticketId : ''))?.ended, false);
    await gateway.interrupt(original, { scope: 'task', ticketId: task.type === 'task' ? task.ticketId : '' });
    const stopped = await gateway.inspect!();
    assert.equal(stopped.tasks.find(value => value.ticketId === (task.type === 'task' ? task.ticketId : ''))?.state, 'stopped');
    await gateway.submit(input('after-task-stop', 'echo old task remains stopped'));
    await waitFor(() => events.find(event => event.type === 'completed' && event.requestId === 'after-task-stop'), 'same-context conversation after task Stop');
    await gateway.submit(input('after-task-stop-again', 'echo old task still remains stopped'));
    await waitFor(() => events.find(event => event.type === 'completed' && event.requestId === 'after-task-stop-again'), 'second same-context conversation after task Stop');
    const oldTasks = (await gateway.inspect!()).tasks.filter(value => value.contextId === original.contextId);
    assert.equal(oldTasks.length, 1);
    assert.ok(oldTasks.every(value => value.ended && value.state === 'stopped'));
    await gateway.submit(input('alias', 'echo canonical alias', { contextId: 'second', cwd: join(home, 'workspace-alias') }));
    await waitFor(() => events.find(event => event.type === 'completed' && event.requestId === 'alias'), 'canonical alias continuation');
    assert.equal((await gateway.inspect!()).bindings.find(binding => binding.contextId === 'second')?.workspace, snapshot.bindings.find(binding => binding.contextId === 'second')?.workspace);
    await gateway.submit(input('branch', 'echo rewound branch', { contextId: 'third', cwd: second, contextTransition: 'branch' }));
    await waitFor(() => events.find(event => event.type === 'completed' && event.requestId === 'branch'), 'branch continuation');
    assert.equal(gateway.isActiveBinding!(original), false);
    assert.equal(gateway.isActiveBinding!({ ...original, contextId: 'second' }), false);
  } finally { await gateway.close(); }
}));

test('pending official delivery wakes and completes after restart with no new chat input', { timeout: 60_000 }, () => isolated(async home => {
  const workspace = join(home, 'workspace');
  await mkdir(workspace);
  let blocked = true;
  let attempts = 0;
  const delivered: string[] = [];
  let diagnostics = '';
  const options = {
    home, workspace, provider: 'fixture', model: 'fixture', fixture: true,
    memory: async () => ({}),
    deliver: async (delivery: { requestId: string }) => {
      attempts++;
      if (blocked) throw new Error('Disposable product persistence unavailable');
      delivered.push(delivery.requestId);
    },
    onDiagnostic: (text: string) => { diagnostics = (diagnostics + text).slice(-15_000); },
  };
  let gateway = createSuperagentGateway(options);
  try {
    await gateway.submit({ botId: 'bot', threadId: 'chat', contextId: 'context', requestId: 'pending', sourceMessageId: 'owner-message', text: 'echo durable background delivery' });
    await waitFor(() => attempts > 0 ? true : undefined, 'first durable delivery attempt');
    await gateway.close();
    blocked = false;
    gateway = createSuperagentGateway(options);
    await gateway.start();
    await waitFor(() => delivered.includes('pending') ? true : undefined, `automatic outbox wake ${diagnostics}`);
    assert.deepEqual(delivered, ['pending']);
    assert.equal((await gateway.inspect!()).bindings.length, 1);
  } finally { await gateway.close(); }
}));

test('an input-completed persistent task prevents eviction and wakes without new input after restart', { timeout: 60_000 }, () => isolated(async home => {
  const workspace = join(home, 'workspace');
  await mkdir(workspace);
  const events: SuperagentEvent[] = [];
  const options = { home, workspace, provider: 'fixture', model: 'fixture', fixture: true, maxChildren: 1, memory: async () => ({}) };
  const binding = { botId: 'bot', threadId: 'attention-chat', contextId: 'context' };
  let gateway = createSuperagentGateway(options);
  gateway.subscribe(event => events.push(event));
  try {
    await gateway.submit({ ...binding, requestId: 'attention', sourceMessageId: 'attention-source', text: 'task attention' });
    await waitFor(() => events.find(event => event.type === 'completed' && event.requestId === 'attention'), 'attention releases its input');
    const before = await gateway.inspect!();
    const ticket = before.tasks.find(task => !task.ended);
    assert.ok(ticket);
    await assert.rejects(gateway.submit({ botId: 'bot', threadId: 'other-chat', contextId: 'other', requestId: 'rejected-capacity', sourceMessageId: 'rejected-source', text: 'echo must not run later' }), /All 1.*busy/);
    const oldPid = gateway.status().pid;
    await gateway.close();
    gateway = createSuperagentGateway(options);
    gateway.subscribe(event => events.push(event));
    await gateway.start();
    await waitFor(() => {
      const pid = gateway.status().pid;
      return pid && pid !== oldPid && gateway.status().state === 'ready' ? pid : undefined;
    }, 'automatic pending-task lifecycle wake');
    const after = await gateway.inspect!();
    assert.equal(after.tasks.find(task => task.ticketId === ticket.ticketId)?.ended, false);
    assert.equal(events.some(event => event.type === 'started' && event.requestId === 'rejected-capacity'), false);
    await gateway.interrupt(binding, { scope: 'task', ticketId: ticket.ticketId });
    assert.equal((await gateway.inspect!()).tasks.find(task => task.ticketId === ticket.ticketId)?.state, 'stopped');
  } finally { await gateway.close(); }
}));

test('a real native crash blocks overlapping writes across restart but keeps model replies and owner reconciliation available', { timeout: 90_000 }, () => isolated(async home => {
  const workspace = join(home, 'workspace');
  await mkdir(workspace);
  const events: SuperagentEvent[] = [];
  let diagnostics = '';
  const options = {
    home, workspace, provider: 'fixture', model: 'fixture', fixture: true, memory: async () => ({}),
    onDiagnostic: (text: string) => { diagnostics = (diagnostics + text).slice(-15_000); },
  };
  const binding = { botId: 'bot', threadId: 'crash-chat', contextId: 'context' };
  let gateway = createSuperagentGateway(options);
  gateway.subscribe(event => events.push(event));
  try {
    await gateway.submit({ ...binding, requestId: 'crash-write-window', sourceMessageId: 'owner-crash', text: 'task approval' });
    const originalDecision = await waitFor(() => events.find(event => event.type === 'approval' && event.requestId === 'crash-write-window'), 'acquired native write window');
    const pid = gateway.status().pid!;
    process.kill(pid, 'SIGKILL');
    const quarantined = await waitFor(async () => (await gateway.inspect!()).resources.quarantinedWorkspaces?.[0], 'native crash quarantine');
    assert.equal(await gateway.respond(binding, originalDecision.type === 'approval' ? originalDecision.decisionId : '', { behavior: 'allow' }), false);
    await gateway.interrupt(binding, { scope: 'request', requestId: 'crash-write-window' });
    await gateway.submit({ botId: 'bot', threadId: 'reader-chat', contextId: 'reader', requestId: 'reader', sourceMessageId: 'owner-reader', text: 'echo read-only model reply' });
    await waitFor(() => events.find(event => event.type === 'reply' && event.requestId === 'reader' && event.text === 'read-only model reply'), `model unaffected by quarantine ${diagnostics}`);
    const blocked = { botId: 'bot', threadId: 'blocked-chat', contextId: 'blocked' };
    await gateway.submit({ ...blocked, requestId: 'blocked-writer', sourceMessageId: 'owner-blocked', text: 'task write forbidden-during-quarantine.txt' });
    await waitFor(() => events.find(event => event.type === 'failed' && event.requestId === 'blocked-writer'), `native writer blocked ${diagnostics}`);
    await assert.rejects(readFile(join(workspace, 'forbidden-during-quarantine.txt')), /ENOENT/);
    await gateway.interrupt(blocked);
    await gateway.close();
    gateway = createSuperagentGateway(options);
    gateway.subscribe(event => events.push(event));
    await gateway.start();
    assert.equal((await gateway.inspect!()).resources.quarantinedWorkspaces?.[0]?.id, quarantined.id);
    assert.equal(await gateway.releaseWorkspace!(quarantined.id), true);
    await gateway.submit({ ...binding, requestId: 'reconciled-writer', sourceMessageId: 'owner-reconciled', text: 'task write after-owner-reconciliation.txt' });
    await waitFor(() => events.find(event => event.type === 'completed' && event.requestId === 'reconciled-writer'), `reconciled native writer ${diagnostics}`);
    assert.match(await readFile(join(workspace, 'after-owner-reconciliation.txt'), 'utf8'), /native DSH file tool/);
  } finally { await gateway.close(); }
}));

test('automatic recovery never follows a redirected fixed workspace into a different directory', { timeout: 30_000 }, () => isolated(async home => {
  const workspace = join(home, 'workspace');
  const moved = join(home, 'original-workspace');
  const redirected = join(home, 'different-workspace');
  await mkdir(workspace);
  await mkdir(redirected);
  const events: SuperagentEvent[] = [];
  let diagnostics = '';
  const options = {
    home, workspace, provider: 'fixture', model: 'fixture', fixture: true, memory: async () => ({}),
    onDiagnostic: (text: string) => { diagnostics = (diagnostics + text).slice(-15_000); },
  };
  let gateway = createSuperagentGateway(options);
  gateway.subscribe(event => events.push(event));
  try {
    await gateway.submit({ botId: 'bot', threadId: 'chat', contextId: 'fixed', requestId: 'pending', sourceMessageId: 'owner', text: 'task attention' });
    await waitFor(() => events.find(event => event.type === 'completed' && event.requestId === 'pending'), 'pending original task');
    const canonical = await realpath(workspace);
    await gateway.close();
    await rename(workspace, moved);
    await symlink(redirected, workspace);
    gateway = createSuperagentGateway(options);
    await gateway.start();
    await waitFor(() => diagnostics.includes('working directory was redirected') ? true : undefined, 'fixed-directory recovery refusal');
    assert.equal(gateway.status().pid, undefined);
    assert.equal((await gateway.inspect!()).bindings[0]?.workspace, canonical);
    await assert.rejects(gateway.submit({ botId: 'bot', threadId: 'chat', contextId: 'fixed', requestId: 'wrong-directory', sourceMessageId: 'wrong-source', text: 'task write wrong-location.txt', cwd: workspace }), /fixed working directory/);
    await assert.rejects(readFile(join(redirected, 'wrong-location.txt')), /ENOENT/);
  } finally { await gateway.close(); }
}));

test('context revocation immediately fences background approvals, all directory contexts and concurrent intake across restart', { timeout: 60_000 }, () => isolated(async home => {
  const first = join(home, 'workspace-one');
  const second = join(home, 'workspace-two');
  await mkdir(first);
  await mkdir(second);
  const binding = { botId: 'bot', threadId: 'chat' };
  const events: SuperagentEvent[] = [];
  let launches = 0;
  const options = {
    home, workspace: first, provider: 'fixture', model: 'fixture', fixture: true,
    memory: async () => ({}), onLaunch: () => { launches++; },
  };
  let gateway = createSuperagentGateway(options);
  gateway.subscribe(event => events.push(event));
  try {
    await gateway.submit({ ...binding, contextId: 'old', requestId: 'background', sourceMessageId: 'owner-background', text: 'task background approval' });
    await waitFor(() => events.find(event => event.type === 'completed' && event.requestId === 'background'), 'background input completion');
    const approval = await waitFor(() => events.find(event => event.type === 'approval' && event.requestId === 'background'), 'independent background approval');
    assert.equal(approval.type, 'approval');
    await gateway.submit({
      ...binding, contextId: 'new-directory', previousContextId: 'old', contextTransition: 'workspace', cwd: second,
      requestId: 'directory', sourceMessageId: 'owner-directory', text: 'echo second directory',
    });
    await waitFor(() => events.find(event => event.type === 'completed' && event.requestId === 'directory'), 'second directory reply');
    const submission = assert.rejects(gateway.submit({
      ...binding, contextId: 'new-directory', cwd: second, requestId: 'racing', sourceMessageId: 'owner-racing', text: 'task write must-never-execute.txt',
    }), /stopped before admission|retired native context/);
    await Promise.resolve();
    const revocation = gateway.revoke!(binding);
    assert.equal(gateway.isActiveBinding!({ ...binding, contextId: 'old' }), false);
    assert.equal(gateway.isActiveBinding!({ ...binding, contextId: 'new-directory' }), false);
    await Promise.all([submission, revocation]);
    assert.equal(await gateway.respond({ ...binding, contextId: 'old' }, approval.type === 'approval' ? approval.decisionId : '', { behavior: 'allow' }), false);
    const snapshot = await gateway.inspect!();
    assert.equal(snapshot.bindings.length, 2);
    assert.ok(snapshot.bindings.every(row => !row.active));
    assert.ok(snapshot.tasks.every(row => row.ended));
    assert.ok(snapshot.decisions.every(row => row.status !== 'pending'));
    assert.equal(gateway.status().pid, undefined);
    await assert.rejects(readFile(join(second, 'must-never-execute.txt')), /ENOENT/);
    const priorLaunches = launches;
    await gateway.close();
    gateway = createSuperagentGateway(options);
    await gateway.start();
    await delay(400);
    assert.equal(launches, priorLaunches);
    assert.equal(gateway.status().pid, undefined);
    assert.ok((await gateway.inspect!()).bindings.every(row => !row.active));
    await assert.rejects(gateway.submit({
      ...binding, contextId: 'new-directory', cwd: second, requestId: 'reactivate', sourceMessageId: 'owner-reactivate', text: 'echo cannot reactivate',
    }), /retired native context/);
  } finally { await gateway.close(); }
}));

test('startup owner policy retires orphaned pending work before any native wake but does not deny new input', { timeout: 45_000 }, () => isolated(async home => {
  const workspace = join(home, 'workspace');
  await mkdir(workspace);
  const binding = { botId: 'bot', threadId: 'chat', contextId: 'orphan' };
  const events: SuperagentEvent[] = [];
  let launches = 0;
  const options = {
    home, workspace, provider: 'fixture', model: 'fixture', fixture: true,
    memory: async () => ({}), onLaunch: () => { launches++; },
  };
  let gateway = createSuperagentGateway(options);
  gateway.subscribe(event => events.push(event));
  try {
    await gateway.submit({ ...binding, requestId: 'orphaned-task', sourceMessageId: 'owner-orphan', text: 'task attention', approvalMode: 'full' });
    await waitFor(() => events.find(event => event.type === 'completed' && event.requestId === 'orphaned-task'), 'pending original source');
    await gateway.close();
    const legacy = new DatabaseSync(join(home, 'official-superagent', 'bindings.sqlite'));
    try {
      legacy.prepare('UPDATE bindings SET needs_recovery=0,activity=?').run(JSON.stringify({ tasks: 0, pendingDecisions: 0, pendingDeliveries: 0 }));
      legacy.prepare('UPDATE deliveries SET persisted=1').run();
    } finally { legacy.close(); }
    const priorLaunches = launches;
    let checks = 0;
    gateway = createSuperagentGateway({
      ...options,
      canRecover: (candidate, input) => {
        checks++;
        assert.deepEqual(candidate, binding);
        assert.equal(input.approvalMode, 'full');
        return false;
      },
    });
    gateway.subscribe(event => events.push(event));
    await gateway.start();
    await waitFor(async () => !(await gateway.inspect!()).bindings[0]?.active ? true : undefined, 'startup revocation of orphaned work');
    assert.equal(checks, 1);
    assert.equal(launches, priorLaunches);
    assert.equal(gateway.status().pid, undefined);
    assert.ok((await gateway.inspect!()).tasks.every(task => task.ended));
    await gateway.close();
    gateway = createSuperagentGateway({ ...options, canRecover: () => false });
    gateway.subscribe(event => events.push(event));
    await gateway.start();
    await gateway.submit({ ...binding, contextId: 'fresh', requestId: 'fresh-source', sourceMessageId: 'owner-fresh', text: 'echo fresh current input' });
    await waitFor(() => events.find(event => event.type === 'reply' && event.requestId === 'fresh-source' && event.text === 'fresh current input'), 'current input does not use old-work recovery policy');
    assert.equal(gateway.isActiveBinding!(binding), false);
  } finally { await gateway.close(); }
}));

test('request Stop fences every consumed routing input of a reused native task and keeps later conversation live after restart', { timeout: 90_000 }, () => isolated(async home => {
  const workspace = join(home, 'workspace');
  await mkdir(workspace);
  const binding = { botId: 'bot', threadId: 'chat', contextId: 'continued' };
  const events: SuperagentEvent[] = [];
  let diagnostics = '';
  const options = {
    home, workspace, provider: 'fixture', model: 'fixture', fixture: true, memory: async () => ({}),
    onDiagnostic: (text: string) => { diagnostics = (diagnostics + text).slice(-15_000); },
  };
  let gateway = createSuperagentGateway(options);
  gateway.subscribe(event => events.push(event));
  const send = async (requestId: string, text: string, approvalMode: 'ask' | 'full' = 'ask') => {
    await gateway.submit({ ...binding, requestId, sourceMessageId: `owner-${requestId}`, text, approvalMode });
  };
  const completed = (requestId: string) => waitFor(() => events.find(event => event.type === 'completed' && event.requestId === requestId), `completed ${requestId}`);
  try {
    await send('initial-write', 'task write before-request-stop.txt', 'full');
    await completed('initial-write');
    await send('read-memory', 'task memory jasmine tea', 'full');
    await completed('read-memory');
    await gateway.interrupt(binding);
    for (const [requestId, behavior] of [['deny', 'deny'], ['allow', 'allow']] as const) {
      await send(requestId, 'task approval');
      const decision = await waitFor(() => events.find(event => event.type === 'approval' && event.requestId === requestId), `${requestId} decision`);
      assert.equal(await gateway.respond(binding, decision.type === 'approval' ? decision.decisionId : '', { behavior }), true);
      await completed(requestId);
    }
    await send('question', 'task question');
    const question = await waitFor(() => events.find(event => event.type === 'question' && event.requestId === 'question'), 'native question');
    assert.equal(await gateway.respond(binding, question.type === 'question' ? question.decisionId : '', { behavior: 'answer', message: 'Markdown' }), true);
    await completed('question');
    await send('held', 'task hold');
    const held = await waitFor(async () => {
      const snapshot = await gateway.inspect!();
      return snapshot.resources.activeCalls ? snapshot.tasks.find(task => task.requestId === 'held' && !task.ended && task.state === 'working') : undefined;
    }, 'reused task consumed held request');
    await gateway.interrupt(binding, { scope: 'request', requestId: 'held' });
    assert.equal((await gateway.inspect!()).tasks.find(task => task.ticketId === held.ticketId)?.state, 'stopped');
    for (const requestId of ['echo-after-request-stop', 'second-echo-after-request-stop']) {
      await send(requestId, `echo ${requestId}`);
      await completed(requestId);
    }
    const count = (await gateway.inspect!()).tasks.length;
    assert.equal(count, 2);
    const database = new DatabaseSync(join(home, 'official-superagent', 'bindings.sqlite'), { readOnly: true });
    try {
      const request = database.prepare('SELECT request_id,revoked,admission_revoked FROM requests WHERE request_id IN (?,?,?,?) ORDER BY request_id')
        .all('deny', 'allow', 'question', 'held') as Array<{ request_id: string; revoked: number; admission_revoked: number }>;
      assert.equal(request.length, 4);
      assert.ok(request.every(row => row.admission_revoked === 1));
      assert.ok(request.filter(row => row.request_id !== 'held').every(row => row.revoked === 0));
      assert.equal((database.prepare('SELECT ticket_id FROM stopped_tickets WHERE ticket_id=?').get(held.ticketId) as { ticket_id?: string } | undefined)?.ticket_id, held.ticketId);
    } finally { database.close(); }
    await gateway.close();
    const legacy = new DatabaseSync(join(home, 'official-superagent', 'bindings.sqlite'));
    try { legacy.exec('DELETE FROM task_state'); } finally { legacy.close(); }
    gateway = createSuperagentGateway(options);
    gateway.subscribe(event => events.push(event));
    await send('echo-after-request-stop-restart', 'echo persisted source admission fence');
    await completed('echo-after-request-stop-restart');
    assert.equal((await gateway.inspect!()).tasks.length, count);
  } catch (error) {
    throw new Error(`${String(error)}\n${JSON.stringify({ events: events.slice(-70), snapshot: await gateway.inspect!(), diagnostics }, null, 2)}`, { cause: error });
  } finally { await gateway.close(); }
}));
