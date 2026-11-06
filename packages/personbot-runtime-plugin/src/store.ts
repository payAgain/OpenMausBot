import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** A product-owned binding to one durable native Session. */
export interface SessionRow {
  sessionId: string;
  cwd: string;
  conversationId?: string;
  taskId?: string;
  projectId?: string;
  roleId?: string;
  roleRevision?: number;
  roleInstructions?: string;
  project?: { id: string; path: string; kind: 'directory' | 'git' };
}

export interface InputContext {
  text: string;
  roleId?: string;
  roleRevision?: number;
  memories: { id: string; revision: number }[];
}

export interface InputParams {
  commandId: string;
  sessionId: string;
  messageId: string;
  text: string;
  mode: 'followup' | 'steer';
  source?: 'supervisor';
}

/** Accepted rows await native delivery; queued confirms native persistence, not task completion. */
export interface InputRow extends InputParams {
  state: 'accepted' | 'queued' | 'cancelled';
}

export interface StopRow {
  commandId: string;
  sessionId: string;
  result?: { sessionId: string; confirmed: boolean; errors: string[] };
}

export class StoreConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreConflictError';
  }
}

const SESSION_COLUMNS = 'session_id AS sessionId, cwd, conversation_id AS conversationId, task_id AS taskId, binding';
const INPUT_COLUMNS = 'command_id AS commandId, session_id AS sessionId, message_id AS messageId, text, mode, state, source';

function inputRow(row: InputRow & { source?: 'supervisor' | null }): InputRow {
  const { source, ...rest } = row;
  return { ...rest, ...(source ? { source } : {}) };
}

interface StoredSession {
  sessionId: string;
  cwd: string;
  conversationId: string | null;
  taskId: string | null;
  binding: string | null;
}

function sessionRow(row: StoredSession): SessionRow {
  return {
    sessionId: row.sessionId,
    cwd: row.cwd,
    ...(row.conversationId === null ? {} : { conversationId: row.conversationId }),
    ...(row.taskId === null ? {} : { taskId: row.taskId }),
    ...(row.binding ? JSON.parse(row.binding) as Pick<SessionRow, 'projectId' | 'project' | 'roleId' | 'roleRevision' | 'roleInstructions'> : {}),
  };
}

function required(value: string, name: string): void {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new TypeError(`${name} must be a non-empty string without NUL`);
  }
}

/** Synchronous transactions cover business state only; native Session flushes occur outside this store. */
export class RuntimeStore {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    try {
      if (path !== ':memory:') chmodSync(path, 0o600);
      this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;');
      const version = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
      if (version.user_version > 5) throw new Error(`Unsupported runtime store version: ${version.user_version}`);
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS sessions (
            session_id TEXT PRIMARY KEY NOT NULL,
            cwd TEXT NOT NULL,
            conversation_id TEXT,
            task_id TEXT,
            CHECK (conversation_id IS NULL OR task_id IS NULL)
          );
          CREATE TABLE IF NOT EXISTS inputs (
            command_id TEXT PRIMARY KEY NOT NULL,
            session_id TEXT NOT NULL REFERENCES sessions(session_id),
            message_id TEXT NOT NULL,
            text TEXT NOT NULL,
            mode TEXT NOT NULL CHECK (mode IN ('followup', 'steer')),
            state TEXT NOT NULL CHECK (state IN ('accepted', 'queued', 'cancelled')),
            UNIQUE (session_id, message_id)
          );
          CREATE INDEX IF NOT EXISTS inputs_pending ON inputs (session_id, state);
          CREATE TABLE IF NOT EXISTS stops (
            command_id TEXT PRIMARY KEY NOT NULL,
            session_id TEXT NOT NULL REFERENCES sessions(session_id),
            result TEXT
          );
          CREATE TABLE IF NOT EXISTS native_sessions (
            session_id TEXT PRIMARY KEY NOT NULL REFERENCES sessions(session_id)
          );
          CREATE TABLE IF NOT EXISTS input_context (
            command_id TEXT PRIMARY KEY NOT NULL REFERENCES inputs(command_id),
            data TEXT NOT NULL
          );
        `);
        if (version.user_version < 4) this.db.exec("ALTER TABLE inputs ADD COLUMN source TEXT CHECK (source IS NULL OR source = 'supervisor')");
        if (version.user_version < 5) this.db.exec('ALTER TABLE sessions ADD COLUMN binding TEXT');
        this.db.exec('PRAGMA user_version = 5');
      });
    } catch (error) {
      this.db.close();
      this.closed = true;
      throw error;
    }
  }

  createSession(params: SessionRow): SessionRow {
    required(params.sessionId, 'sessionId');
    required(params.cwd, 'cwd');
    if (params.conversationId !== undefined) required(params.conversationId, 'conversationId');
    if (params.taskId !== undefined) required(params.taskId, 'taskId');
    if (params.conversationId !== undefined && params.taskId !== undefined) {
      throw new TypeError('A Session may bind to a conversation or a task, not both');
    }
    return this.transaction(() => {
      const existing = this.getSession(params.sessionId);
      if (existing) {
        if (
          existing.cwd !== params.cwd ||
          existing.conversationId !== params.conversationId ||
          existing.taskId !== params.taskId ||
          existing.projectId !== params.projectId ||
          existing.roleId !== params.roleId ||
          existing.roleRevision !== params.roleRevision ||
          existing.roleInstructions !== params.roleInstructions ||
          existing.project?.path !== params.project?.path ||
          existing.project?.kind !== params.project?.kind ||
          existing.project?.id !== params.project?.id
        ) {
          throw new StoreConflictError(`Session ${params.sessionId} already has a different binding`);
        }
        return existing;
      }
      const { projectId, project, roleId, roleRevision, roleInstructions } = params;
      this.db.prepare('INSERT INTO sessions (session_id, cwd, conversation_id, task_id, binding) VALUES (?, ?, ?, ?, ?)').run(
        params.sessionId, params.cwd, params.conversationId ?? null, params.taskId ?? null,
        JSON.stringify({ projectId, project, roleId, roleRevision, roleInstructions }),
      );
      return this.getSession(params.sessionId)!;
    });
  }

  getSession(sessionId: string): SessionRow | undefined {
    const row = this.db.prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE session_id = ?`).get(sessionId) as StoredSession | undefined;
    return row ? sessionRow(row) : undefined;
  }

  listSessions(): SessionRow[] {
    const rows = this.db.prepare(`SELECT ${SESSION_COLUMNS} FROM sessions ORDER BY rowid`).all() as unknown as StoredSession[];
    return rows.map(sessionRow);
  }

  beginInput(params: InputParams, context?: () => InputContext): InputRow {
    for (const key of ['commandId', 'sessionId', 'messageId', 'text'] as const) required(params[key], key);
    if (params.mode !== 'followup' && params.mode !== 'steer') throw new TypeError('mode must be followup or steer');
    return this.transaction(() => {
      const existing = this.getInput(params.commandId);
      if (existing) {
        if (
          existing.sessionId !== params.sessionId ||
          existing.messageId !== params.messageId ||
          existing.text !== params.text ||
          existing.mode !== params.mode ||
          existing.source !== params.source
        ) {
          throw new StoreConflictError(`Command ${params.commandId} already identifies a different input`);
        }
        if (context && existing.state === 'accepted') this.freezeContext(params.commandId, context);
        return existing;
      }
      if (this.getStop(params.commandId)) throw new StoreConflictError('Command already identifies a stop');
      if (this.pendingStops(params.sessionId).length) throw new StoreConflictError('Session has an unfinished stop; retry that stop command first');
      if (!this.getSession(params.sessionId)) throw new Error(`Unknown Session: ${params.sessionId}`);
      const sameMessage = this.db.prepare('SELECT command_id FROM inputs WHERE session_id = ? AND message_id = ?').get(params.sessionId, params.messageId);
      if (sameMessage) throw new StoreConflictError(`Message ${params.messageId} already identifies a different command in Session ${params.sessionId}`);
      this.db.prepare('INSERT INTO inputs (command_id, session_id, message_id, text, mode, state, source) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        params.commandId, params.sessionId, params.messageId, params.text, params.mode, 'accepted', params.source ?? null,
      );
      if (context) this.freezeContext(params.commandId, context);
      return this.getInput(params.commandId)!;
    });
  }

  getInput(commandId: string): InputRow | undefined {
    const row = this.db.prepare(`SELECT ${INPUT_COLUMNS} FROM inputs WHERE command_id = ?`).get(commandId) as InputRow | undefined;
    return row ? inputRow(row) : undefined;
  }

  inputContext(commandId: string, create: () => InputContext): InputContext {
    return this.transaction(() => this.freezeContext(commandId, create));
  }

  private freezeContext(commandId: string, create: () => InputContext): InputContext {
    const previous = this.db.prepare('SELECT data FROM input_context WHERE command_id = ?').get(commandId) as { data: string } | undefined;
    if (previous) return JSON.parse(previous.data) as InputContext;
    const value = create();
    this.db.prepare('INSERT INTO input_context(command_id, data) VALUES (?, ?)').run(commandId, JSON.stringify(value));
    return value;
  }

  pendingInputs(sessionId: string): InputRow[] {
    const rows = this.db.prepare(`SELECT ${INPUT_COLUMNS} FROM inputs WHERE session_id = ? AND state = 'accepted' ORDER BY rowid`).all(sessionId) as unknown as InputRow[];
    return rows.map(inputRow);
  }

  recoveryInputs(sessionId: string): InputRow[] {
    return (this.db.prepare(`SELECT ${INPUT_COLUMNS} FROM inputs WHERE session_id = ? AND state IN ('accepted', 'queued') ORDER BY rowid`)
      .all(sessionId) as unknown as InputRow[]).map(inputRow);
  }

  isNativeReady(sessionId: string): boolean {
    return !!this.db.prepare('SELECT session_id FROM native_sessions WHERE session_id = ?').get(sessionId);
  }

  markNativeReady(sessionId: string): void {
    this.db.prepare('INSERT OR IGNORE INTO native_sessions(session_id) VALUES (?)').run(sessionId);
  }

  markQueued(commandId: string): InputRow {
    return this.transaction(() => {
      const existing = this.getInput(commandId);
      if (!existing) throw new Error(`Unknown input command: ${commandId}`);
      if (existing.state === 'cancelled') throw new StoreConflictError(`Input ${commandId} was cancelled before native delivery`);
      if (existing.state === 'accepted') this.db.prepare("UPDATE inputs SET state = 'queued' WHERE command_id = ?").run(commandId);
      return { ...existing, state: 'queued' };
    });
  }

  cancelPending(sessionId: string): number {
    return Number(this.db.prepare("UPDATE inputs SET state = 'cancelled' WHERE session_id = ? AND state = 'accepted'").run(sessionId).changes);
  }

  cancelOutstanding(sessionId: string): void {
    this.db.prepare("UPDATE inputs SET state = 'cancelled' WHERE session_id = ? AND source IS NULL AND state IN ('accepted', 'queued')").run(sessionId);
  }

  requeueInputs(sessionId: string, messageIds: readonly string[]): void {
    this.transaction(() => {
      const update = this.db.prepare("UPDATE inputs SET state = 'accepted' WHERE session_id = ? AND message_id = ? AND state = 'queued'");
      for (const id of messageIds) update.run(sessionId, id);
    });
  }

  beginStop(commandId: string, sessionId: string): StopRow {
    return this.transaction(() => {
      if (this.getInput(commandId)) throw new StoreConflictError('Command already identifies an input');
      const previous = this.getStop(commandId);
      if (previous) {
        if (previous.sessionId !== sessionId) throw new StoreConflictError('Stop command identifies another Session');
        return previous;
      }
      if (this.pendingStops(sessionId).length) throw new StoreConflictError('Retry the unfinished stop command first');
      this.db.prepare('INSERT INTO stops(command_id, session_id) VALUES (?, ?)').run(commandId, sessionId);
      this.cancelOutstanding(sessionId);
      return { commandId, sessionId };
    });
  }

  getStop(commandId: string): StopRow | undefined {
    const row = this.db.prepare('SELECT command_id AS commandId, session_id AS sessionId, result FROM stops WHERE command_id = ?').get(commandId) as
      { commandId: string; sessionId: string; result: string | null } | undefined;
    return row ? { commandId: row.commandId, sessionId: row.sessionId, ...(row.result ? { result: JSON.parse(row.result) as StopRow['result'] } : {}) } : undefined;
  }

  pendingStops(sessionId: string): string[] {
    return (this.db.prepare('SELECT command_id FROM stops WHERE session_id = ? AND result IS NULL ORDER BY rowid').all(sessionId) as { command_id: string }[])
      .map(row => row.command_id);
  }

  finishStop(commandId: string, result: NonNullable<StopRow['result']>): void {
    if (!this.getStop(commandId)) throw new Error('Unknown stop command');
    this.db.prepare('UPDATE stops SET result = ? WHERE command_id = ? AND result IS NULL').run(JSON.stringify(result), commandId);
  }

  close(): void {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }

  private transaction<T>(operation: () => T): T {
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
