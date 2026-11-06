import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import {
  createTranscriptState,
  projectSessionEvents,
  reconcileSnapshot,
  reduceRuntimeEvent,
  type MessageRow,
  type NativeSessionEvent,
  type PendingDecision,
  type RuntimeSnapshot,
  type SessionSummary,
  type ToolRow,
  type TranscriptState,
} from '../src/index.ts';

function native(seq: number, type: string, data: unknown): NativeSessionEvent {
  return { seq, time: 1_000 + seq, type, data };
}

function user(seq: number, id = `u${seq}`, source = 'user'): NativeSessionEvent {
  return native(seq, 'user/message', {
    role: 'user', id, source: { kind: source }, content: [{ type: 'text', text: `Prompt ${id}` }],
  });
}

function assistant(seq: number, text: string, extra: Record<string, unknown> = {}): NativeSessionEvent {
  return native(seq, 'assistant/message', {
    turn: 1, step: 1, stream: [],
    message: { id: `a${seq}`, role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model' } },
    ...extra,
  });
}

function summary(sessionId = 's1', status: SessionSummary['status'] = 'idle'): SessionSummary {
  return { sessionId, cwd: '/fixture', status, pendingStops: [] };
}

function snapshot(
  events: readonly NativeSessionEvent[],
  extra: Partial<RuntimeSnapshot> = {},
): RuntimeSnapshot {
  return {
    generation: 'g1',
    eventSeq: 1,
    sessions: [summary()],
    logs: [{ sessionId: 's1', events, nextSeq: events.length, hasMore: false }],
    pending: [],
    ...extra,
  };
}

function send(state: TranscriptState, type: string, payload: unknown, sessionId = 's1'): TranscriptState {
  return reduceRuntimeEvent(state, {
    generation: state.generation ?? 'g1',
    eventSeq: state.eventSeq + 1,
    type,
    sessionId,
    payload,
  });
}

function append(state: TranscriptState, event: NativeSessionEvent): TranscriptState {
  return send(state, 'session.event', { event, durable: false });
}

test('durable task results retain system attribution and reconcile once across overlapping pages', () => {
  const notice = native(0, 'user/message', {
    role: 'user', id: 'task-result-1',
    source: { kind: 'personbot-supervisor', form: 'notice', summary: 'Task ready for review' },
    content: [{ type: 'text', text: 'Task ready for review\nEvidence: fixture:verified' }],
  });
  const state = reconcileSnapshot(reconcileSnapshot(createTranscriptState(), snapshot([notice])), snapshot([notice]));
  assert.equal(state.sessions.s1!.rows.length, 1);
  assert.equal(state.sessions.s1!.rows[0]!.kind, 'notice');
  assert.equal((state.sessions.s1!.rows[0] as { message?: string }).message, 'Task ready for review\nEvidence: fixture:verified');
  assert.equal(state.sessions.s1!.rows.some(row => row.kind === 'message' && row.role === 'user'), false);
});

function startStream(state: TranscriptState, attemptId = 's1:1', revision = 1): TranscriptState {
  return send(state, 'session.stream', { type: 'start', attemptId, revision, turn: 1, step: 1 });
}

function chunk(
  state: TranscriptState,
  index: number,
  value: unknown,
  revision = index + 2,
  attemptId = 's1:1',
): TranscriptState {
  return send(state, 'session.stream', {
    type: 'chunk', attemptId, revision, index, time: 2_000 + index, chunk: value,
  });
}

function messages(state: TranscriptState): readonly MessageRow[] {
  return state.sessions.s1.rows.filter((row): row is MessageRow => row.kind === 'message');
}

function tools(state: TranscriptState): readonly ToolRow[] {
  return state.sessions.s1.rows.filter((row): row is ToolRow => row.kind === 'tool');
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value)) freeze(nested);
    Object.freeze(value);
  }
  return value;
}

test('native user, assistant text, reasoning and attachments have distinct presentation data', () => {
  const rows = projectSessionEvents([
    native(0, 'turn/start', { turn: 1 }),
    user(1),
    assistant(2, '', {
      message: {
        id: 'answer', role: 'assistant', source: { kind: 'model' },
        content: [
          { type: 'reasoning', text: 'Think carefully.' },
          { type: 'text', text: 'Answer.' },
          { type: 'image', attachment: { id: 'image' }, offloaded: true },
          { type: 'vendor-block', opaque: { key: 'value' } },
        ],
      },
    }),
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].kind, 'message');
  const answer = rows[1] as MessageRow;
  assert.equal(answer.text, 'Answer.');
  assert.equal(answer.reasoning, 'Think carefully.');
  assert.equal(answer.blocks[2].type, 'attachment');
  assert.equal(answer.blocks[3].type, 'unsupported');
  assert.equal(answer.status, 'complete');
});

test('runtime context and system/developer events stay outside human chat while unknown events remain recoverable', () => {
  const events = [
    native(0, 'system/message', { message: { content: [{ type: 'text', text: 'Private system' }] } }),
    user(1, 'internal', 'runtime-context'),
    native(2, 'developer/message', { message: { content: [{ type: 'text', text: 'Tools' }] } }),
    native(3, 'vendor/future-event', { meaning: 'unknown' }),
    user(4, 'human'),
  ];
  const state = reconcileSnapshot(createTranscriptState(), snapshot(events));
  assert.equal(state.sessions.s1.events.length, 5);
  assert.equal(state.sessions.s1.rows.length, 1);
  assert.equal(messages(state)[0].text, 'Prompt human');
});

test('tool cards correlate assistant calls, execution and durable failure without duplicate rows', () => {
  const events = [
    assistant(0, '', {
      message: {
        id: 'tool-request',
        content: [
          { type: 'tool-call', id: 'call-a', name: 'shell', arguments: '{"command":"false"}' },
        ],
      },
    }),
    native(1, 'tool/call', { turn: 1, step: 1, callId: 'call-a', name: 'shell', arguments: '{"command":"false"}' }),
    native(2, 'tool/result', {
      turn: 1, step: 1,
      message: {
        id: 'result-a', role: 'tool', toolCallId: 'call-a', source: { kind: 'tool', callId: 'call-a' },
        isError: true, content: [{ type: 'text', text: 'Exit code 1' }],
      },
      error: { name: 'ShellFailure', code: 'EXIT', reason: 'Command exited unsuccessfully' },
      meta: { exitCode: 1 },
    }),
  ];
  const [row] = projectSessionEvents(events) as readonly ToolRow[];
  assert.equal(projectSessionEvents(events).length, 1);
  assert.equal(row.status, 'failed');
  assert.equal(row.resultText, 'Exit code 1');
  assert.equal(row.arguments, '{"command":"false"}');
  assert.deepEqual(row.error, { name: 'ShellFailure', code: 'EXIT', reason: 'Command exited unsuccessfully' });
  assert.deepEqual(row.meta, { exitCode: 1 });
});

test('tool result arriving in a later page is joined to its earlier native call after pages are reordered', () => {
  const call = native(0, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{"path":"README"}' });
  const result = native(1, 'tool/result', {
    turn: 1, step: 1,
    message: { toolCallId: 'c1', content: [{ type: 'text', text: 'Contents' }] },
  });
  let state = reconcileSnapshot(createTranscriptState(), snapshot([result], {
    logs: [{ sessionId: 's1', events: [result], nextSeq: 2, hasMore: false }],
  }));
  assert.equal(tools(state)[0].name, 'Unknown tool');
  assert.equal(state.sessions.s1.nextSeq, 0);
  assert.equal(state.sessions.s1.hasMore, true);
  state = reconcileSnapshot(state, snapshot([call], {
    logs: [{ sessionId: 's1', events: [call], nextSeq: 1, hasMore: true }],
  }));
  assert.equal(tools(state).length, 1);
  assert.equal(tools(state)[0].name, 'read');
  assert.equal(tools(state)[0].status, 'succeeded');
  assert.equal(state.sessions.s1.nextSeq, 2);
  assert.equal(state.sessions.s1.hasMore, false);
});

test('native seq de-duplicates live events, overlapping pages and repeated final messages', () => {
  const prompt = user(0);
  const answer = assistant(1, 'Single answer');
  let state = append(createTranscriptState(), prompt);
  state = append(state, answer);
  state = reconcileSnapshot(state, snapshot([prompt, answer], { eventSeq: state.eventSeq }));
  state = append(state, answer);
  state = append(state, assistant(1, 'Conflicting duplicate'));
  assert.equal(state.sessions.s1.events.length, 2);
  assert.equal(messages(state).length, 2);
  assert.equal(messages(state)[1].text, 'Single answer');
  assert.equal(state.sessions.s1.nextSeq, 2);
});

test('durable native events older than the transient live cursor still fill missing history', () => {
  let state = send(createTranscriptState(), 'session.status', { status: 'running' });
  state = reduceRuntimeEvent(state, {
    generation: 'g1', eventSeq: 100, type: 'session.status', sessionId: 's1', payload: { status: 'idle' },
  });
  state = reduceRuntimeEvent(state, {
    generation: 'g1', eventSeq: 2, type: 'session.event', sessionId: 's1', payload: { event: user(0) },
  });
  assert.equal(messages(state).length, 1);
  assert.equal(state.eventSeq, 100);
  assert.equal(state.sessions.s1.status, 'idle');
});

test('native cursors never skip gaps and projection output is ordered by native seq', () => {
  let state = append(createTranscriptState(), assistant(2, 'Third'));
  assert.equal(state.sessions.s1.nextSeq, 0);
  state = append(state, user(0));
  assert.equal(state.sessions.s1.nextSeq, 1);
  state = append(state, assistant(1, 'Second', { turn: 1, step: 0 }));
  assert.equal(state.sessions.s1.nextSeq, 3);
  assert.deepEqual(state.sessions.s1.events.map(event => event.seq), [0, 1, 2]);
  assert.deepEqual(messages(state).map(row => row.seq), [0, 1, 2]);
});

test('interrupted assistant prefixes and failed turns remain explicitly unfinished', () => {
  const rows = projectSessionEvents([
    assistant(0, 'Partial answer', { interrupted: true }),
    native(1, 'tool/call', { turn: 1, step: 1, callId: 'unfinished', name: 'shell', arguments: '{}' }),
    native(2, 'turn/end', { turn: 1, reason: { kind: 'interrupted' } }),
    native(3, 'turn/end', { turn: 2, reason: { kind: 'error', error: { message: 'Model unavailable', code: 'PROVIDER' } } }),
  ]);
  assert.equal((rows[0] as MessageRow).status, 'interrupted');
  assert.equal((rows[1] as ToolRow).status, 'interrupted');
  assert.deepEqual(rows.filter(row => row.kind === 'notice').map(row => [row.code, row.level, row.message]), [
    ['interrupted', 'warning', 'Turn interrupted before completion.'],
    ['error', 'error', 'Model unavailable'],
  ]);
});

test('a completed native turn adds no business task success message', () => {
  const rows = projectSessionEvents([
    user(0),
    assistant(1, 'Reply'),
    native(2, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows.some(row => row.kind === 'notice'), false);
});

test('streaming reasoning/text are provisional and durable assistant settlement replaces them once', () => {
  let state = append(createTranscriptState(), user(0));
  state = startStream(state);
  state = chunk(state, 0, { type: 'reasoning-delta', index: 0, text: 'Thinking' });
  state = chunk(state, 1, { type: 'text-delta', index: 1, text: 'Hel' });
  state = chunk(state, 2, { type: 'text-delta', index: 1, text: 'lo' });
  assert.equal(messages(state).length, 2);
  assert.equal(messages(state)[1].status, 'streaming');
  assert.equal(messages(state)[1].reasoning, 'Thinking');
  assert.equal(messages(state)[1].text, 'Hello');
  state = append(state, assistant(1, 'Hello', {
    message: { id: 'final', content: [{ type: 'reasoning', text: 'Thinking' }, { type: 'text', text: 'Hello' }] },
  }));
  state = send(state, 'session.stream', {
    type: 'end', attemptId: 's1:1', revision: 5, index: 3,
    outcome: { kind: 'committed', eventType: 'assistant/message', seq: 1 },
  });
  assert.equal(messages(state).length, 2);
  assert.equal(messages(state)[1].status, 'complete');
  assert.equal(state.sessions.s1.stream, undefined);
});

test('stream end before native snapshot settlement keeps a temporary settling prefix without duplicate final text', () => {
  let state = startStream(createTranscriptState());
  state = chunk(state, 0, { type: 'text-delta', index: 0, text: 'Done' });
  state = send(state, 'session.stream', {
    type: 'end', attemptId: 's1:1', revision: 3, index: 1,
    outcome: { kind: 'committed', eventType: 'assistant/message', seq: 0 },
  });
  assert.equal(messages(state)[0].status, 'settling');
  state = reconcileSnapshot(state, snapshot([assistant(0, 'Done')], {
    eventSeq: state.eventSeq,
    sessions: [summary('s1', 'running')],
  }));
  assert.equal(messages(state).length, 1);
  assert.equal(messages(state)[0].status, 'complete');
  assert.equal(state.sessions.s1.stream, undefined);
});

test('block-end is authoritative, duplicate chunks do not append text twice, and chunks follow frame index', () => {
  let state = startStream(createTranscriptState());
  state = chunk(state, 1, { type: 'text-delta', index: 0, text: 'lo' }, 3);
  state = chunk(state, 0, { type: 'text-delta', index: 0, text: 'Hel' }, 2);
  state = chunk(state, 1, { type: 'text-delta', index: 0, text: 'lo' }, 3);
  assert.equal(messages(state)[0].text, 'Hello');
  state = chunk(state, 2, { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello!' } }, 4);
  assert.equal(messages(state)[0].text, 'Hello!');
});

test('provisional tool arguments are replaced by one correlated native tool card', () => {
  let state = startStream(createTranscriptState());
  state = chunk(state, 0, { type: 'tool-call-delta', index: 0, id: 'c1', name: 'read', argumentsDelta: '{"p":' });
  state = chunk(state, 1, { type: 'tool-call-delta', index: 0, id: 'c1', argumentsDelta: '"a"}' });
  assert.equal(tools(state).length, 1);
  assert.equal(tools(state)[0].arguments, '{"p":"a"}');
  assert.equal(tools(state)[0].status, 'requested');
  state = append(state, assistant(0, '', {
    message: { id: 'tools', content: [{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{"p":"a"}' }] },
  }));
  state = append(state, native(1, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{"p":"a"}' }));
  assert.equal(tools(state).length, 1);
  assert.equal(tools(state)[0].status, 'running');
  assert.equal(state.sessions.s1.stream, undefined);
});

test('failed and abandoned attempts discard temporary output instead of becoming final chat', () => {
  for (const outcome of [
    { kind: 'committed', eventType: 'assistant/attempt', seq: 0 },
    { kind: 'abandoned' },
  ]) {
    let state = startStream(createTranscriptState());
    state = chunk(state, 0, { type: 'text-delta', index: 0, text: 'Failed draft' });
    state = send(state, 'session.stream', { type: 'end', attemptId: 's1:1', revision: 3, index: 1, outcome });
    assert.equal(messages(state).length, 0);
    assert.equal(state.sessions.s1.stream, undefined);
  }
});

test('a model retry at the same turn/step can stream after a durable assistant attempt', () => {
  let state = append(createTranscriptState(), native(0, 'assistant/attempt', {
    turn: 1, step: 1, stream: [{ time: 1000, chunk: { type: 'text-delta', index: 0, text: 'Failed' } }],
  }));
  state = startStream(state, 's1:2', 10);
  state = chunk(state, 0, { type: 'text-delta', index: 0, text: 'Retry' }, 11, 's1:2');
  assert.equal(messages(state).length, 1);
  assert.equal(messages(state)[0].text, 'Retry');
});

test('an earlier snapshot cannot erase newer stream tokens or resurrect closed decisions', () => {
  let state = send(createTranscriptState(), 'approval.requested', { requestId: 'approval', toolName: 'shell' });
  state = send(state, 'approval.closed', { requestId: 'approval' });
  state = startStream(state);
  state = chunk(state, 0, { type: 'text-delta', index: 0, text: 'Live' });
  state = reconcileSnapshot(state, snapshot([user(0)], {
    eventSeq: 1,
    pending: [{ kind: 'approval', requestId: 'approval', generation: 'g1', sessionId: 's1', toolName: 'shell' }],
  }));
  assert.equal(state.pending.length, 0);
  assert.equal(state.sessions.s1.status, 'running');
  assert.equal(messages(state).at(-1)?.text, 'Live');
  assert.equal(state.sessions.s1.events.length, 1);
});

test('session-scoped pending snapshots preserve other sessions and global snapshots replace all pending', () => {
  let state = send(createTranscriptState(), 'approval.requested', { requestId: 'a1', toolName: 'read' });
  state = send(state, 'approval.requested', { requestId: 'a2', toolName: 'shell' }, 's2');
  state = reconcileSnapshot(state, snapshot([], { eventSeq: state.eventSeq }));
  assert.deepEqual(state.pending.map(decision => decision.requestId), ['a2']);
  state = reconcileSnapshot(state, snapshot([], {
    eventSeq: state.eventSeq,
    logs: [],
    sessions: [summary(), summary('s2')],
  }));
  assert.equal(state.pending.length, 0);
});

test('root-scoped snapshots replace and close child decisions without duplicating them', () => {
  let state = send(createTranscriptState(), 'question.requested', {
    requestId: 'child-question',
    rootSessionId: 's1',
    questions: [{ id: 'q1', question: 'Continue?' }],
  }, 'child');
  const decision = state.pending[0];
  state = reconcileSnapshot(state, snapshot([], {
    eventSeq: state.eventSeq,
    pending: [decision],
  }));
  assert.equal(state.pending.length, 1);
  assert.equal(state.pending[0].requestId, 'child-question');
  state = reconcileSnapshot(state, snapshot([], { eventSeq: state.eventSeq, pending: [] }));
  assert.equal(state.pending.length, 0);
});

test('question choices, detail and presentation intent survive live and snapshot recovery', () => {
  const questions = [{
    id: 'q1', question: 'Choose a plan', detail: 'Plan body', header: 'Plan', multiSelect: false,
    options: [{ label: 'Proceed', description: 'Apply' }, { label: 'Revise' }],
    intent: { kind: 'plan-review', approve: 'Proceed' },
  }];
  let state = send(createTranscriptState(), 'question.requested', { requestId: 'q', questions });
  const decision = state.pending[0];
  assert.equal(decision.kind, 'question');
  if (decision.kind !== 'question') assert.fail('Expected question');
  assert.deepEqual(decision.questions, questions);
  state = reconcileSnapshot(createTranscriptState(), snapshot([], {
    pending: [decision as PendingDecision],
    eventSeq: state.eventSeq,
  }));
  assert.deepEqual(state.pending[0], decision);
  state = send(state, 'question.closed', { requestId: 'q' });
  assert.equal(state.pending.length, 0);
});

test('runtime generation change preserves native history and invalidates transient state and old decisions', () => {
  let state = append(createTranscriptState(), user(0));
  state = send(state, 'approval.requested', { requestId: 'old', toolName: 'shell' });
  state = startStream(state);
  state = chunk(state, 0, { type: 'text-delta', index: 0, text: 'Temporary' });
  state = reconcileSnapshot(state, snapshot([user(0)], { generation: 'g2', eventSeq: 1 }));
  assert.equal(state.generation, 'g2');
  assert.deepEqual(state.retiredGenerations, ['g1']);
  assert.equal(state.pending.length, 0);
  assert.equal(state.sessions.s1.stream, undefined);
  assert.equal(messages(state).length, 1);
  assert.equal(messages(state)[0].role, 'user');
  const afterOldEvent = reduceRuntimeEvent(state, {
    generation: 'g1', eventSeq: 999, type: 'approval.requested', sessionId: 's1',
    payload: { requestId: 'late-old', toolName: 'shell' },
  });
  assert.equal(afterOldEvent, state);
  assert.equal(reconcileSnapshot(state, snapshot([], { generation: 'g1', eventSeq: 1000 })), state);
});

test('reconnect reconstructs durable history without replaying temporary tokens as final messages', () => {
  const events = [
    user(0),
    assistant(1, 'Recorded prefix', { interrupted: true }),
    native(2, 'turn/end', { turn: 1, reason: { kind: 'interrupted' } }),
  ];
  const state = reconcileSnapshot(createTranscriptState(), snapshot(events, { generation: 'after-restart' }));
  assert.equal(state.sessions.s1.stream, undefined);
  assert.deepEqual(messages(state).map(row => [row.text, row.status]), [
    ['Prompt u0', 'complete'],
    ['Recorded prefix', 'interrupted'],
  ]);
  assert.equal(state.sessions.s1.rows.at(-1)?.kind, 'notice');
});

test('session errors clear provisional output and closed sessions mark unfinished tools interrupted', () => {
  let state = append(createTranscriptState(), native(0, 'tool/call', {
    turn: 1, step: 1, callId: 'c1', name: 'shell', arguments: '{}',
  }));
  state = startStream(state);
  state = chunk(state, 0, { type: 'text-delta', index: 0, text: 'Pending' });
  state = send(state, 'session.error', { message: 'Connection lost' });
  assert.equal(state.sessions.s1.error, 'Connection lost');
  assert.equal(state.sessions.s1.stream, undefined);
  state = send(state, 'session.stopped', { confirmed: true, errors: [] });
  assert.equal(state.sessions.s1.status, 'closed');
  assert.equal(tools(state)[0].status, 'interrupted');
});

test('reducers preserve deeply frozen state and wire data', () => {
  const initial = freeze(createTranscriptState());
  const first = append(initial, freeze(user(0)));
  const before = JSON.stringify(first);
  freeze(first);
  const second = reconcileSnapshot(first, freeze(snapshot([user(0), assistant(1, 'Next')], { eventSeq: first.eventSeq })));
  assert.equal(JSON.stringify(first), before);
  assert.equal(first.sessions.s1.events.length, 1);
  assert.equal(second.sessions.s1.events.length, 2);
  assert.equal(initial.generation, undefined);
});

test('native session identities cannot collide with object prototype keys', () => {
  for (const id of ['__proto__', 'constructor', 'toString']) {
    let state = send(createTranscriptState(), 'session.event', { event: user(0) }, id);
    state = reconcileSnapshot(state, snapshot([], { sessions: [summary(id)], logs: [] }));
    assert.equal(state.sessions[id].sessionId, id);
    assert.equal(state.sessions[id].events.length, 1);
    assert.equal(Object.getPrototypeOf(state.sessions), null);
  }
});

test('projection entrypoint bundles for browsers without Node or dsh runtime dependencies', async () => {
  const result = await build({
    entryPoints: [new URL('../src/index.ts', import.meta.url).pathname],
    bundle: true, platform: 'browser', format: 'esm', write: false, metafile: true,
  });
  const inputs = Object.keys(result.metafile?.inputs ?? {});
  assert.ok(inputs.length >= 2);
  assert.ok(inputs.every(path => path.includes('personbot-projection/src/')));
  assert.ok(!result.outputFiles[0].text.includes('node:'));
  assert.ok(!result.outputFiles[0].text.includes('@deepseek-ai'));
});
