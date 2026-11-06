// Adapted from DeepSeek Harness Team's MIT-licensed Super Agent durable effects and outbox design.
// Source: dsh-superagent-prototype, 8c32a9dc5d72c033816c6a8110b37f40cf94fba4; see THIRD_PARTY.md.
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  MAX_TEXT_LENGTH,
  type CommandParamsMap,
  type ExecutionRecord,
  type TaskRecord,
  type TaskReport,
  type TaskSnapshot,
  type TaskUpdate,
} from '../../personbot-protocol/src/index.ts';

export interface TaskEffect {
  id: string;
  kind: 'dispatch' | 'stop' | 'notify';
  taskId: string;
  executionId?: string;
  payload: Record<string, unknown>;
  state: 'pending' | 'done' | 'failed';
  attempts: number;
  lastError?: string;
}

interface EffectRow {
  id: string;
  kind: TaskEffect['kind'];
  taskId: string;
  executionId: string | null;
  payload: string;
  state: TaskEffect['state'];
  attempts: number;
  lastError: string | null;
}

export class SupervisorConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SupervisorConflictError';
  }
}

type CreateParams = CommandParamsMap['personbot.v1.tasks.create'];
type ControlParams = CommandParamsMap['personbot.v1.tasks.control'];
const EFFECT_COLUMNS = 'id, kind, task_id AS taskId, execution_id AS executionId, payload, state, attempts, last_error AS lastError';
const MAX_TASK_INPUT_BYTES = 1024 * 1024;
const STAGE_LABELS: Record<TaskRecord['stage'], string> = {
  queued: '已排队',
  working: '执行中',
  waiting_event: '等待事件',
  waiting_person: '等待你的决定',
  awaiting_review: '待验收',
  paused: '已暂停',
  blocked: '受阻',
  failed: '失败',
};

function requiredText(value: unknown, label: string, limit = MAX_TEXT_LENGTH): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || value.length > limit) {
    throw new TypeError(`${label} must be non-empty text of at most ${limit} characters without NUL`);
  }
}

function identity(value: unknown, label: string): asserts value is string {
  requiredText(value, label, 256);
  if (Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    throw new TypeError(`${label} must not contain control characters`);
  }
}

function json(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      return Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)));
    }
    return item;
  });
}

function iso(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new TypeError('wakeAt must be an ISO date');
  return new Date(time).toISOString();
}

function checkTaskInputSize(task: TaskRecord): void {
  if (Buffer.byteLength(json(task)) > MAX_TASK_INPUT_BYTES) {
    throw new SupervisorConflictError('Task context and supplements exceed the 1 MiB budget; publish large supporting material as an artifact');
  }
}

function checkedReport(value: TaskReport): TaskReport {
  if (!value || typeof value !== 'object' || !['review', 'waiting_event', 'blocked', 'failed'].includes(value.outcome)) {
    throw new TypeError('Unsupported worker report outcome');
  }
  requiredText(value.summary, 'report.summary', 65_536);
  if (!Array.isArray(value.evidence) || value.evidence.length > 80) throw new TypeError('report.evidence must contain at most 80 entries including artifact references');
  for (const item of value.evidence) requiredText(item, 'report.evidence', 65_536);
  if (value.outcome === 'review' && !value.evidence.length) throw new TypeError('Review requires completion evidence');
  if (value.artifactIds !== undefined && (!Array.isArray(value.artifactIds) || value.artifactIds.length > 40 ||
    value.artifactIds.some(id => typeof id !== 'string' || !id.trim()) || new Set(value.artifactIds).size !== value.artifactIds.length)) {
    throw new TypeError('artifactIds must contain at most 40 unique artifact identities');
  }
  if (value.wakeAt !== undefined && value.outcome !== 'waiting_event') throw new TypeError('Only waiting_event may specify wakeAt');
  const wakeAt = value.wakeAt === undefined ? undefined : iso(value.wakeAt);
  return {
    outcome: value.outcome,
    summary: value.summary,
    evidence: [...value.evidence],
    ...(wakeAt ? { wakeAt } : {}),
    ...(value.artifactIds ? { artifactIds: [...value.artifactIds] } : {}),
  };
}

function effectRow(row: EffectRow): TaskEffect {
  return {
    id: row.id,
    kind: row.kind,
    taskId: row.taskId,
    ...(row.executionId ? { executionId: row.executionId } : {}),
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    state: row.state,
    attempts: row.attempts,
    ...(row.lastError ? { lastError: row.lastError } : {}),
  };
}

export class SupervisorStore {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    try {
      if (path !== ':memory:') chmodSync(path, 0o600);
      this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;');
      const version = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
      if (version.user_version > 1) throw new Error(`Unsupported supervisor store version: ${version.user_version}`);
      this.atomic(() => this.db.exec(`
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY NOT NULL,
          data TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS executions (
          id TEXT PRIMARY KEY NOT NULL,
          task_id TEXT NOT NULL REFERENCES tasks(id),
          status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'stopping', 'ended')),
          data TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS one_active_execution ON executions(task_id) WHERE status <> 'ended';
        CREATE TABLE IF NOT EXISTS commands (
          id TEXT PRIMARY KEY NOT NULL,
          fingerprint TEXT NOT NULL,
          result TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS effects (
          id TEXT PRIMARY KEY NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('dispatch', 'stop', 'notify')),
          task_id TEXT NOT NULL REFERENCES tasks(id),
          execution_id TEXT REFERENCES executions(id),
          payload TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('pending', 'done', 'failed')),
          attempts INTEGER NOT NULL DEFAULT 0,
          last_error TEXT
        );
        CREATE INDEX IF NOT EXISTS effects_pending ON effects(state, kind);
        CREATE TABLE IF NOT EXISTS updates (
          id TEXT PRIMARY KEY NOT NULL,
          task_id TEXT NOT NULL REFERENCES tasks(id),
          session_id TEXT NOT NULL,
          data TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS reports (
          execution_id TEXT PRIMARY KEY NOT NULL REFERENCES executions(id),
          payload TEXT NOT NULL
        );
        PRAGMA user_version = 1;
      `));
    } catch (error) {
      this.db.close();
      this.closed = true;
      throw error;
    }
  }

  create(params: CreateParams, binding: Pick<TaskRecord, 'projectId' | 'roleId' | 'workspace'> = {}): TaskRecord {
    identity(params.commandId, 'commandId');
    identity(params.taskId, 'taskId');
    identity(params.originSessionId, 'originSessionId');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(params.taskId)) throw new TypeError('Invalid taskId');
    requiredText(params.goal, 'goal');
    if (!Array.isArray(params.criteria) || !params.criteria.length || params.criteria.length > 20) throw new TypeError('Task requires between 1 and 20 completion criteria');
    for (const criterion of params.criteria) requiredText(criterion, 'criterion');
    if (params.context !== undefined) requiredText(params.context, 'context');
    const normalized = { ...params, criteria: [...params.criteria], context: params.context ?? '' };
    return this.command(params.commandId, { method: 'create', ...normalized }, () => {
      if (this.getTask(params.taskId)) throw new SupervisorConflictError(`Task ${params.taskId} already exists`);
      const now = new Date().toISOString();
      const task: TaskRecord = {
        id: params.taskId,
        ...binding,
        goal: params.goal,
        criteria: normalized.criteria,
        context: normalized.context,
        originSessionId: params.originSessionId,
        workerSessionId: `worker-${params.taskId}`,
        lifecycle: 'open',
        stage: 'queued',
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      this.saveTask(task);
      this.allocate(task);
      checkTaskInputSize(task);
      this.saveTask(task);
      return task;
    });
  }

  control(params: ControlParams): TaskRecord {
    this.validateControlInput(params);
    return this.command(params.commandId, { method: 'control', ...params }, () => {
      const task = this.requireTask(params.taskId);
      const { execution } = this.validateControlState(task, params);
      if (params.action === 'supplement') {
        task.messages = [...task.messages ?? [], { id: params.commandId, text: params.text!, createdAt: new Date().toISOString(), executionId: execution!.id }];
        this.advance(task);
        checkTaskInputSize(task);
        this.saveTask(task);
        this.enqueue({
          id: `dispatch:supplement:${params.commandId}`, kind: 'dispatch', taskId: task.id,
          executionId: execution!.id,
          payload: { supplement: true, commandId: params.commandId, text: params.text },
        });
        return task;
      } else if (params.action === 'accept') {
        task.lifecycle = 'completed';
        this.saveExecution({ ...execution!, outcome: 'succeeded' });
      } else if (params.action === 'resume' || params.action === 'revise') {
        this.advance(task);
        this.allocate(task, params.text ?? 'Explicitly resume this task. Inspect the preserved history and existing effects before taking further action; do not blindly repeat operations.');
        this.saveTask(task);
        return task;
      } else {
        task.stage = 'paused';
        if (params.action === 'cancel') task.lifecycle = 'cancelled';
        task.stopState = 'pending';
        delete task.wakeAt;
        this.advance(task);
        if (execution) {
          this.saveExecution({ ...execution, status: 'stopping', outcome: undefined, endedAt: undefined });
          this.enqueue({
            id: `stop:${execution.id}:${task.revision}`,
            kind: 'stop',
            taskId: task.id,
            executionId: execution.id,
            payload: {},
          });
        }
        this.invalidateDispatches(task.id);
        this.saveTask(task);
        this.notify(task);
        return task;
      }
      this.advance(task);
      this.saveTask(task);
      this.notify(task);
      return task;
    });
  }

  controlReceipt(params: ControlParams): TaskRecord | undefined {
    this.validateControlInput(params);
    const previous = this.db.prepare('SELECT fingerprint, result FROM commands WHERE id = ?').get(params.commandId) as { fingerprint: string; result: string } | undefined;
    if (previous) {
      if (previous.fingerprint !== json({ method: 'control', ...params })) throw new SupervisorConflictError('Command ID already identifies a different operation');
      return JSON.parse(previous.result) as TaskRecord;
    }
    this.validateControlState(this.requireTask(params.taskId), params);
    return undefined;
  }

  eventReceipt(commandId: string, taskId: string, text: string): TaskRecord | undefined {
    identity(commandId, 'commandId');
    identity(taskId, 'taskId');
    requiredText(text, 'event context');
    const previous = this.db.prepare('SELECT fingerprint, result FROM commands WHERE id = ?').get(commandId) as { fingerprint: string; result: string } | undefined;
    if (!previous) return undefined;
    if (previous.fingerprint !== json({ method: 'external-event', taskId, text })) throw new SupervisorConflictError('Event command identifies different context');
    return JSON.parse(previous.result) as TaskRecord;
  }

  receiveEvent(commandId: string, taskId: string, text: string): TaskRecord | undefined {
    const replay = this.eventReceipt(commandId, taskId, text);
    if (replay) return replay;
    const current = this.requireTask(taskId);
    if (current.lifecycle !== 'open' || !['queued', 'working', 'waiting_person', 'waiting_event'].includes(current.stage)) return undefined;
    if (current.stage === 'waiting_event' && this.stopUnconfirmed(current)) return undefined;
    return this.command(commandId, { method: 'external-event', taskId, text }, () => {
      const task = this.requireTask(taskId);
      if (task.stage === 'waiting_event') {
        const execution = task.currentExecutionId ? this.getExecution(task.currentExecutionId) : undefined;
        if (execution && execution.status !== 'ended') throw new SupervisorConflictError('Waiting worker has not stopped');
        this.advance(task);
        this.allocate(task, text);
      } else {
        const execution = task.currentExecutionId ? this.getExecution(task.currentExecutionId) : undefined;
        if (!execution || !['pending', 'running'].includes(execution.status)) throw new SupervisorConflictError('Event requires an active execution');
        if ((task.messages?.length ?? 0) >= 100) throw new SupervisorConflictError('Task supplement limit reached');
        task.messages = [...task.messages ?? [], { id: commandId, text, createdAt: new Date().toISOString(), executionId: execution.id }];
        this.advance(task);
        this.enqueue({
          id: `dispatch:supplement:${commandId}`, kind: 'dispatch', taskId, executionId: execution.id,
          payload: { supplement: true, external: true, commandId, text },
        });
      }
      checkTaskInputSize(task);
      this.saveTask(task);
      return task;
    });
  }

  report(taskId: string, executionId: string, value: TaskReport): TaskRecord {
    const report = checkedReport(value);
    return this.atomic(() => {
      const task = this.requireTask(taskId);
      const execution = this.getExecution(executionId);
      const previous = this.db.prepare('SELECT payload FROM reports WHERE execution_id = ?').get(executionId) as { payload: string } | undefined;
      if (task.currentExecutionId !== executionId || execution?.taskId !== taskId) throw new SupervisorConflictError('Report belongs to a retired execution');
      if (previous) {
        if (previous.payload !== json(report)) throw new SupervisorConflictError('Execution already has a different final report');
        return task;
      }
      if (task.lifecycle !== 'open' || task.stage === 'paused' || !execution || !['pending', 'running'].includes(execution.status)) {
        throw new SupervisorConflictError('Execution cannot submit a report in its current state');
      }
      if (report.wakeAt && Date.parse(report.wakeAt) <= Date.now()) throw new TypeError('wakeAt must be in the future');
      task.stage = report.outcome === 'review' ? 'awaiting_review' : report.outcome;
      task.report = report;
      task.stopState = 'pending';
      delete task.lastError;
      if (report.wakeAt) task.wakeAt = report.wakeAt;
      else delete task.wakeAt;
      const outcome = report.outcome === 'failed' ? 'failed' : report.outcome === 'waiting_event' ? 'interrupted' : 'unknown';
      this.saveExecution({ ...execution, status: 'ended', outcome, endedAt: new Date().toISOString(), summary: report.summary });
      this.db.prepare('INSERT INTO reports(execution_id, payload) VALUES (?, ?)').run(executionId, json(report));
      this.enqueue({
        id: `seal:${execution.id}`,
        kind: 'stop',
        taskId,
        executionId,
        payload: { seal: true },
      });
      this.advance(task);
      this.saveTask(task);
      this.notify(task);
      return task;
    });
  }

  markDispatched(effectId: string): void {
    this.atomic(() => {
      const effect = this.getEffect(effectId);
      if (!effect || effect.kind !== 'dispatch' || effect.state !== 'pending') return;
      const task = this.requireTask(effect.taskId);
      const execution = effect.executionId ? this.getExecution(effect.executionId) : undefined;
      if (effect.payload.supplement !== true && task.lifecycle === 'open' && ['queued', 'waiting_person'].includes(task.stage) && task.currentExecutionId === effect.executionId && execution?.status === 'pending') {
        if (task.stage !== 'waiting_person') task.stage = 'working';
        this.saveExecution({ ...execution, status: 'running' });
        this.advance(task);
        this.saveTask(task);
      }
      this.settleEffect(effect.id, 'done');
    });
  }

  finishStop(effectId: string, confirmed: boolean, errors: string[]): void {
    this.atomic(() => {
      const effect = this.getEffect(effectId);
      if (!effect || effect.kind !== 'stop' || effect.state !== 'pending') return;
      const task = this.requireTask(effect.taskId);
      const execution = effect.executionId ? this.getExecution(effect.executionId) : undefined;
      const seal = effect.payload.seal === true;
      const latest = execution ? this.latestStopEffect(execution.id) : undefined;
      if (execution && (execution.status === 'stopping' || seal && execution.status === 'ended') &&
        task.currentExecutionId === execution.id && latest?.id === effect.id) {
        const failure = errors.join('; ') || 'Native worker stop could not be confirmed';
        const summary = confirmed ? execution.summary
          : execution.effectsUnknown && execution.summary
            ? `${execution.summary}\n${failure}`
            : failure;
        const outcome = !confirmed || execution.effectsUnknown
          ? 'unknown'
          : seal && task.lifecycle === 'open' && task.stage !== 'paused'
            ? execution.outcome
            : task.lifecycle === 'cancelled' ? 'cancelled' : 'interrupted';
        this.saveExecution({
          ...execution,
          status: 'ended',
          outcome,
          ...(!confirmed ? { effectsUnknown: true } : {}),
          endedAt: new Date().toISOString(),
          ...(summary ? { summary } : {}),
        });
        task.stopState = confirmed ? 'confirmed' : 'unknown';
        if (confirmed) delete task.lastError;
        else {
          task.lastError = summary;
          if (task.lifecycle === 'open' && task.stage !== 'paused') task.stage = 'blocked';
        }
        this.advance(task);
        this.saveTask(task);
        if (!confirmed) this.notify(task);
      }
      this.settleEffect(effect.id, confirmed ? 'done' : 'failed', errors.join('; ') || undefined);
    });
  }

  interrupt(taskId: string, executionId: string, summary: string): void {
    requiredText(summary, 'summary', 65_536);
    this.atomic(() => this.interruptInTransaction(taskId, executionId, summary));
  }

  setWaitingPerson(taskId: string, waiting: boolean): void {
    this.atomic(() => {
      const task = this.requireTask(taskId);
      const execution = task.currentExecutionId ? this.getExecution(task.currentExecutionId) : undefined;
      if (task.lifecycle !== 'open' || !execution || !['pending', 'running'].includes(execution.status)) return;
      if (!(waiting ? task.stage === 'working' || task.stage === 'queued' : task.stage === 'waiting_person')) return;
      task.stage = waiting ? 'waiting_person' : execution.status === 'pending' ? 'queued' : 'working';
      this.advance(task);
      this.saveTask(task);
    });
  }

  wakeDue(nowISO: string): void {
    const now = Date.parse(iso(nowISO));
    this.atomic(() => {
      for (const task of this.snapshot().tasks) {
        if (task.lifecycle !== 'open' || task.stage !== 'waiting_event' || !task.wakeAt || Date.parse(task.wakeAt) > now) continue;
        const execution = task.currentExecutionId ? this.getExecution(task.currentExecutionId) : undefined;
        if (execution && execution.status !== 'ended' || this.stopUnconfirmed(task)) continue;
        const wakeAt = task.wakeAt;
        this.advance(task);
        this.allocate(task, `The declared wait expired at ${wakeAt}. Continue from the preserved context and inspect existing effects before taking action.`);
        this.saveTask(task);
      }
    });
  }

  recover(): void {
    this.atomic(() => {
      const executions = this.db.prepare(`
        SELECT data FROM executions WHERE status = 'running' OR id IN (
          SELECT execution_id FROM effects WHERE kind = 'stop' AND state = 'pending'
        )
      `).all() as { data: string }[];
      for (const row of executions) {
        const execution = JSON.parse(row.data) as ExecutionRecord;
        const task = this.requireTask(execution.taskId);
        if (task.currentExecutionId !== execution.id) continue;
        const summary = 'Runtime restarted before native effects were confirmed stopped. External effects may be unknown; inspect history before explicit resume.';
        if (execution.status === 'running') {
          this.interruptInTransaction(execution.taskId, execution.id, summary);
          continue;
        }
        const stop = this.latestStopEffect(execution.id);
        if (execution.effectsUnknown || stop?.state !== 'pending' ||
          !(execution.status === 'stopping' || execution.status === 'ended' && stop.payload.seal === true)) continue;
        const preserved = execution.summary ? `${execution.summary}\n${summary}` : summary;
        this.saveExecution({ ...execution, outcome: 'unknown', effectsUnknown: true, summary: preserved });
        if (task.lifecycle === 'open' && task.stage !== 'paused') task.stage = 'blocked';
        task.lastError = preserved;
        delete task.wakeAt;
        this.invalidateDispatches(task.id);
        this.advance(task);
        this.saveTask(task);
        this.notify(task);
      }
    });
  }

  getTask(id: string): TaskRecord | undefined {
    const row = this.db.prepare('SELECT data FROM tasks WHERE id = ?').get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) as TaskRecord : undefined;
  }

  getExecution(id: string): ExecutionRecord | undefined {
    const row = this.db.prepare('SELECT data FROM executions WHERE id = ?').get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) as ExecutionRecord : undefined;
  }

  snapshot(originSessionId?: string): TaskSnapshot {
    const all = this.db.prepare('SELECT data FROM tasks ORDER BY rowid').all() as { data: string }[];
    const tasks = all.map(row => JSON.parse(row.data) as TaskRecord).filter(task => !originSessionId || task.originSessionId === originSessionId);
    const taskIds = new Set(tasks.map(task => task.id));
    const executions = (this.db.prepare('SELECT data FROM executions ORDER BY rowid').all() as { data: string }[])
      .map(row => JSON.parse(row.data) as ExecutionRecord).filter(execution => taskIds.has(execution.taskId));
    const updates = (this.db.prepare('SELECT data FROM updates ORDER BY rowid').all() as { data: string }[])
      .map(row => JSON.parse(row.data) as TaskUpdate).filter(update => taskIds.has(update.taskId));
    return { tasks, executions, updates };
  }

  pendingEffects(): TaskEffect[] {
    const rows = this.db.prepare(`SELECT ${EFFECT_COLUMNS} FROM effects WHERE state = 'pending' ORDER BY CASE kind WHEN 'stop' THEN 0 WHEN 'dispatch' THEN 1 ELSE 2 END, rowid`).all() as unknown as EffectRow[];
    return rows.map(effectRow);
  }

  getEffect(id: string): TaskEffect | undefined {
    const row = this.db.prepare(`SELECT ${EFFECT_COLUMNS} FROM effects WHERE id = ?`).get(id) as EffectRow | undefined;
    return row ? effectRow(row) : undefined;
  }

  markNotified(effectId: string): void {
    this.atomic(() => {
      const effect = this.getEffect(effectId);
      if (!effect || effect.kind !== 'notify' || effect.state !== 'pending') return;
      const row = this.db.prepare('SELECT data FROM updates WHERE id = ?').get(String(effect.payload.updateId)) as { data: string } | undefined;
      if (!row) throw new Error('Outbox receipt is missing');
      const update = JSON.parse(row.data) as TaskUpdate;
      update.delivered = true;
      this.db.prepare('UPDATE updates SET data = ? WHERE id = ?').run(json(update), update.id);
      this.settleEffect(effect.id, 'done');
    });
  }

  failEffect(effectId: string, error: string): void {
    this.db.prepare("UPDATE effects SET attempts = attempts + 1, last_error = ? WHERE id = ? AND state = 'pending'").run(error.slice(0, 4000), effectId);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private command(commandId: string, value: unknown, operation: () => TaskRecord): TaskRecord {
    const fingerprint = json(value);
    return this.atomic(() => {
      const previous = this.db.prepare('SELECT fingerprint, result FROM commands WHERE id = ?').get(commandId) as { fingerprint: string; result: string } | undefined;
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new SupervisorConflictError('Command ID already identifies a different operation');
        return JSON.parse(previous.result) as TaskRecord;
      }
      const result = operation();
      this.db.prepare('INSERT INTO commands(id, fingerprint, result) VALUES (?, ?, ?)').run(commandId, fingerprint, json(result));
      return result;
    });
  }

  private allocate(task: TaskRecord, feedback?: string): void {
    const now = new Date().toISOString();
    const id = `exec-${task.id}-${task.revision}`;
    const execution: ExecutionRecord = {
      id,
      taskId: task.id,
      sessionId: task.workerSessionId,
      inputMessageId: `${id}-input`,
      status: 'pending',
      createdAt: now,
    };
    this.saveExecution(execution);
    task.currentExecutionId = id;
    task.stage = 'queued';
    delete task.report;
    delete task.wakeAt;
    delete task.lastError;
    delete task.stopState;
    this.enqueue({
      id: `dispatch:${id}`,
      kind: 'dispatch',
      taskId: task.id,
      executionId: id,
      payload: { text: feedback ?? 'Start the authorized task and submit a structured report with completion evidence.' },
    });
  }

  private interruptInTransaction(taskId: string, executionId: string, summary: string): void {
    const task = this.requireTask(taskId);
    const execution = this.getExecution(executionId);
    if (task.currentExecutionId !== executionId || !execution || execution.status === 'ended' || execution.status === 'stopping') return;
    this.saveExecution({ ...execution, status: 'ended', outcome: 'unknown', effectsUnknown: true, endedAt: new Date().toISOString(), summary });
    if (task.lifecycle === 'open' && task.stage !== 'paused') task.stage = 'blocked';
    task.lastError = summary;
    delete task.wakeAt;
    this.invalidateDispatches(task.id);
    this.advance(task);
    this.saveTask(task);
    this.notify(task);
  }

  private requireTask(id: string): TaskRecord {
    const task = this.getTask(id);
    if (!task) throw new Error(`Unknown task: ${id}`);
    return task;
  }

  private validateControlInput(params: ControlParams): void {
    identity(params.commandId, 'commandId');
    identity(params.taskId, 'taskId');
    if (!Number.isSafeInteger(params.expectedRevision) || params.expectedRevision < 1) throw new TypeError('expectedRevision must be a positive integer');
    if (!['pause', 'resume', 'cancel', 'accept', 'revise', 'supplement'].includes(params.action)) throw new TypeError('Unsupported task action');
    if (params.text !== undefined) requiredText(params.text, 'text');
    if (['revise', 'supplement'].includes(params.action) && params.text === undefined) throw new TypeError('This action requires feedback');
  }

  private validateControlState(task: TaskRecord, params: ControlParams): { execution: ExecutionRecord | undefined; retryStop: boolean } {
    if (task.revision !== params.expectedRevision) throw new SupervisorConflictError('Task changed; refresh before applying this action');
    const retryStop = (params.action === 'pause' && task.stage === 'paused' || params.action === 'cancel' && task.lifecycle === 'cancelled') && this.latestStopState(task) === 'failed';
    if (task.lifecycle !== 'open' && !retryStop) throw new SupervisorConflictError('Task is already closed');
    const execution = task.currentExecutionId ? this.getExecution(task.currentExecutionId) : undefined;
    if (params.action === 'supplement') {
      if (!['queued', 'working', 'waiting_person'].includes(task.stage) || !execution || !['pending', 'running'].includes(execution.status)) {
        throw new SupervisorConflictError('Only an active task accepts a supplement');
      }
      if ((task.messages?.length ?? 0) >= 100) throw new SupervisorConflictError('Task supplement limit reached; pause and revise the task');
    } else if (params.action === 'accept') {
      if (task.stage !== 'awaiting_review' || !task.report?.evidence.length || !execution || execution.status !== 'ended') {
        throw new SupervisorConflictError('Only a reported task with evidence can be accepted');
      }
      if (this.stopUnconfirmed(task)) throw new SupervisorConflictError('Stop is unconfirmed; wait for native drain before accepting');
    } else if (params.action === 'resume' || params.action === 'revise') {
      const allowed = params.action === 'revise'
        ? task.stage === 'awaiting_review'
        : ['paused', 'blocked', 'failed', 'waiting_event'].includes(task.stage);
      if (!allowed) throw new SupervisorConflictError('Task cannot be resumed from its current state');
      if (execution && execution.status !== 'ended') throw new SupervisorConflictError('The previous execution has not stopped');
      if (this.stopUnconfirmed(task)) throw new SupervisorConflictError('Stop is unconfirmed; retry pause or cancel before resuming');
    } else if (task.stage === 'paused' && params.action === 'pause' && !retryStop) {
      throw new SupervisorConflictError('Task is already paused');
    }
    return { execution, retryStop };
  }

  private advance(task: TaskRecord): void {
    task.revision++;
    task.updatedAt = new Date().toISOString();
  }

  private saveTask(task: TaskRecord): void {
    this.db.prepare('INSERT INTO tasks(id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data').run(task.id, json(task));
  }

  private saveExecution(execution: ExecutionRecord): void {
    this.db.prepare('INSERT INTO executions(id, task_id, status, data) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data').run(
      execution.id, execution.taskId, execution.status, json(execution),
    );
  }

  private enqueue(effect: Omit<TaskEffect, 'state' | 'attempts'>): void {
    this.db.prepare('INSERT INTO effects(id, kind, task_id, execution_id, payload, state) VALUES (?, ?, ?, ?, ?, ?)').run(
      effect.id, effect.kind, effect.taskId, effect.executionId ?? null, json(effect.payload), 'pending',
    );
  }

  private notify(task: TaskRecord): void {
    const id = `task-update:${task.id}:${task.revision}`;
    const state = task.lifecycle === 'completed' ? '已验收完成' : task.lifecycle === 'cancelled' ? '已终止' : STAGE_LABELS[task.stage];
    const text = [
      `任务「${task.goal}」${state}。`,
      task.report?.summary,
      task.report?.evidence.length ? `证据：\n${task.report.evidence.map(item => `- ${item}`).join('\n')}` : '',
      task.lastError ? `需要核对：${task.lastError}` : '',
      task.wakeAt ? `计划唤醒：${task.wakeAt}` : '',
      task.stage === 'awaiting_review' && task.lifecycle === 'open' ? '请根据完成条件验收，或提出修改意见。' : '',
    ].filter(Boolean).join('\n\n');
    const update: TaskUpdate = {
      id,
      taskId: task.id,
      sessionId: task.originSessionId,
      revision: task.revision,
      text,
      createdAt: new Date().toISOString(),
      delivered: false,
    };
    this.db.prepare('INSERT INTO updates(id, task_id, session_id, data) VALUES (?, ?, ?, ?)').run(id, task.id, task.originSessionId, json(update));
    this.enqueue({
      id: `notify:${id}`,
      kind: 'notify',
      taskId: task.id,
      payload: { updateId: id, sessionId: task.originSessionId, text },
    });
  }

  private stopUnconfirmed(task: TaskRecord): boolean {
    const state = this.latestStopState(task);
    return state !== undefined && state !== 'done';
  }

  private latestStopState(task: TaskRecord): TaskEffect['state'] | undefined {
    if (!task.currentExecutionId) return undefined;
    return this.latestStopEffect(task.currentExecutionId)?.state;
  }

  private latestStopEffect(executionId: string): TaskEffect | undefined {
    const row = this.db.prepare(`SELECT ${EFFECT_COLUMNS} FROM effects WHERE kind = 'stop' AND execution_id = ? ORDER BY rowid DESC LIMIT 1`).get(executionId) as unknown as EffectRow | undefined;
    return row ? effectRow(row) : undefined;
  }

  private invalidateDispatches(taskId: string): void {
    this.db.prepare("UPDATE effects SET state = 'done' WHERE task_id = ? AND kind = 'dispatch' AND state = 'pending'").run(taskId);
  }

  private settleEffect(id: string, state: TaskEffect['state'], error?: string): void {
    this.db.prepare("UPDATE effects SET state = ?, last_error = ? WHERE id = ? AND state = 'pending'").run(state, error ?? null, id);
  }

  private atomic<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = operation();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
