export const PROTOCOL_VERSION = 1 as const;
export const EVENT_METHOD = 'personbot.v1.event' as const;
export const MAX_TEXT_LENGTH = 1_048_576;

export type RpcId = string | number;
export type ApprovalOutcome = 'allowed-once' | 'rejected';
export type InputMode = 'followup' | 'steer';

/** Product identities remain distinct from native runtime identities. */
export interface Conversation {
  id: string;
  assistantProfileId: string;
}

export interface Task {
  id: string;
  goal: string;
  lifecycle: 'open' | 'completed' | 'cancelled';
  stage:
    | 'queued'
    | 'working'
    | 'waiting_event'
    | 'waiting_person'
    | 'awaiting_review'
    | 'paused'
    | 'blocked'
    | 'failed';
}

export interface Execution {
  id: string;
  taskId: string;
  status: 'pending' | 'running' | 'stopping' | 'ended';
  outcome?: 'succeeded' | 'failed' | 'interrupted' | 'cancelled' | 'unknown';
}

/** Personal configuration belongs to the product rather than a native Agent. */
export interface ProjectRecord {
  id: string;
  name: string;
  path: string;
  kind: 'directory' | 'git';
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface RoleRecord {
  id: string;
  name: string;
  instructions: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryRecord {
  id: string;
  scope: 'personal' | 'project';
  projectId?: string;
  key: string;
  value: string;
  status: 'active' | 'proposed' | 'forgotten' | 'superseded';
  source: 'user' | 'agent';
  sourceSessionId?: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface PersonalSnapshot {
  projects: ProjectRecord[];
  roles: RoleRecord[];
  memories: MemoryRecord[];
}

/** Published artifacts refer to copied immutable bytes, never a live source path. */
export interface ArtifactRecord {
  id: string;
  name: string;
  mediaType: string;
  size: number;
  sha256: string;
  sessionId: string;
  originSessionId: string;
  taskId?: string;
  executionId?: string;
  projectId?: string;
  createdAt: string;
}

export interface ArtifactChunk {
  artifact: ArtifactRecord;
  offset: number;
  nextOffset: number;
  eof: boolean;
  dataBase64: string;
}

export interface ArtifactSnapshot {
  artifacts: ArtifactRecord[];
}

/** Workspaces isolate working files; they are not an operating system sandbox. */
export interface TaskWorkspace {
  kind: 'directory' | 'git-worktree';
  path: string;
  sourcePath: string;
  projectId: string;
}

/** Worker claims require a separate human acceptance before business completion. */
export interface TaskReport {
  outcome: 'review' | 'waiting_event' | 'blocked' | 'failed';
  summary: string;
  evidence: string[];
  wakeAt?: string;
  artifactIds?: string[];
}

export interface TaskRecord extends Task {
  originSessionId: string;
  workerSessionId: string;
  criteria: string[];
  context: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  currentExecutionId?: string;
  report?: TaskReport;
  wakeAt?: string;
  lastError?: string;
  stopState?: 'pending' | 'confirmed' | 'unknown';
  projectId?: string;
  roleId?: string;
  workspace?: TaskWorkspace;
  messages?: { id: string; text: string; createdAt: string; executionId?: string }[];
}

export interface ExecutionRecord extends Execution {
  sessionId: string;
  inputMessageId: string;
  createdAt: string;
  endedAt?: string;
  summary?: string;
  effectsUnknown?: boolean;
}

export interface TaskUpdate {
  id: string;
  taskId: string;
  sessionId: string;
  revision: number;
  text: string;
  createdAt: string;
  delivered: boolean;
}

export interface TaskSnapshot {
  tasks: TaskRecord[];
  executions: ExecutionRecord[];
  updates: TaskUpdate[];
}

/** Only an owner configures task authority; remote events supply context. Tokens are write-only. */
export interface SourceRecord {
  id: string;
  name: string;
  originSessionId: string;
  enabled: boolean;
  goal: string;
  criteria: string[];
  callbackUrl?: string;
  callbackMode: 'idempotent' | 'at-most-once';
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface SubscriptionRecord {
  id: string;
  sourceId: string;
  threadId: string;
  taskId: string;
  enabled: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/** Intervals use UTC instants; missed intervals coalesce instead of replaying a backlog. */
export interface ScheduleRecord {
  id: string;
  name: string;
  sourceId: string;
  threadId: string;
  text: string;
  nextRunAt?: string;
  intervalSeconds?: number;
  enabled: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface TriggerRecord {
  id: string;
  sourceId: string;
  eventId: string;
  threadId: string;
  text: string;
  receivedAt: string;
  status: 'pending' | 'delivered' | 'ignored' | 'failed';
  taskIds: string[];
  lastError?: string;
}

/** Sending with an uncertain remote result requires idempotency or an explicit human decision. */
export interface ChannelDeliveryRecord {
  id: string;
  sourceId: string;
  threadId: string;
  taskId: string;
  updateId: string;
  url: string;
  mode: 'idempotent' | 'at-most-once';
  state: 'pending' | 'sending' | 'delivered' | 'uncertain' | 'failed';
  attempts: number;
  nextAttemptAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  payload: Record<string, unknown>;
}

export interface IntegrationSnapshot {
  sources: SourceRecord[];
  subscriptions: SubscriptionRecord[];
  schedules: ScheduleRecord[];
  triggers: TriggerRecord[];
  deliveries: ChannelDeliveryRecord[];
}

export type TaskAction = 'pause' | 'resume' | 'cancel' | 'accept' | 'revise' | 'supplement';

export type SessionBinding =
  | { owner: 'conversation'; conversationId: string; nativeSessionId: string }
  | { owner: 'task'; taskId: string; nativeSessionId: string };

export interface QuestionAnswer {
  id: string;
  selected: string[];
  custom?: string;
}

export type QuestionResult =
  | { answers: QuestionAnswer[] }
  | { cancelled: true };

/** Every mutating input has a stable command identity independent of RPC retries. */
export interface CommandParamsMap {
  'personbot.v1.initialize': { protocolVersion: typeof PROTOCOL_VERSION };
  'personbot.v1.sessions.create': {
    sessionId: string;
    conversationId?: string;
    taskId?: string;
    cwd?: string;
    projectId?: string;
    roleId?: string;
  };
  'personbot.v1.sessions.resume': { sessionId: string };
  'personbot.v1.sessions.list': Record<string, never>;
  'personbot.v1.messages.submit': {
    commandId: string;
    sessionId: string;
    messageId: string;
    text: string;
    mode: InputMode;
  };
  'personbot.v1.sessions.stop': { commandId: string; sessionId: string };
  'personbot.v1.tasks.create': {
    commandId: string;
    taskId: string;
    originSessionId: string;
    goal: string;
    criteria: string[];
    context?: string;
  };
  'personbot.v1.tasks.list': { originSessionId?: string };
  'personbot.v1.tasks.control': {
    commandId: string;
    taskId: string;
    expectedRevision: number;
    action: TaskAction;
    text?: string;
  };
  'personbot.v1.integrations.snapshot': Record<string, never>;
  'personbot.v1.sources.put': {
    commandId: string; sourceId: string; name: string; originSessionId: string;
    enabled: boolean; goal: string; criteria: string[]; token?: string;
    callbackUrl?: string; callbackMode: SourceRecord['callbackMode']; expectedRevision?: number;
  };
  'personbot.v1.subscriptions.put': {
    commandId: string; subscriptionId: string; sourceId: string; threadId: string; taskId: string;
    enabled: boolean; expectedRevision?: number;
  };
  'personbot.v1.schedules.put': {
    commandId: string; scheduleId: string; name: string; sourceId: string; threadId: string; text: string;
    runAt: string; intervalSeconds?: number; enabled: boolean; expectedRevision?: number;
  };
  'personbot.v1.deliveries.control': {
    commandId: string; deliveryId: string; expectedState: 'uncertain' | 'failed';
    action: 'retry' | 'mark_delivered';
  };
  'personbot.v1.sources.ingest': {
    sourceId: string; token: string; eventId: string; threadId: string; text: string;
  };
  'personbot.v1.personal.snapshot': Record<string, never>;
  'personbot.v1.projects.put': {
    commandId: string; projectId: string; name: string; path: string;
    kind: ProjectRecord['kind']; expectedRevision?: number;
  };
  'personbot.v1.roles.put': {
    commandId: string; roleId: string; name: string; instructions: string; expectedRevision?: number;
  };
  'personbot.v1.memory.put': {
    commandId: string; memoryId: string; scope: MemoryRecord['scope']; projectId?: string;
    key: string; value: string; expectedRevision?: number;
  };
  'personbot.v1.memory.control': {
    commandId: string; memoryId: string; expectedRevision: number; action: 'confirm' | 'forget';
  };
  'personbot.v1.artifacts.list': { sessionId?: string; taskId?: string };
  'personbot.v1.artifacts.publish': {
    commandId: string; artifactId: string; sessionId: string; path: string; name?: string;
  };
  'personbot.v1.artifacts.read': { artifactId: string; offset?: number; limit?: number };
  'personbot.v1.approvals.resolve': {
    requestId: string;
    generation: string;
    outcome: ApprovalOutcome;
  };
  'personbot.v1.questions.answer': {
    requestId: string;
    generation: string;
    result: QuestionResult;
  };
  'personbot.v1.snapshots.get': { sessionId?: string; fromSeq?: number; limit?: number };
  'personbot.v1.shutdown': Record<string, never>;
}

export type Method = keyof CommandParamsMap;
export type Request<M extends Method = Method> = {
  [K in M]: {
    jsonrpc: '2.0';
    id: RpcId;
    method: K;
    params: CommandParamsMap[K];
  };
}[M];

export interface RpcErrorData {
  code: number;
  message: string;
  data?: unknown;
}

export type Response =
  | { jsonrpc: '2.0'; id: RpcId | null; result: unknown }
  | { jsonrpc: '2.0'; id: RpcId | null; error: RpcErrorData };

/** Event sequence numbers are scoped to one runtime generation, not durable log cursors. */
export interface RuntimeEvent {
  generation: string;
  eventSeq: number;
  type: string;
  sessionId?: string;
  nativeSeq?: number;
  payload?: unknown;
}

export interface EventNotification {
  jsonrpc: '2.0';
  method: typeof EVENT_METHOD;
  params: RuntimeEvent;
}

export class ProtocolError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    throw new ProtocolError(-32602, `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new ProtocolError(-32602, `${label} contains unsupported field: ${key}`);
    }
  }
}

function string(value: unknown, label: string, maxLength = 256): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > maxLength ||
    Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  ) {
    throw new ProtocolError(-32602, `${label} must be a non-empty string of at most ${maxLength} characters without control characters`);
  }
  return value;
}

function optionalString(params: Record<string, unknown>, key: string, maxLength = 256): void {
  if (params[key] !== undefined) string(params[key], key, maxLength);
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > MAX_TEXT_LENGTH || value.includes('\0')) {
    throw new ProtocolError(-32602, `${label} must be non-empty, contain no NUL and be at most ${MAX_TEXT_LENGTH} characters`);
  }
  return value;
}

function identity(params: Record<string, unknown>, ...fields: string[]): void {
  for (const field of fields) string(params[field], field);
}

function revision(params: Record<string, unknown>, required = false): void {
  if (params.expectedRevision === undefined && !required) return;
  if (!Number.isSafeInteger(params.expectedRevision) || Number(params.expectedRevision) < 1) {
    throw new ProtocolError(-32602, 'expectedRevision must be a positive safe integer');
  }
}

export function validateCallbackUrl(value: unknown): string {
  const input = string(value, 'callbackUrl', 2048);
  let url: URL;
  try { url = new URL(input); } catch { throw new ProtocolError(-32602, 'callbackUrl must be an absolute HTTP URL'); }
  if (/\s/.test(input) || input.includes('#') || url.username || url.password || url.hash || !['http:', 'https:'].includes(url.protocol)
    || url.protocol === 'http:' && !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) {
    throw new ProtocolError(-32602, 'callbackUrl requires HTTPS or loopback HTTP, without credentials or fragments');
  }
  return url.href;
}

function enabled(params: Record<string, unknown>): void {
  if (typeof params.enabled !== 'boolean') throw new ProtocolError(-32602, 'enabled must be boolean');
}

function sourceToken(value: unknown): void {
  if (typeof value !== 'string' || !/^[\x21-\x7e]{32,256}$/.test(value)) {
    throw new ProtocolError(-32602, 'token requires 32–256 non-whitespace ASCII characters');
  }
}

function boundedText(value: unknown, label: string, limit: number): void {
  text(value, label);
  if (new TextEncoder().encode(value as string).length > limit) throw new ProtocolError(-32602, `${label} exceeds ${limit} bytes`);
}

function questionResult(value: unknown): QuestionResult {
  const result = record(value, 'result');
  if ('cancelled' in result) {
    keys(result, ['cancelled'], 'result');
    if (result.cancelled !== true) throw new ProtocolError(-32602, 'result.cancelled must be true');
    return { cancelled: true };
  }
  keys(result, ['answers'], 'result');
  if (!Array.isArray(result.answers) || result.answers.length === 0 || result.answers.length > 100) {
    throw new ProtocolError(-32602, 'result.answers must contain between 1 and 100 answers');
  }
  const seen = new Set<string>();
  const answers = result.answers.map((value: unknown): QuestionAnswer => {
    const answer = record(value, 'answer');
    keys(answer, ['id', 'selected', 'custom'], 'answer');
    const id = string(answer.id, 'answer.id');
    if (seen.has(id)) throw new ProtocolError(-32602, 'answer ids must be unique');
    seen.add(id);
    if (!Array.isArray(answer.selected) || answer.selected.length > 100) {
      throw new ProtocolError(-32602, 'answer.selected must be an array of at most 100 strings');
    }
    const selected = answer.selected.map((item: unknown) => string(item, 'answer.selected', 16_384));
    if (new Set(selected).size !== selected.length) {
      throw new ProtocolError(-32602, 'selected options must be unique');
    }
    if (answer.custom !== undefined) {
      return { id, selected, custom: text(answer.custom, 'answer.custom') };
    }
    return { id, selected };
  });
  return { answers };
}

/** Validate untrusted wire requests before dispatching to runtime services. */
export function parseRequest(value: unknown): Request {
  let request: Record<string, unknown>;
  try {
    request = record(value, 'request');
    keys(request, ['jsonrpc', 'id', 'method', 'params'], 'request');
  } catch (error) {
    if (error instanceof ProtocolError) throw new ProtocolError(-32600, error.message);
    throw error;
  }
  if (
    request.jsonrpc !== '2.0' ||
    !(
      (typeof request.id === 'string' && request.id.length > 0 && request.id.length <= 256) ||
      (typeof request.id === 'number' && Number.isSafeInteger(request.id))
    ) ||
    typeof request.method !== 'string'
  ) {
    throw new ProtocolError(-32600, 'Expected a JSON-RPC 2.0 request with an id and method');
  }
  const params = { ...record(request.params === undefined ? {} : request.params, 'params') };
  switch (request.method) {
    case 'personbot.v1.initialize':
      keys(params, ['protocolVersion'], 'params');
      if (params.protocolVersion !== PROTOCOL_VERSION) {
        throw new ProtocolError(-32602, `protocolVersion must be ${PROTOCOL_VERSION}`);
      }
      break;
    case 'personbot.v1.sessions.create':
      keys(params, ['sessionId', 'conversationId', 'taskId', 'cwd', 'projectId', 'roleId'], 'params');
      identity(params, 'sessionId');
      optionalString(params, 'conversationId');
      optionalString(params, 'taskId');
      optionalString(params, 'cwd', 32_768);
      optionalString(params, 'projectId');
      optionalString(params, 'roleId');
      if (params.conversationId !== undefined && params.taskId !== undefined) {
        throw new ProtocolError(-32602, 'A Session may bind to a conversation or a task, not both');
      }
      break;
    case 'personbot.v1.sessions.resume':
      keys(params, ['sessionId'], 'params');
      identity(params, 'sessionId');
      break;
    case 'personbot.v1.sessions.list':
    case 'personbot.v1.personal.snapshot':
    case 'personbot.v1.integrations.snapshot':
    case 'personbot.v1.shutdown':
      keys(params, [], 'params');
      break;
    case 'personbot.v1.sources.put':
      keys(params, ['commandId', 'sourceId', 'name', 'originSessionId', 'enabled', 'goal', 'criteria', 'token', 'callbackUrl', 'callbackMode', 'expectedRevision'], 'params');
      identity(params, 'commandId', 'sourceId', 'name', 'originSessionId');
      enabled(params);
      revision(params);
      boundedText(params.goal, 'goal', 32_768);
      if (!Array.isArray(params.criteria) || !params.criteria.length || params.criteria.length > 20) throw new ProtocolError(-32602, 'criteria requires 1–20 entries');
      for (const criterion of params.criteria) boundedText(criterion, 'criterion', 4096);
      if (params.token !== undefined) sourceToken(params.token);
      if (params.callbackUrl !== undefined) validateCallbackUrl(params.callbackUrl);
      if (!['idempotent', 'at-most-once'].includes(String(params.callbackMode))) throw new ProtocolError(-32602, 'Invalid callbackMode');
      break;
    case 'personbot.v1.subscriptions.put':
      keys(params, ['commandId', 'subscriptionId', 'sourceId', 'threadId', 'taskId', 'enabled', 'expectedRevision'], 'params');
      identity(params, 'commandId', 'subscriptionId', 'sourceId', 'threadId', 'taskId');
      enabled(params);
      revision(params);
      break;
    case 'personbot.v1.schedules.put':
      keys(params, ['commandId', 'scheduleId', 'name', 'sourceId', 'threadId', 'text', 'runAt', 'intervalSeconds', 'enabled', 'expectedRevision'], 'params');
      identity(params, 'commandId', 'scheduleId', 'name', 'sourceId', 'threadId', 'runAt');
      enabled(params);
      revision(params);
      boundedText(params.text, 'text', 32_768);
      if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(String(params.runAt)) || !Number.isFinite(Date.parse(String(params.runAt)))) throw new ProtocolError(-32602, 'runAt must be an ISO timestamp with timezone');
      if (params.intervalSeconds !== undefined && (!Number.isSafeInteger(params.intervalSeconds) || Number(params.intervalSeconds) < 60 || Number(params.intervalSeconds) > 31_536_000)) throw new ProtocolError(-32602, 'intervalSeconds must be 60–31536000');
      break;
    case 'personbot.v1.deliveries.control':
      keys(params, ['commandId', 'deliveryId', 'expectedState', 'action'], 'params');
      identity(params, 'commandId', 'deliveryId');
      if (!['uncertain', 'failed'].includes(String(params.expectedState)) || !['retry', 'mark_delivered'].includes(String(params.action))) throw new ProtocolError(-32602, 'Invalid delivery resolution');
      break;
    case 'personbot.v1.sources.ingest':
      keys(params, ['sourceId', 'token', 'eventId', 'threadId', 'text'], 'params');
      identity(params, 'sourceId', 'eventId', 'threadId');
      sourceToken(params.token);
      boundedText(params.text, 'text', 32_768);
      break;
    case 'personbot.v1.messages.submit':
      keys(params, ['commandId', 'sessionId', 'messageId', 'text', 'mode'], 'params');
      identity(params, 'commandId', 'sessionId', 'messageId');
      text(params.text, 'text');
      if (params.mode !== 'followup' && params.mode !== 'steer') {
        throw new ProtocolError(-32602, 'mode must be followup or steer');
      }
      break;
    case 'personbot.v1.sessions.stop':
      keys(params, ['commandId', 'sessionId'], 'params');
      identity(params, 'commandId', 'sessionId');
      break;
    case 'personbot.v1.tasks.create':
      keys(params, ['commandId', 'taskId', 'originSessionId', 'goal', 'criteria', 'context'], 'params');
      identity(params, 'commandId', 'taskId', 'originSessionId');
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(String(params.taskId))) {
        throw new ProtocolError(-32602, 'taskId must contain at most 96 letters, digits, underscores or hyphens');
      }
      text(params.goal, 'goal');
      if (!Array.isArray(params.criteria) || !params.criteria.length || params.criteria.length > 20) {
        throw new ProtocolError(-32602, 'criteria must contain between 1 and 20 completion conditions');
      }
      params.criteria = params.criteria.map((item: unknown) => text(item, 'criterion'));
      if (params.context !== undefined) text(params.context, 'context');
      break;
    case 'personbot.v1.tasks.list':
      keys(params, ['originSessionId'], 'params');
      optionalString(params, 'originSessionId');
      break;
    case 'personbot.v1.tasks.control':
      keys(params, ['commandId', 'taskId', 'expectedRevision', 'action', 'text'], 'params');
      identity(params, 'commandId', 'taskId');
      revision(params, true);
      if (!['pause', 'resume', 'cancel', 'accept', 'revise', 'supplement'].includes(String(params.action))) {
        throw new ProtocolError(-32602, 'Unsupported task action');
      }
      if (params.text !== undefined) text(params.text, 'text');
      if (['revise', 'supplement'].includes(String(params.action)) && params.text === undefined) {
        throw new ProtocolError(-32602, `${params.action} requires text`);
      }
      break;
    case 'personbot.v1.projects.put':
      keys(params, ['commandId', 'projectId', 'name', 'path', 'kind', 'expectedRevision'], 'params');
      identity(params, 'commandId', 'projectId', 'name');
      string(params.path, 'path', 32_768);
      if (params.kind !== 'directory' && params.kind !== 'git') throw new ProtocolError(-32602, 'kind must be directory or git');
      revision(params);
      break;
    case 'personbot.v1.roles.put':
      keys(params, ['commandId', 'roleId', 'name', 'instructions', 'expectedRevision'], 'params');
      identity(params, 'commandId', 'roleId', 'name');
      text(params.instructions, 'instructions');
      revision(params);
      break;
    case 'personbot.v1.memory.put':
      keys(params, ['commandId', 'memoryId', 'scope', 'projectId', 'key', 'value', 'expectedRevision'], 'params');
      identity(params, 'commandId', 'memoryId', 'key');
      optionalString(params, 'projectId');
      if (params.scope !== 'personal' && params.scope !== 'project') throw new ProtocolError(-32602, 'scope must be personal or project');
      if ((params.scope === 'project') !== (params.projectId !== undefined)) throw new ProtocolError(-32602, 'Only project memory requires projectId');
      text(params.value, 'value');
      revision(params);
      break;
    case 'personbot.v1.memory.control':
      keys(params, ['commandId', 'memoryId', 'expectedRevision', 'action'], 'params');
      identity(params, 'commandId', 'memoryId');
      revision(params, true);
      if (params.action !== 'confirm' && params.action !== 'forget') throw new ProtocolError(-32602, 'action must be confirm or forget');
      break;
    case 'personbot.v1.artifacts.list':
      keys(params, ['sessionId', 'taskId'], 'params');
      optionalString(params, 'sessionId');
      optionalString(params, 'taskId');
      break;
    case 'personbot.v1.artifacts.publish':
      keys(params, ['commandId', 'artifactId', 'sessionId', 'path', 'name'], 'params');
      identity(params, 'commandId', 'artifactId', 'sessionId');
      string(params.path, 'path', 32_768);
      optionalString(params, 'name');
      break;
    case 'personbot.v1.artifacts.read':
      keys(params, ['artifactId', 'offset', 'limit'], 'params');
      identity(params, 'artifactId');
      if (params.offset !== undefined && (!Number.isSafeInteger(params.offset) || Number(params.offset) < 0)) {
        throw new ProtocolError(-32602, 'offset must be a non-negative safe integer');
      }
      if (params.limit !== undefined && (!Number.isSafeInteger(params.limit) || Number(params.limit) < 1 || Number(params.limit) > 524_288)) {
        throw new ProtocolError(-32602, 'limit must be between 1 and 524288');
      }
      break;
    case 'personbot.v1.approvals.resolve':
      keys(params, ['requestId', 'generation', 'outcome'], 'params');
      identity(params, 'requestId', 'generation');
      if (params.outcome !== 'allowed-once' && params.outcome !== 'rejected') {
        throw new ProtocolError(-32602, 'outcome must be allowed-once or rejected');
      }
      break;
    case 'personbot.v1.questions.answer':
      keys(params, ['requestId', 'generation', 'result'], 'params');
      identity(params, 'requestId', 'generation');
      params.result = questionResult(params.result);
      break;
    case 'personbot.v1.snapshots.get':
      keys(params, ['sessionId', 'fromSeq', 'limit'], 'params');
      optionalString(params, 'sessionId');
      if (params.fromSeq !== undefined && (!Number.isSafeInteger(params.fromSeq) || Number(params.fromSeq) < 0)) {
        throw new ProtocolError(-32602, 'fromSeq must be a non-negative safe integer');
      }
      if (params.limit !== undefined && (!Number.isSafeInteger(params.limit) || Number(params.limit) < 1 || Number(params.limit) > 1000)) {
        throw new ProtocolError(-32602, 'limit must be between 1 and 1000');
      }
      if (params.sessionId === undefined && (params.fromSeq !== undefined || params.limit !== undefined)) {
        throw new ProtocolError(-32602, 'Log pagination requires sessionId');
      }
      break;
    default:
      throw new ProtocolError(-32601, `Unsupported method: ${request.method}`);
  }
  return {
    jsonrpc: '2.0',
    id: request.id,
    method: request.method,
    params,
  } as Request;
}
