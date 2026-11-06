import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { canonicalWorkspace, HostResources } from '../src/host-resources.ts';

test('canonical workspace write windows serialize across host instances and resolve symlinks', async () => {
  const home = await mkdtemp(join(tmpdir(), 'omb-host-workspace-'));
  const workspace = join(home, 'workspace');
  await mkdir(workspace);
  await symlink(workspace, join(home, 'alias'));
  const first = new HostResources({ directory: join(home, 'resources'), maxConcurrentCalls: 2 });
  const second = new HostResources({ directory: join(home, 'resources'), maxConcurrentCalls: 2 });
  const firstOwner = first.owner('one', 'child');
  const secondOwner = second.owner('two', 'child');
  try {
    assert.equal(canonicalWorkspace(workspace), canonicalWorkspace(join(home, 'alias')));
    await first.acquire('workspace', 'writer-one', firstOwner, process.pid, workspace);
    let acquired = false;
    const waiting = second.acquire('workspace', 'writer-two', secondOwner, process.pid, join(home, 'alias')).then(() => { acquired = true; });
    await delay(100);
    assert.equal(acquired, false);
    first.release('writer-one', firstOwner);
    await waiting;
    assert.equal(acquired, true);
    second.release('writer-two', secondOwner);
  } finally { first.close(); second.close(); await rm(home, { recursive: true, force: true }); }
});

test('model semaphore, queued cancellation and persistent quotas cover independent runtimes', async () => {
  const home = await mkdtemp(join(tmpdir(), 'omb-host-model-'));
  const options = { directory: home, maxConcurrentCalls: 1, maxModelRequests: 2, tokenLimit: 10 };
  let host = new HostResources(options);
  const owner = host.owner('one', 'child');
  try {
    await host.acquire('model', 'one', owner, process.pid);
    const cancelled = host.acquire('model', 'cancelled', owner, process.pid);
    await delay(60);
    assert.equal(host.snapshot().queuedCalls, 1);
    host.release('cancelled', owner);
    await assert.rejects(cancelled, /abort|cancel/i);
    assert.equal(host.snapshot().activeCalls, 1);
    const usage = { usageId: 'one', requestId: 'first', agentId: 'master', role: 'master' as const, inputTokens: 3, outputTokens: 2 };
    assert.equal(host.recordUsage(owner, usage), true);
    assert.equal(host.recordUsage(owner, usage), false);
    host.release('one', owner);
    await host.acquire('model', 'two', owner, process.pid);
    host.recordUsage(owner, { ...usage, usageId: 'two', role: 'worker', inputTokens: 2, outputTokens: 3 });
    host.release('two', owner);
    await assert.rejects(host.acquire('model', 'three', owner, process.pid), /budget reached/);
    assert.deepEqual({ input: host.snapshot().inputTokens, output: host.snapshot().outputTokens, count: host.snapshot().admittedCalls }, { input: 5, output: 5, count: 2 });
    assert.equal(host.snapshot().costUsd, undefined);
    assert.equal(host.snapshot().unpricedCalls, 2);
    host.close();
    host = new HostResources(options);
    await assert.rejects(host.acquire('model', 'after-restart', host.owner('two', 'child'), process.pid), /budget reached/);
    host.close();
    host = new HostResources({ ...options, maxModelRequests: 3, tokenLimit: 20 });
    assert.equal(host.snapshot().inputTokens + host.snapshot().outputTokens, 10);
    const resumedOwner = host.owner('updated-policy', 'child');
    await host.acquire('model', 'updated-policy', resumedOwner, process.pid);
    host.release('updated-policy', resumedOwner);
    assert.equal(host.snapshot().admittedCalls, 3);
  } finally { host.close(); await rm(home, { recursive: true, force: true }); }
});

test('host model slots are shared across processes and a dead exact owner releases its slot', async () => {
  const home = await mkdtemp(join(tmpdir(), 'omb-host-process-'));
  const host = new HostResources({ directory: home, maxConcurrentCalls: 1 });
  const module = new URL('../src/host-resources.ts', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import {HostResources} from ${JSON.stringify(module)};
    const host=new HostResources({directory:process.argv[1],maxConcurrentCalls:1});
    await host.acquire('model','child',host.owner('child','self'),process.pid);
    process.stdout.write('acquired\\n');
    setInterval(()=>{},1000);
  `, home], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    let output = '';
    child.stdout.on('data', chunk => { output += String(chunk); });
    const deadline = Date.now() + 5_000;
    while (!output.includes('acquired') && Date.now() < deadline) await delay(20);
    assert.match(output, /acquired/);
    const owner = host.owner('parent', 'self');
    let acquired = false;
    const waiting = host.acquire('model', 'parent', owner, process.pid).then(() => { acquired = true; });
    await delay(100);
    assert.equal(acquired, false);
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    await waiting;
    assert.equal(acquired, true);
    assert.equal(host.snapshot().activeCalls, 1);
    host.release('parent', owner);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    host.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('Git siblings and non-Git ancestor scopes coordinate while disjoint folders remain independent', async () => {
  const home = await mkdtemp(join(tmpdir(), 'omb-host-tree-'));
  const repository = join(home, 'repository');
  await mkdir(join(repository, 'src'), { recursive: true });
  await mkdir(join(repository, 'tests'));
  execFileSync('git', ['init', '--quiet', repository], { stdio: 'ignore' });
  const plain = join(home, 'plain');
  await mkdir(join(plain, 'child'), { recursive: true });
  const separate = join(home, 'separate');
  await mkdir(separate);
  const host = new HostResources({ directory: join(home, 'resources') });
  const owner = host.owner('same-host', 'child');
  try {
    await host.acquire('workspace', 'git-source', owner, process.pid, join(repository, 'src'));
    let secondAcquired = false;
    const gitWaiting = host.acquire('workspace', 'git-tests', owner, process.pid, join(repository, 'tests')).then(() => { secondAcquired = true; });
    await delay(80);
    assert.equal(secondAcquired, false);
    host.release('git-source', owner);
    await gitWaiting;
    host.release('git-tests', owner);
    await host.acquire('workspace', 'plain-parent', owner, process.pid, plain);
    let childAcquired = false;
    const childWaiting = host.acquire('workspace', 'plain-child', owner, process.pid, join(plain, 'child')).then(() => { childAcquired = true; });
    await host.acquire('workspace', 'disjoint', owner, process.pid, separate);
    await delay(80);
    assert.equal(childAcquired, false);
    host.release('plain-parent', owner);
    await childWaiting;
    host.release('plain-child', owner);
    host.release('disjoint', owner);
  } finally { host.close(); await rm(home, { recursive: true, force: true }); }
});

test('competing first host processes cannot install conflicting policies', async () => {
  const home = await mkdtemp(join(tmpdir(), 'omb-host-policy-race-'));
  const module = new URL('../src/host-resources.ts', import.meta.url).href;
  const children = [2, 3].map(max => spawn(process.execPath, ['--input-type=module', '-e', `
    import {HostResources} from ${JSON.stringify(module)};
    process.stdin.once('data',()=>{
      try {
        new HostResources({directory:process.argv[1],maxConcurrentCalls:Number(process.argv[2])});
        process.stdout.write('owner\\n');
        setInterval(()=>{},1000);
      } catch(error) {
        process.stdout.write('refused:'+String(error)+'\\n');
        process.exitCode=1;
        process.stdin.destroy();
      }
    });
  `, home, String(max)], { stdio: ['pipe', 'pipe', 'pipe'] }));
  const output = ['', ''];
  try {
    for (const [index, child] of children.entries()) { child.stdout.on('data', chunk => { output[index] += String(chunk); }); child.stdin.write('go\n'); }
    const deadline = Date.now() + 5_000;
    while (output.some(value => !value.trim()) && Date.now() < deadline) await delay(20);
    assert.equal(output.filter(value => value.startsWith('owner')).length, 1, JSON.stringify(output));
    assert.equal(output.filter(value => value.startsWith('refused:') && value.includes('policy')).length, 1, JSON.stringify(output));
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    await rm(home, { recursive: true, force: true });
  }
});

test('a dead native leader does not release its host slot while an owned process group is alive', { skip: process.platform === 'win32' }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'omb-host-group-'));
  const host = new HostResources({ directory: home, maxConcurrentCalls: 1 });
  const module = new URL('../src/host-resources.ts', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import {spawn} from 'node:child_process';
    import {HostResources} from ${JSON.stringify(module)};
    const host=new HostResources({directory:process.argv[1],maxConcurrentCalls:1});
    await host.acquire('model','child',host.owner('child','self'),process.pid);
    const tool=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});
    process.stdout.write('acquired:'+tool.pid+'\\n');
    setInterval(()=>{},1000);
  `, home], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  try {
    let output = '';
    child.stdout.on('data', chunk => { output += String(chunk); });
    const deadline = Date.now() + 5_000;
    while (!output.includes('acquired:') && Date.now() < deadline) await delay(20);
    assert.match(output, /acquired:\d+/);
    const leaderExit = once(child, 'exit');
    child.kill('SIGKILL');
    await leaderExit;
    const owner = host.owner('parent', 'self');
    let acquired = false;
    const waiting = host.acquire('model', 'parent', owner, process.pid).then(() => { acquired = true; });
    await delay(100);
    assert.equal(acquired, false);
    process.kill(-child.pid!, 'SIGKILL');
    await waiting;
    assert.equal(acquired, true);
    host.release('parent', owner);
  } finally {
    try { process.kill(-child.pid!, 'SIGKILL'); } catch {}
    if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
    host.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('a configured USD cap fails closed for unpriced calls and refuses conflicting host policies', async () => {
  const home = await mkdtemp(join(tmpdir(), 'omb-host-usd-'));
  const host = new HostResources({ directory: home, costLimitUsd: 1 });
  try {
    const owner = host.owner('one', 'child');
    await host.acquire('model', 'unknown-price', owner, process.pid);
    host.recordUsage(owner, { usageId: 'unknown-price', requestId: 'first', agentId: 'master', role: 'master', inputTokens: 1, outputTokens: 1 });
    host.release('unknown-price', owner);
    await assert.rejects(host.acquire('model', 'next', owner, process.pid), /cannot be verified/);
    assert.throws(() => new HostResources({ directory: home, costLimitUsd: 2 }), /policy/);
  } finally { host.close(); await rm(home, { recursive: true, force: true }); }
});

test('dead acquired writers quarantine their shared scope across process restart until explicit reconciliation', async () => {
  const home = await mkdtemp(join(tmpdir(), 'omb-host-quarantine-'));
  const workspace = join(home, 'workspace');
  await mkdir(join(workspace, 'nested'), { recursive: true });
  const directory = join(home, 'resources');
  let host = new HostResources({ directory });
  const module = new URL('../src/host-resources.ts', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import {HostResources} from ${JSON.stringify(module)};
    const host=new HostResources({directory:process.argv[1]});
    await host.acquire('workspace','writer',host.owner('child','self'),process.pid,process.argv[2]);
    process.stdout.write('acquired\\n');
    setInterval(()=>{},1000);
  `, directory, workspace], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    let output = '';
    child.stdout.on('data', chunk => { output += String(chunk); });
    const deadline = Date.now() + 5_000;
    while (!output.includes('acquired') && Date.now() < deadline) await delay(20);
    assert.match(output, /acquired/);
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    const quarantine = host.snapshot().quarantinedWorkspaces[0];
    assert.ok(quarantine);
    assert.equal(quarantine.workspace, canonicalWorkspace(workspace));
    const owner = host.owner('parent', 'self');
    await assert.rejects(host.acquire('workspace', 'blocked', owner, process.pid, join(workspace, 'nested')), /quarantined/);
    await host.acquire('model', 'read-only', owner, process.pid);
    host.release('read-only', owner);
    host.close();
    host = new HostResources({ directory });
    assert.equal(host.snapshot().quarantinedWorkspaces[0]?.id, quarantine.id);
    assert.equal(host.releaseWorkspace('unrelated-id'), false);
    assert.equal(host.releaseWorkspace(quarantine.id), true);
    assert.equal(host.releaseWorkspace(quarantine.id), false);
    await host.acquire('workspace', 'reconciled', host.owner('new', 'self'), process.pid, workspace);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    host.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('a dead queued writer does not quarantine a scope it never acquired', async () => {
  const home = await mkdtemp(join(tmpdir(), 'omb-host-queued-writer-'));
  const workspace = join(home, 'workspace');
  await mkdir(workspace);
  const directory = join(home, 'resources');
  const host = new HostResources({ directory });
  const module = new URL('../src/host-resources.ts', import.meta.url).href;
  const owner = host.owner('active', 'self');
  await host.acquire('workspace', 'active', owner, process.pid, workspace);
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import {HostResources} from ${JSON.stringify(module)};
    const host=new HostResources({directory:process.argv[1]});
    const pending=host.acquire('workspace','writer',host.owner('queued','self'),process.pid,process.argv[2]);
    process.stdout.write('queued\\n');
    await pending;
    process.stdout.write('unexpected-acquired\\n');
    setInterval(()=>{},1000);
  `, directory, workspace], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    let output = '';
    child.stdout.on('data', chunk => { output += String(chunk); });
    const deadline = Date.now() + 5_000;
    while (!output.includes('queued') && Date.now() < deadline) await delay(20);
    assert.match(output, /queued/);
    assert.doesNotMatch(output, /unexpected-acquired/);
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    assert.deepEqual(host.snapshot().quarantinedWorkspaces, []);
    host.release('active', owner);
    await host.acquire('workspace', 'next', owner, process.pid, workspace);
    host.release('next', owner);
    assert.deepEqual(host.snapshot().quarantinedWorkspaces, []);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    host.close();
    await rm(home, { recursive: true, force: true });
  }
});
