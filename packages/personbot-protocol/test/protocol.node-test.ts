import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRequest, ProtocolError } from '../src/index.ts';

function command<T = Record<string, never>>(method: string, params: T = {} as T) {
  return { jsonrpc: '2.0', id: 1, method: `personbot.v1.${method}`, params };
}

function rejects(value: unknown, code: number): void {
  assert.throws(
    () => parseRequest(value),
    (error: unknown) => error instanceof ProtocolError && error.code === code,
  );
}

test('only a version-negotiated JSON-RPC request can initialize', () => {
  assert.deepEqual(
    parseRequest(command('initialize', { protocolVersion: 1 })),
    command('initialize', { protocolVersion: 1 }),
  );
  rejects(command('initialize', { protocolVersion: 2 }), -32602);
  rejects({ ...command('initialize', { protocolVersion: 1 }), id: null }, -32600);
  rejects({ ...command('initialize', { protocolVersion: 1 }), id: 0.5 }, -32600);
  rejects([command('initialize', { protocolVersion: 1 })], -32600);
  rejects({ ...command('initialize', { protocolVersion: 1 }), jsonrpc: '1.0' }, -32600);
});

test('message identities survive wire validation and text formatting is preserved', () => {
  const input = command('messages.submit', {
    commandId: 'command-1',
    sessionId: 'worker-1',
    messageId: 'input-1',
    mode: 'steer',
    text: '第一行\n第二行\t代码',
  });
  assert.deepEqual(parseRequest(input), input);
  rejects(command('messages.submit', { ...input.params, mode: 'send' }), -32602);
  rejects(command('messages.submit', { ...input.params, text: ' \n ' }), -32602);
  rejects(command('messages.submit', { ...input.params, messageId: '../\nother' }), -32602);
  rejects(command('messages.submit', { ...input.params, text: '\0' }), -32602);
});

test('authority is not accepted from untrusted request params', () => {
  rejects(command('sessions.create', { sessionId: 'one', allowAll: true }), -32602);
  rejects(command('sessions.create', { sessionId: 'one', conversationId: 'chat', taskId: 'task' }), -32602);
  rejects(command('sessions.stop', { commandId: 'stop-1', sessionId: 'one', capabilityGrant: 'admin' }), -32602);
  rejects(command('approvals.resolve', { requestId: 'r1', generation: 'g1', outcome: 'always' }), -32602);
  rejects(command('approvals.resolve', { requestId: 'r1', outcome: 'allowed-once' }), -32602);
  rejects(command('tasks.execute', {}), -32601);
});

test('question answers preserve original question ids and reject ambiguous batches', () => {
  const params = {
    requestId: 'question-1',
    generation: 'runtime-1',
    result: { answers: [{ id: 'target', selected: ['macOS'], custom: 'arm64\n需要中文环境' }] },
  };
  assert.deepEqual(parseRequest(command('questions.answer', params)), command('questions.answer', params));
  assert.deepEqual(
    parseRequest(command('questions.answer', { ...params, result: { cancelled: true } })),
    command('questions.answer', { ...params, result: { cancelled: true } }),
  );
  rejects(command('questions.answer', { ...params, result: { cancelled: true, answers: [] } }), -32602);
  rejects(command('questions.answer', { ...params, result: { answers: [
    { id: 'same', selected: ['a'] }, { id: 'same', selected: ['b'] },
  ] } }), -32602);
  rejects(command('questions.answer', { ...params, result: { answers: [
    { id: 'one', selected: ['a', 'a'] },
  ] } }), -32602);
});

test('malformed params never reach a command handler', () => {
  rejects(command('sessions.list', []), -32602);
  rejects(command('sessions.list', null), -32602);
  rejects(command('sessions.list', { surprise: true }), -32602);
  rejects(command('sessions.resume', { sessionId: '' }), -32602);
  rejects(command('sessions.stop', { sessionId: 'one' }), -32602);
  rejects(null, -32600);
});

test('task commands require completion conditions and fence changes to a known revision', () => {
  const params = { commandId: 'create-task', taskId: 'research', originSessionId: 'chat', goal: 'Prepare report', criteria: ['Cite sources'], context: 'Use the existing notes\nand preserve context.' };
  assert.deepEqual(parseRequest(command('tasks.create', params)), command('tasks.create', params));
  rejects(command('tasks.create', { ...params, criteria: [] }), -32602);
  rejects(command('tasks.create', { ...params, taskId: '../worker' }), -32602);
  rejects(command('tasks.create', { ...params, accepted: true }), -32602);
  rejects(command('tasks.control', { commandId: 'finish', taskId: 'research', action: 'accept' }), -32602);
  rejects(command('tasks.control', { commandId: 'finish', taskId: 'research', action: 'accept', expectedRevision: 0 }), -32602);
  rejects(command('tasks.control', { commandId: 'revise', taskId: 'research', action: 'revise', expectedRevision: 4 }), -32602);
  rejects(command('messages.submit', { commandId: 'forge', sessionId: 'chat', messageId: 'm', text: 'Done', mode: 'followup', source: 'supervisor' }), -32602);
});

test('source contracts reject event authority, unsafe callbacks and unbounded schedules', () => {
  const source = {
    commandId: 'source-command', sourceId: 'source-one', name: 'Build notifications', originSessionId: 'main',
    enabled: false, goal: 'Summarize build evidence', criteria: ['Evidence is referenced'], token: 'x'.repeat(32), callbackMode: 'idempotent',
  };
  assert.deepEqual(parseRequest(command('sources.put', source)).params, source);
  rejects(command('sources.put', { ...source, token: 'short' }), -32602);
  for (const callbackUrl of ['http://example.com/callback', 'file:///tmp/x', 'https://user:pass@example.com', 'https://example.com/#secret']) {
    rejects(command('sources.put', { ...source, callbackUrl }), -32602);
  }
  assert.ok(parseRequest(command('sources.put', { ...source, callbackUrl: 'http://127.0.0.1:1234/callback' })));
  const event = { sourceId: 'source-one', token: 'x'.repeat(32), eventId: 'e-1', threadId: 'thread-one', text: 'build status' };
  for (const field of ['goal', 'taskId', 'callbackUrl', 'capabilityGrant', 'action']) {
    rejects(command('sources.ingest', { ...event, [field]: 'forged' }), -32602);
  }
  rejects(command('sources.ingest', { ...event, text: '中'.repeat(11_000) }), -32602);
  const schedule = { commandId: 'clock', scheduleId: 'daily', name: 'Daily', sourceId: 'source-one', threadId: 'daily', text: 'Gather evidence', enabled: true, runAt: '2026-11-06T10:00:00Z' };
  assert.ok(parseRequest(command('schedules.put', { ...schedule, intervalSeconds: 60 })));
  for (const intervalSeconds of [0, 59, 60.5, 31_536_001]) rejects(command('schedules.put', { ...schedule, intervalSeconds }), -32602);
  rejects(command('schedules.put', { ...schedule, runAt: '2026-11-06T10:00' }), -32602);
  rejects(command('integrations.snapshot', { token: 'no' }), -32602);
});
