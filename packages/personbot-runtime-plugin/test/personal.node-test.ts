import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import {
  EVENT_METHOD,
  type ArtifactChunk,
  type ArtifactSnapshot,
  type MemoryRecord,
  type PersonalSnapshot,
  type ProjectRecord,
  type RoleRecord,
  type RuntimeEvent,
  type TaskRecord,
  type TaskSnapshot,
} from '../../personbot-protocol/src/index.ts';
import {
  projectSessionEvents,
  type NativeSessionEvent,
  type SessionSummary,
} from '../../personbot-projection/src/index.ts';
import { spawnRuntime, type RuntimeHost } from '../../personbot-runtime-host/src/index.ts';
import { prepareRuntime } from '../src/launch.ts';

interface NativeEvent extends NativeSessionEvent {
  data: {
    id?: string;
    source?: { kind: string };
    content?: { type: string; text?: string }[];
    message?: { content: { type: string; text?: string }[] };
  };
}

class PersonalFixture {
  readonly runtime: RuntimeHost;
  readonly events: RuntimeEvent[] = [];

  constructor(runtime: RuntimeHost) {
    this.runtime = runtime;
    runtime.onNotification(notification => {
      if (notification.method === EVENT_METHOD) this.events.push(notification.params as RuntimeEvent);
    });
  }

  personal(): Promise<PersonalSnapshot> {
    return this.runtime.request('personbot.v1.personal.snapshot', {});
  }

  tasks(): Promise<TaskSnapshot> {
    return this.runtime.request('personbot.v1.tasks.list', {});
  }

  async until<T>(read: () => Promise<T>, matches: (value: T) => boolean, description: string): Promise<T> {
    const deadline = Date.now() + 15_000;
    let latest: T | undefined;
    while (Date.now() < deadline) {
      latest = await read();
      if (matches(latest)) return latest;
      await delay(20);
    }
    assert.fail(`${description}; last value ${JSON.stringify(latest)}\n${this.runtime.stderrTail}`);
  }

  async event(matches: (event: RuntimeEvent) => boolean, description: string, from = 0): Promise<RuntimeEvent> {
    const event = await this.until(
      async () => this.events.slice(from).find(matches),
      value => value !== undefined,
      description,
    );
    return event!;
  }

  native(type: string, sessionId: string, from = 0): Promise<RuntimeEvent> {
    return this.event(event => event.type === 'session.event' && event.sessionId === sessionId
      && (event.payload as { event: NativeEvent }).event.type === type, `${sessionId} did not emit ${type}`, from);
  }

  decision(kind: 'approval' | 'question', sessionId: string): Promise<RuntimeEvent> {
    return this.event(event => event.type === `${kind}.requested` && event.sessionId === sessionId,
      `${sessionId} did not request ${kind}`);
  }

  async history(sessionId: string): Promise<NativeEvent[]> {
    const events: NativeEvent[] = [];
    let fromSeq = 0;
    for (;;) {
      const snapshot = await this.runtime.request<{
        logs: { sessionId: string; events: NativeEvent[]; nextSeq: number; hasMore: boolean }[];
      }>('personbot.v1.snapshots.get', { sessionId, fromSeq, limit: 100 });
      const log = snapshot.logs.find(row => row.sessionId === sessionId);
      assert.ok(log);
      events.push(...log.events);
      if (!log.hasMore) return events;
      assert.ok(log.nextSeq > fromSeq);
      fromSeq = log.nextSeq;
    }
  }

  async say(sessionId: string, text: string, identity = randomUUID()): Promise<string> {
    const from = this.events.length;
    await this.runtime.request('personbot.v1.messages.submit', {
      commandId: `command-${identity}`, messageId: `message-${identity}`, sessionId, text, mode: 'followup',
    });
    await this.native('turn/end', sessionId, from);
    const message = (await this.history(sessionId)).findLast(event => event.type === 'assistant/message');
    assert.ok(message);
    return (message.data.message?.content ?? [])
      .filter(block => block.type === 'text').map(block => block.text).join('\n');
  }

  async context(sessionId: string): Promise<string> {
    const reply = JSON.parse(await this.say(sessionId, 'context')) as { context: string };
    assert.equal(typeof reply.context, 'string');
    return reply.context;
  }

  createTask(goal: string, originSessionId = 'main'): Promise<TaskRecord> {
    return this.runtime.request('personbot.v1.tasks.create', {
      commandId: randomUUID(), taskId: randomUUID(), originSessionId, goal,
      criteria: ['Fixture evidence and authorized output are available'],
    });
  }

  async settled(taskId: string): Promise<TaskRecord> {
    const snapshot = await this.until(
      () => this.tasks(),
      value => value.tasks.some(task => task.id === taskId && task.stage === 'awaiting_review'
        && task.stopState === 'confirmed'),
      `Task ${taskId} did not settle with a confirmed review report`,
    );
    return snapshot.tasks.find(task => task.id === taskId)!;
  }

  async close(): Promise<void> {
    const exit = await this.runtime.close({ graceMs: 10_000 });
    assert.equal(exit.code, 0, JSON.stringify(exit));
  }
}

async function fixtureSpace(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'personbot-personal-native-'));
  const home = join(directory, 'home');
  const cwd = join(directory, 'workspace');
  await mkdir(home);
  await mkdir(cwd);
  const hosts = new Set<RuntimeHost>();
  t.after(async () => {
    await Promise.all([...hosts].map(host => host.close({ graceMs: 10_000 })));
    await rm(directory, { recursive: true, force: true });
  });
  const start = async (): Promise<PersonalFixture> => {
    const options = await prepareRuntime({
      home, workspace: cwd, provider: 'personbot-fixture', model: 'fixture', fixture: true,
    });
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: home,
      USERPROFILE: home,
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
      TEMP: process.env.TEMP ?? tmpdir(),
      SystemRoot: process.env.SystemRoot,
      LANG: 'en_US.UTF-8',
      DSH_HOME: options.env.DSH_HOME,
      DSH_PRIMARY_RUNTIME: '',
      DSH_TELEMETRY_DISABLED: '1',
    };
    const runtime = spawnRuntime({ ...options, env, defaultTimeoutMs: 25_000 });
    hosts.add(runtime);
    const fixture = new PersonalFixture(runtime);
    await runtime.request('personbot.v1.initialize', { protocolVersion: 1 });
    return fixture;
  };
  return { home, cwd, directory, start };
}

test('bound native inputs use frozen roles and current confirmed memory across corrections and restart', { timeout: 90_000 }, async t => {
  const { cwd, start } = await fixtureSpace(t);
  let fixture = await start();
  const project = await fixture.runtime.request<ProjectRecord>('personbot.v1.projects.put', {
    commandId: randomUUID(), projectId: 'project-one', name: 'Controlled project', path: cwd, kind: 'directory',
  });
  const role = await fixture.runtime.request<RoleRecord>('personbot.v1.roles.put', {
    commandId: randomUUID(), roleId: 'researcher', name: 'Researcher',
    instructions: 'ROLE_FIXTURE_V1: cite only controlled fixture data.',
  });
  await fixture.runtime.request('personbot.v1.memory.put', {
    commandId: randomUUID(), memoryId: 'personal-format', scope: 'personal', key: 'format',
    value: 'PERSONAL_MEMORY_MARKER: use Markdown.',
  });
  await fixture.runtime.request('personbot.v1.memory.put', {
    commandId: randomUUID(), memoryId: 'project-hint', scope: 'project', projectId: project.id, key: 'scope',
    value: 'PROJECT_MEMORY_MARKER: the project is Alpha.',
  });
  await fixture.runtime.request<ProjectRecord>('personbot.v1.projects.put', {
    commandId: randomUUID(), projectId: 'other-project', name: 'Other project', path: cwd, kind: 'directory',
  });
  await fixture.runtime.request('personbot.v1.memory.put', {
    commandId: randomUUID(), memoryId: 'other-hint', scope: 'project', projectId: 'other-project', key: 'scope',
    value: 'OTHER_PROJECT_MUST_NOT_LEAK',
  });
  const session = await fixture.runtime.request<SessionSummary>('personbot.v1.sessions.create', {
    sessionId: 'main', conversationId: 'conversation-main', projectId: project.id, roleId: role.id,
  });
  assert.equal(session.cwd, await realpath(cwd));
  assert.equal(session.projectId, project.id);
  assert.equal(session.roleRevision, role.revision);
  const first = await fixture.context('main');
  assert.match(first, /ROLE_FIXTURE_V1/);
  assert.match(first, /PERSONAL_MEMORY_MARKER/);
  assert.match(first, /PROJECT_MEMORY_MARKER/);
  assert.doesNotMatch(first, /OTHER_PROJECT_MUST_NOT_LEAK/);
  const userRows = projectSessionEvents(await fixture.history('main'))
    .filter(row => row.kind === 'message' && row.role === 'user');
  assert.equal(userRows.length, 1);
  assert.equal(userRows[0]!.kind === 'message' ? userRows[0]!.text : undefined, 'context');
  const updatedRole = await fixture.runtime.request<RoleRecord>('personbot.v1.roles.put', {
    commandId: randomUUID(), roleId: role.id, name: role.name, expectedRevision: role.revision,
    instructions: 'ROLE_FIXTURE_V2: newly created Sessions use this revision.',
  });
  const frozen = await fixture.context('main');
  assert.match(frozen, /ROLE_FIXTURE_V1/);
  assert.doesNotMatch(frozen, /ROLE_FIXTURE_V2/);
  const newer = await fixture.runtime.request<SessionSummary>('personbot.v1.sessions.create', {
    sessionId: 'newer', conversationId: 'conversation-newer', projectId: project.id, roleId: role.id,
  });
  assert.equal(newer.roleRevision, updatedRole.revision);
  assert.match(await fixture.context('newer'), /ROLE_FIXTURE_V2/);
  await fixture.say('main', `memory-propose ${JSON.stringify({
    scope: 'project', key: 'replyStyle', value: 'PROPOSED_MEMORY_MARKER: use short English replies.',
  })}`);
  const proposed = (await fixture.personal()).memories.find(memory => memory.key === 'replyStyle');
  assert.ok(proposed);
  assert.equal(proposed.status, 'proposed');
  assert.equal(proposed.source, 'agent');
  assert.equal(proposed.sourceSessionId, 'main');
  assert.equal(proposed.projectId, project.id);
  assert.doesNotMatch(await fixture.context('main'), /PROPOSED_MEMORY_MARKER/);
  const confirmed = await fixture.runtime.request<MemoryRecord>('personbot.v1.memory.control', {
    commandId: randomUUID(), memoryId: proposed.id, expectedRevision: proposed.revision, action: 'confirm',
  });
  assert.equal(confirmed.status, 'active');
  assert.match(await fixture.context('main'), /PROPOSED_MEMORY_MARKER/);
  const corrected = await fixture.runtime.request<MemoryRecord>('personbot.v1.memory.put', {
    commandId: randomUUID(), memoryId: 'corrected-style', scope: 'project', projectId: project.id,
    key: 'replyStyle', value: 'CORRECTED_MEMORY_MARKER: concise Chinese replies.',
  });
  const current = await fixture.context('main');
  assert.match(current, /CORRECTED_MEMORY_MARKER/);
  assert.doesNotMatch(current, /PROPOSED_MEMORY_MARKER/);
  const identity = randomUUID();
  await fixture.say('main', 'context', identity);
  const beforeRetry = await fixture.history('main');
  await fixture.runtime.request('personbot.v1.messages.submit', {
    commandId: `command-${identity}`, messageId: `message-${identity}`,
    sessionId: 'main', text: 'context', mode: 'followup',
  });
  const afterRetry = await fixture.history('main');
  assert.equal(afterRetry.filter(event => event.type === 'user/message' && event.data.id === `message-${identity}`).length, 1);
  assert.equal(afterRetry.filter(event => event.type === 'turn/start').length,
    beforeRetry.filter(event => event.type === 'turn/start').length);
  await fixture.close();
  fixture = await start();
  const restored = await fixture.context('main');
  assert.match(restored, /CORRECTED_MEMORY_MARKER/);
  assert.match(restored, /ROLE_FIXTURE_V1/);
  assert.doesNotMatch(restored, /PROPOSED_MEMORY_MARKER|ROLE_FIXTURE_V2/);
  assert.equal((await fixture.personal()).memories.find(memory => memory.id === confirmed.id)?.status, 'superseded');
  await fixture.runtime.request('personbot.v1.memory.control', {
    commandId: randomUUID(), memoryId: corrected.id, expectedRevision: corrected.revision, action: 'forget',
  });
  const forgotten = await fixture.context('main');
  assert.doesNotMatch(forgotten, /CORRECTED_MEMORY_MARKER|PROPOSED_MEMORY_MARKER/);
  assert.match(forgotten, /PERSONAL_MEMORY_MARKER|PROJECT_MEMORY_MARKER/);
  await fixture.close();
});

test('native task worktrees publish immutable approved artifacts and accept durable supplements in place', { timeout: 120_000 }, async t => {
  const { directory, home, start } = await fixtureSpace(t);
  const source = join(directory, 'git-project');
  await mkdir(source);
  const git = async (...args: string[]) => {
    const { stdout } = await promisify(execFile)('git', [
      '-c', `core.hooksPath=${devNull}`, '-c', 'user.name=Personbot Fixture',
      '-c', 'user.email=fixture@personbot.invalid', '-C', source, ...args,
    ], {
      env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull },
      encoding: 'utf8', timeout: 15_000, maxBuffer: 65_536,
    });
    return stdout.trim();
  };
  await git('init', '--initial-branch=fixture');
  await writeFile(join(source, 'README.md'), 'committed source\n');
  await git('add', '--', 'README.md');
  await git('commit', '-m', 'Fixture initial commit');
  await writeFile(join(source, 'README.md'), 'uncommitted source edit\n');
  await writeFile(join(source, 'private-draft.txt'), 'untouched draft\n');
  const initialStatus = await git('status', '--porcelain');
  let fixture = await start();
  const project = await fixture.runtime.request<ProjectRecord>('personbot.v1.projects.put', {
    commandId: randomUUID(), projectId: 'git-project', name: 'Git project', path: source, kind: 'git',
  });
  const role = await fixture.runtime.request<RoleRecord>('personbot.v1.roles.put', {
    commandId: randomUUID(), roleId: 'builder', name: 'Builder', instructions: 'BUILDER_ROLE_MARKER: preserve source edits.',
  });
  await fixture.runtime.request('personbot.v1.sessions.create', {
    sessionId: 'main', conversationId: 'conversation-main', projectId: project.id, roleId: role.id,
  });
  const tasks = await Promise.all([fixture.createTask('task-artifact'), fixture.createTask('task-artifact')]);
  for (const task of tasks) {
    const approval = await fixture.decision('approval', task.workerSessionId);
    assert.equal(task.workspace?.kind, 'git-worktree');
    assert.ok(task.workspace?.path);
    assert.notEqual(await realpath(task.workspace.path), project.path);
    assert.equal(await readFile(join(task.workspace.path, 'README.md'), 'utf8'), 'committed source\n');
    await assert.rejects(access(join(task.workspace.path, 'fixture-output.md')), { code: 'ENOENT' });
    await fixture.runtime.request('personbot.v1.approvals.resolve', {
      requestId: (approval.payload as { requestId: string }).requestId,
      generation: approval.generation, outcome: 'allowed-once',
    });
  }
  const reviewed = await Promise.all(tasks.map(task => fixture.settled(task.id)));
  assert.notEqual(reviewed[0]!.workspace?.path, reviewed[1]!.workspace?.path);
  const artifacts = await fixture.runtime.request<ArtifactSnapshot>('personbot.v1.artifacts.list', { sessionId: 'main' });
  assert.equal(artifacts.artifacts.length, 2);
  for (const task of reviewed) {
    assert.equal(task.roleId, role.id);
    assert.equal(task.projectId, project.id);
    assert.equal(task.report?.artifactIds?.length, 1);
    const artifact = artifacts.artifacts.find(row => row.id === task.report!.artifactIds![0]);
    assert.ok(artifact);
    assert.equal(artifact.taskId, task.id);
    assert.equal(artifact.executionId, task.currentExecutionId);
    assert.equal(artifact.sessionId, task.workerSessionId);
    assert.equal(artifact.originSessionId, 'main');
    assert.equal(artifact.projectId, project.id);
    const workerInputs = (await fixture.history(task.workerSessionId))
      .filter(event => event.type === 'user/message' && event.data.source?.kind === 'user');
    assert.match(JSON.stringify(workerInputs[0]?.data.content), /BUILDER_ROLE_MARKER/);
    const output = join(task.workspace!.path, 'fixture-output.md');
    const original = await readFile(output);
    await writeFile(output, 'later mutable worker output\n');
    let chunk = await fixture.runtime.request<ArtifactChunk>('personbot.v1.artifacts.read', { artifactId: artifact.id });
    assert.deepEqual(Buffer.from(chunk.dataBase64, 'base64'), original);
    await unlink(output);
    chunk = await fixture.runtime.request<ArtifactChunk>('personbot.v1.artifacts.read', { artifactId: artifact.id });
    assert.deepEqual(Buffer.from(chunk.dataBase64, 'base64'), original);
  }
  assert.equal(await git('status', '--porcelain'), initialStatus);
  assert.equal(await readFile(join(source, 'README.md'), 'utf8'), 'uncommitted source edit\n');
  assert.equal(await readFile(join(source, 'private-draft.txt'), 'utf8'), 'untouched draft\n');
  await assert.rejects(access(join(source, 'fixture-output.md')), { code: 'ENOENT' });
  const task = await fixture.createTask('task-supplement');
  const question = await fixture.decision('question', task.workerSessionId);
  const waiting = (await fixture.tasks()).tasks.find(row => row.id === task.id)!;
  assert.equal(waiting.stage, 'waiting_person');
  const supplement = 'SUPPLEMENT_MARKER: include a concise verification table.';
  const commandId = randomUUID();
  const params = {
    commandId, taskId: task.id, expectedRevision: waiting.revision, action: 'supplement', text: supplement,
  };
  const receipt = await fixture.runtime.request<TaskRecord>('personbot.v1.tasks.control', params);
  assert.deepEqual(await fixture.runtime.request('personbot.v1.tasks.control', params), receipt);
  await fixture.event(event => event.type === 'input.queued'
    && (event.payload as { commandId?: string }).commandId === `supplement-${commandId}`,
  'Supplement did not reach the same native worker inbox');
  await fixture.runtime.request('personbot.v1.questions.answer', {
    requestId: (question.payload as { requestId: string }).requestId,
    generation: question.generation, result: { answers: [{ id: 'format', selected: ['Markdown'] }] },
  });
  const completed = await fixture.settled(task.id);
  assert.equal(completed.workerSessionId, task.workerSessionId);
  assert.equal(completed.currentExecutionId, task.currentExecutionId);
  assert.match(completed.report?.summary ?? '', /SUPPLEMENT_MARKER/);
  assert.deepEqual(completed.messages?.map(message => message.text), [supplement]);
  assert.equal((await fixture.tasks()).executions.filter(execution => execution.taskId === task.id).length, 1);
  const supplementInputs = (await fixture.history(task.workerSessionId)).filter(event =>
    event.type === 'user/message' && JSON.stringify(event.data.content).includes('Additional authorized requirements'));
  assert.equal(supplementInputs.length, 1);
  await fixture.close();
  fixture = await start();
  const recovered = (await fixture.tasks()).tasks.find(row => row.id === task.id)!;
  assert.equal(recovered.stage, 'awaiting_review');
  assert.equal(recovered.stopState, 'confirmed');
  assert.equal(recovered.currentExecutionId, task.currentExecutionId);
  assert.deepEqual(recovered.messages, completed.messages);
  const restoredArtifact = await fixture.runtime.request<ArtifactChunk>('personbot.v1.artifacts.read', {
    artifactId: artifacts.artifacts[0]!.id,
  });
  assert.equal(Buffer.from(restoredArtifact.dataBase64, 'base64').toString(), 'approved by personbot task fixture\n');
  await fixture.close();
});
