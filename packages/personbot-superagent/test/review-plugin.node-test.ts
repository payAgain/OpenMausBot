import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { prepareLaunch, type ChildConfiguration } from '../src/launch.ts';
import { Peer } from '../src/rpc.ts';

type Event = { type: string; requestId?: string; decisionId?: string; role?: string; ended?: boolean; ticketId?: string; authorizationVersion?: number; name?: string; prompt?: string };
async function waitFor<T>(read: () => T | undefined, label: string): Promise<T> {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const result = read();
    if (result !== undefined) return result;
    await delay(20);
  }
  throw new Error(`Timed out: ${label}`);
}

test('native plugin keeps background decisions, caller identity and host execution leases beyond input completion', { timeout: 90_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'omb-native-review-'));
  const workspace = join(home, 'workspace');
  await mkdir(workspace);
  const config = { home, workspace, bindingId: 'private-native-binding', provider: 'official-fixture', model: 'fixture', fixture: true, requestAuthorizations: [] };
  const launch = await prepareLaunch(config);
  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd, env: {
      ...launch.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, XDG_STATE_HOME: home, XDG_DATA_HOME: home,
      OMB_DATA_DIR: join(home, 'original-product'),
    }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const peer = new Peer(child.stdout, child.stdin);
  let diagnostics = '';
  child.stderr.on('data', chunk => { diagnostics = (diagnostics + String(chunk)).slice(-40_000); });
  const events: Event[] = [];
  const memory: Array<{ operation: string; caller: { requestId: string; sourceMessageId?: string; authorizationVersion: number; role: string } }> = [];
  const leases: Array<{ method: string; params: Record<string, unknown> }> = [];
  const delivered: Array<Record<string, unknown>> = [];
  peer.notification = (method, params) => { if (method === 'event') events.push(params as Event); };
  peer.handler = async (method, params) => {
    const value = params as Record<string, unknown>;
    if (method === 'memory') { memory.push(value as unknown as (typeof memory)[number]); return { ok: true }; }
    if (method === 'deliver') { delivered.push(value); return {}; }
    if (['model-acquire', 'workspace-acquire', 'model-release', 'workspace-release'].includes(method)) {
      leases.push({ method, params: value });
      return { leaseId: value.leaseId };
    }
    throw new Error(`Unknown host RPC ${method}`);
  };
  const submit = (requestId: string, text: string, authorizationVersion = 7) => peer.request('submit', { requestId, text, sourceMessageId: `source-${requestId}`, authorizationVersion });
  try {
    await peer.request('initialize', undefined, 45_000);
    await submit('remember', 'remember I prefer jasmine tea.', 17);
    await waitFor(() => events.find(event => event.type === 'completed' && event.requestId === 'remember'), 'native remember completion');
    const remembered = memory.find(request => request.operation === 'remember');
    assert.ok(remembered, diagnostics);
    assert.deepEqual({ requestId: remembered.caller.requestId, sourceMessageId: remembered.caller.sourceMessageId, authorizationVersion: remembered.caller.authorizationVersion, role: remembered.caller.role }, {
      requestId: 'remember', sourceMessageId: 'source-remember', authorizationVersion: 17, role: 'master',
    });
    await submit('main-write', 'probe main write native-main.txt');
    await waitFor(() => events.find(event => event.type === 'completed' && event.requestId === 'main-write'), 'native main mutating tool');
    assert.equal(await readFile(join(home, 'state', 'native-main.txt'), 'utf8'), 'native-main-write\n');
    assert.ok(leases.some(entry => entry.method === 'workspace-acquire' && entry.params.requestId === 'main-write'
      && String(entry.params.agentId).startsWith('orchestrator-')));
    await submit('worker-write-attempt', 'task remember I own a yacht.');
    await waitFor(() => events.find(event => event.type === 'completed' && event.requestId === 'worker-write-attempt'), 'worker read-only memory task');
    assert.equal(memory.some(request => request.caller.role === 'worker' && ['remember', 'forget'].includes(request.operation)), false);
    await submit('proposal', 'task propose The person may prefer black tea.');
    await waitFor(() => events.find(event => event.type === 'completed' && event.requestId === 'proposal'), 'worker proposal relay');
    assert.ok(events.some(event => event.type === 'tool' && event.requestId === 'proposal' && event.name === 'memory_propose'));
    assert.equal(memory.filter(request => ['remember', 'forget'].includes(request.operation)).length, 1);
    const backgroundOffset = events.length;
    await submit('background', 'task background approval');
    await waitFor(() => events.slice(backgroundOffset).find(event => event.type === 'completed' && event.requestId === 'background'), 'input completion before approval');
    const decision = await waitFor(() => events.slice(backgroundOffset).find(event => event.type === 'approval' && event.requestId === 'background'), 'background native approval after input completion');
    const completionIndex = events.findIndex(event => event.type === 'completed' && event.requestId === 'background');
    const approvalIndex = events.indexOf(decision);
    assert.ok(completionIndex >= 0 && completionIndex < approvalIndex, JSON.stringify(events));
    assert.equal(decision.role, 'worker');
    assert.equal(decision.authorizationVersion, 7);
    assert.ok(decision.prompt?.startsWith(`Execution directory: ${workspace}\n`));
    assert.ok(decision.ticketId);
    const snapshot = await peer.request('inspect') as { pendingDecisions: number; tasks: Array<{ ticketId: string; ended: boolean }> };
    assert.equal(snapshot.pendingDecisions, 1);
    assert.equal(snapshot.tasks.find(task => task.ticketId === decision.ticketId)?.ended, false);
    assert.equal(await peer.request('respond', { decisionId: decision.decisionId, behavior: 'answer', message: 'Not a permission decision' }), false);
    assert.equal(await peer.request('respond', { decisionId: decision.decisionId, behavior: 'allow' }), true);
    await waitFor(() => events.find(event => event.type === 'decision.resolved' && event.decisionId === decision.decisionId), 'native decision resolution');
    await waitFor(() => events.slice(backgroundOffset).find(event => event.type === 'task' && event.ticketId === decision.ticketId && event.ended), 'background task terminal state');
    await waitFor(() => delivered.find(delivery => delivery.purpose === 'result' && delivery.requestId === 'background'), 'background final result delivery');
    assert.equal(await readFile(join(workspace, 'official-approved.txt'), 'utf8'), 'approved\n');
    assert.ok(delivered.some(delivery => delivery.purpose === 'result' && delivery.requestId === 'background'));
    await waitFor(() => leases.find(entry => entry.method === 'workspace-release'), 'worker workspace release after execution');
    const modelAcquire = leases.filter(entry => entry.method === 'model-acquire');
    const modelRelease = leases.filter(entry => entry.method === 'model-release');
    assert.ok(modelAcquire.some(entry => entry.params.role === 'master'));
    assert.ok(modelAcquire.some(entry => entry.params.role === 'worker'));
    assert.ok(modelRelease.some(entry => (entry.params.usage as { inputTokens?: number } | undefined)?.inputTokens === 13));
    assert.ok(leases.some(entry => entry.method === 'workspace-acquire' && entry.params.mode === 'write'));
    await peer.request('generate', { requestId: 'upkeep', prompt: 'CAPTURE step' });
    assert.ok(leases.some(entry => entry.method === 'model-acquire' && entry.params.role === 'upkeep'));
    await peer.request('shutdown');
  } catch (error) {
    throw new Error(`${String(error)}\n${diagnostics}\n${JSON.stringify({ events, memory, delivered, leases }, null, 2)}`, { cause: error });
  } finally {
    peer.close();
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await Promise.race([once(child, 'exit'), delay(3_000)]);
    }
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); }
    await rm(home, { recursive: true, force: true });
  }
});

for (const scope of ['task', 'request'] as const) test(`${scope} Stop fences consumed source admission before persistence and restores fences before native Sessions resume`, { timeout: 90_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'omb-native-stop-admission-'));
  const workspace = join(home, 'workspace');
  await mkdir(workspace);
  const packets: Array<{ bindingId: string; ticketId: string; requestIds: string[]; stoppedRequestId?: string }> = [];
  const events: Event[] = [];
  const calls: Array<{ method: string; requestId?: string; role?: string; routingAdmission?: boolean; ticketId?: string }> = [];
  let diagnostics = '';
  const launchNative = async (stoppedTicketIds: string[] = [], stoppedRequestIds: string[] = []) => {
    const config: ChildConfiguration = {
      home, workspace, bindingId: 'private-stop-binding', provider: 'official-fixture', model: 'fixture', fixture: true,
      stoppedTicketIds, fencedRequestIds: [],
      stoppedRequestIds,
      requestAuthorizations: ['origin', 'consumed', 'after-stop-1', 'after-stop-2'].filter(requestId => !stoppedRequestIds.includes(requestId)).map(requestId => ({
        requestId, sourceMessageId: `source-${requestId}`, authorizationVersion: 9,
      })),
    };
    const launch = await prepareLaunch(config);
    const child = spawn(launch.command, launch.args, {
      cwd: launch.cwd, env: { ...launch.env, HOME: home, USERPROFILE: home, OMB_DATA_DIR: join(home, 'original-product') },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const peer = new Peer(child.stdout, child.stdin);
    child.stderr.on('data', chunk => { diagnostics = (diagnostics + String(chunk)).slice(-30_000); });
    peer.notification = (method, params) => {
      if (method !== 'event') return;
      const event = params as Event;
      events.push(event);
      if (event.type === 'task') calls.push({ method: 'event.task', ticketId: event.ticketId });
    };
    peer.handler = async (method, params) => {
      const value = params as Record<string, unknown>;
      calls.push({ method, requestId: value.requestId as string | undefined, role: value.role as string | undefined,
        routingAdmission: value.routingAdmission as boolean | undefined });
      if (method === 'fence-admission') { packets.push(value as (typeof packets)[number]); return true; }
      if (['deliver', 'memory', 'model-acquire', 'model-release', 'workspace-acquire', 'workspace-release'].includes(method)) return {};
      throw new Error(`Unknown host operation ${method}`);
    };
    const close = async () => {
      try { await peer.request('shutdown', undefined, 15_000); } catch {}
      peer.close();
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await Promise.race([once(child, 'exit'), delay(3_000)]);
      }
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); }
    };
    return { peer, close };
  };
  let native = await launchNative();
  const submit = (requestId: string, text: string) => native.peer.request('submit', {
    requestId, text, sourceMessageId: `source-${requestId}`, authorizationVersion: 9,
  });
  try {
    await native.peer.request('initialize', undefined, 45_000);
    await submit('origin', 'task write before-stop.txt');
    await waitFor(() => events.find(event => event.type === 'completed' && event.requestId === 'origin'), 'initial completed worker');
    await submit('consumed', 'task hold');
    await waitFor(() => calls.find(call => call.method === 'model-acquire' && call.requestId === 'consumed' && call.role === 'worker'),
      'reused worker actually consumed follow-up');
    const snapshot = await native.peer.request('inspect') as { tasks: Array<{ ticketId: string; ended: boolean; requestId: string }> };
    const selected = snapshot.tasks.find(task => !task.ended && task.requestId === 'consumed');
    assert.ok(selected, `${diagnostics}\n${JSON.stringify(snapshot)}`);
    await native.peer.request('interrupt', scope === 'task'
      ? { scope, ticketId: selected.ticketId, stoppedTicketIds: [selected.ticketId] }
      : { scope, requestId: 'consumed', stoppedRequestIds: ['consumed'], stoppedTicketIds: [] });
    assert.ok(packets.some(packet => packet.bindingId === 'private-stop-binding' && packet.ticketId === selected.ticketId
      && packet.requestIds.includes('origin') && packet.requestIds.includes('consumed')));
    if (scope === 'request') assert.ok(packets.some(packet => packet.stoppedRequestId === 'consumed'));
    assert.ok(calls.some(call => call.method === 'model-acquire' && call.role === 'master' && call.routingAdmission === true));
    assert.ok(calls.some(call => call.method === 'model-acquire' && call.role === 'master' && call.routingAdmission === false));
    for (const requestId of ['after-stop-1', 'after-stop-2']) {
      await submit(requestId, `echo ${requestId}`);
      await waitFor(() => events.find(event => event.type === 'completed' && event.requestId === requestId), `ordinary reply ${requestId}`);
    }
    const stopped = await native.peer.request('inspect') as typeof snapshot;
    assert.equal(stopped.tasks.length, snapshot.tasks.length);
    assert.equal(stopped.tasks.find(task => task.ticketId === selected.ticketId)?.ended, true);
    await native.close();
    const callOffset = calls.length;
    const packetOffset = packets.length;
    native = scope === 'request' ? await launchNative([], ['consumed']) : await launchNative([selected.ticketId]);
    await native.peer.request('initialize', undefined, 45_000);
    assert.ok(packets.slice(packetOffset).some(packet => packet.ticketId === selected.ticketId
      && packet.requestIds.includes('origin') && packet.requestIds.includes('consumed')));
    const recoveryCalls = calls.slice(callOffset);
    const fence = recoveryCalls.findIndex(call => call.method === 'fence-admission');
    const projection = recoveryCalls.findIndex(call => call.method === 'event.task' && call.ticketId === selected.ticketId);
    const firstModel = recoveryCalls.findIndex(call => call.method === 'model-acquire');
    assert.ok(projection >= 0 && projection < fence, JSON.stringify(recoveryCalls));
    assert.ok(fence >= 0 && (firstModel === -1 || fence < firstModel), JSON.stringify(recoveryCalls));
    await submit('after-recovery', 'echo continued after scoped-stop recovery');
    await waitFor(() => events.find(event => event.type === 'completed' && event.requestId === 'after-recovery'), 'reply after restored admission fence');
    assert.equal((await native.peer.request('inspect') as typeof snapshot).tasks.length, snapshot.tasks.length);
  } catch (error) {
    throw new Error(`${String(error)}\n${diagnostics}\n${JSON.stringify({ events, packets, calls }, null, 2)}`, { cause: error });
  } finally {
    await native.close();
    await rm(home, { recursive: true, force: true });
  }
});
