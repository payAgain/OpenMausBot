import { chmodSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  CommandParamsMap,
  MemoryRecord,
  PersonalSnapshot,
  ProjectRecord,
  RoleRecord,
} from '../../personbot-protocol/src/index.ts';
import { localGit } from './git.ts';

type ProjectParams = CommandParamsMap['personbot.v1.projects.put'];
type RoleParams = CommandParamsMap['personbot.v1.roles.put'];
type MemoryParams = CommandParamsMap['personbot.v1.memory.put'];
type MemoryControlParams = CommandParamsMap['personbot.v1.memory.control'];
type ProposalParams = Omit<MemoryParams, 'expectedRevision'> & { sourceSessionId: string };
const CONTEXT_LIMIT = 65_536;
const MEMORY_LIMIT = 40;

export class PersonalConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PersonalConflictError';
  }
}

function text(value: unknown, label: string, limit: number): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || value.length > limit) {
    throw new TypeError(`${label} must be non-empty text of at most ${limit} characters without NUL`);
  }
}

function identity(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(value)) {
    throw new TypeError(`Invalid ${label}`);
  }
}

function commandIdentity(value: unknown): asserts value is string {
  text(value, 'commandId', 256);
  if (controls(value)) throw new TypeError('commandId contains control characters');
}

function controls(value: string): boolean {
  return Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

function serialized(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
    : item);
}

function revision(expected: number | undefined, current?: { revision: number }): void {
  if (expected !== undefined && (!Number.isSafeInteger(expected) || expected < 1)) throw new TypeError('expectedRevision must be a positive integer');
  if (current ? current.revision !== expected : expected !== undefined) {
    throw new PersonalConflictError(current ? 'Record changed; refresh before saving' : 'Record does not exist');
  }
}

export class PersonalStore {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(home: string, defaults?: { workspace: string }) {
    if (!isAbsolute(home)) throw new TypeError('Personal home must be an absolute path');
    const directory = join(home, 'runtime');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, 'personal.sqlite');
    this.db = new DatabaseSync(path);
    try {
      chmodSync(path, 0o600);
      this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;');
      const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
      if (version > 1) throw new Error(`Unsupported personal store version: ${version}`);
      this.atomic(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS roles (id TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS memories (
            id TEXT PRIMARY KEY NOT NULL,
            scope TEXT NOT NULL CHECK (scope IN ('personal', 'project')),
            project_id TEXT NOT NULL,
            memory_key TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('active', 'proposed', 'forgotten', 'superseded')),
            proposal_epoch INTEGER,
            data TEXT NOT NULL
          );
          CREATE UNIQUE INDEX IF NOT EXISTS active_memory_key ON memories(scope, project_id, memory_key) WHERE status = 'active';
          CREATE TABLE IF NOT EXISTS memory_epochs (
            scope TEXT NOT NULL, project_id TEXT NOT NULL, memory_key TEXT NOT NULL, epoch INTEGER NOT NULL,
            PRIMARY KEY (scope, project_id, memory_key)
          );
          CREATE TABLE IF NOT EXISTS memory_history (
            id INTEGER PRIMARY KEY NOT NULL, memory_id TEXT NOT NULL REFERENCES memories(id), data TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY NOT NULL, fingerprint TEXT NOT NULL, result TEXT NOT NULL);
          PRAGMA user_version = 1;
        `);
        const now = new Date().toISOString();
        if (!this.getProject('default')) {
          const workspace = defaults?.workspace ?? process.cwd();
          if (!isAbsolute(workspace) || !statSync(workspace).isDirectory()) throw new TypeError('Default workspace must be an absolute directory');
          this.save('projects', {
            id: 'default', name: '默认项目', path: realpathSync(workspace), kind: 'directory',
            revision: 1, createdAt: now, updatedAt: now,
          } satisfies ProjectRecord);
        }
        if (!this.getRole('assistant')) this.save('roles', {
          id: 'assistant', name: '个人助手', instructions: 'Help the user with their authorized work. Keep their project context and preferences, ask when necessary, and report concrete results.',
          revision: 1, createdAt: now, updatedAt: now,
        } satisfies RoleRecord);
      });
    } catch (error) {
      this.db.close();
      this.closed = true;
      throw error;
    }
  }

  snapshot(): PersonalSnapshot {
    return {
      projects: this.rows<ProjectRecord>('projects'),
      roles: this.rows<RoleRecord>('roles'),
      memories: this.rows<MemoryRecord>('memories'),
    };
  }

  getProject(id: string): ProjectRecord | undefined {
    return this.record<ProjectRecord>('projects', id);
  }

  getRole(id: string): RoleRecord | undefined {
    return this.record<RoleRecord>('roles', id);
  }

  async putProject(params: ProjectParams): Promise<ProjectRecord> {
    commandIdentity(params.commandId);
    identity(params.projectId, 'projectId');
    text(params.name, 'name', 256);
    text(params.path, 'path', 8192);
    if (!isAbsolute(params.path) || !['directory', 'git'].includes(params.kind)) throw new TypeError('Project requires an absolute directory and supported kind');
    const fingerprint = serialized({ method: 'projects.put', ...params });
    const replay = this.receipt<ProjectRecord>(params.commandId, fingerprint);
    if (replay) return replay;
    const path = await realpath(params.path);
    if (!(await stat(path)).isDirectory()) throw new TypeError('Project path must be a directory');
    if (params.kind === 'git') {
      if (await realpath(await localGit(path, 'rev-parse', '--show-toplevel')) !== path) throw new TypeError('Git projects must select the repository root');
    }
    return this.command(params.commandId, fingerprint, () => {
      const previous = this.getProject(params.projectId);
      revision(params.expectedRevision, previous);
      const now = new Date().toISOString();
      const project: ProjectRecord = {
        id: params.projectId, name: params.name.trim(), path, kind: params.kind,
        revision: (previous?.revision ?? 0) + 1, createdAt: previous?.createdAt ?? now, updatedAt: now,
      };
      this.save('projects', project);
      return project;
    });
  }

  putRole(params: RoleParams): RoleRecord {
    commandIdentity(params.commandId);
    identity(params.roleId, 'roleId');
    text(params.name, 'name', 256);
    text(params.instructions, 'instructions', 32_768);
    return this.command(params.commandId, serialized({ method: 'roles.put', ...params }), () => {
      const previous = this.getRole(params.roleId);
      revision(params.expectedRevision, previous);
      const now = new Date().toISOString();
      const role: RoleRecord = {
        id: params.roleId, name: params.name.trim(), instructions: params.instructions,
        revision: (previous?.revision ?? 0) + 1, createdAt: previous?.createdAt ?? now, updatedAt: now,
      };
      this.save('roles', role);
      return role;
    });
  }

  putMemory(params: MemoryParams): MemoryRecord {
    this.validateMemory(params);
    return this.command(params.commandId, serialized({ method: 'memory.put', ...params }), () => {
      const previous = this.memory(params.memoryId);
      revision(params.expectedRevision, previous);
      const key = params.key.trim().normalize('NFC');
      if (previous && (previous.scope !== params.scope || previous.projectId !== params.projectId || previous.key !== key)) {
        throw new PersonalConflictError('A memory identity cannot change its scope or key');
      }
      const now = new Date().toISOString();
      const memory: MemoryRecord = {
        id: params.memoryId, scope: params.scope, ...(params.projectId ? { projectId: params.projectId } : {}),
        key, value: params.value, status: 'active', source: 'user',
        revision: (previous?.revision ?? 0) + 1, createdAt: previous?.createdAt ?? now, updatedAt: now,
      };
      this.supersede(memory);
      this.saveMemory(memory);
      this.advanceEpoch(memory);
      return memory;
    });
  }

  proposeMemory(params: ProposalParams): MemoryRecord {
    this.validateMemory(params);
    text(params.sourceSessionId, 'sourceSessionId', 256);
    if (controls(params.sourceSessionId)) throw new TypeError('sourceSessionId contains control characters');
    return this.command(params.commandId, serialized({ method: 'memory.propose', ...params }), () => {
      if (this.memory(params.memoryId)) throw new PersonalConflictError('Memory identity already exists');
      const now = new Date().toISOString();
      const memory: MemoryRecord = {
        id: params.memoryId, scope: params.scope, ...(params.projectId ? { projectId: params.projectId } : {}),
        key: params.key.trim().normalize('NFC'), value: params.value, status: 'proposed', source: 'agent',
        sourceSessionId: params.sourceSessionId, revision: 1, createdAt: now, updatedAt: now,
      };
      this.saveMemory(memory, this.epoch(memory));
      return memory;
    });
  }

  controlMemory(params: MemoryControlParams): MemoryRecord {
    commandIdentity(params.commandId);
    identity(params.memoryId, 'memoryId');
    if (!['confirm', 'forget'].includes(params.action)) throw new TypeError('Unsupported memory action');
    return this.command(params.commandId, serialized({ method: 'memory.control', ...params }), () => {
      const memory = this.memory(params.memoryId);
      if (!memory) throw new PersonalConflictError('Memory does not exist');
      revision(params.expectedRevision, memory);
      if (params.action === 'confirm') {
        if (memory.status !== 'proposed') throw new PersonalConflictError('Only a proposed memory can be confirmed');
        const row = this.db.prepare('SELECT proposal_epoch AS epoch FROM memories WHERE id = ?').get(memory.id) as { epoch: number };
        if (row.epoch !== this.epoch(memory)) throw new PersonalConflictError('Memory changed after this proposal; review a fresh proposal');
        this.supersede(memory);
        memory.status = 'active';
      } else {
        if (memory.status === 'forgotten' || memory.status === 'superseded') throw new PersonalConflictError('Memory is already inactive');
        if (memory.status === 'active') this.advanceEpoch(memory);
        memory.status = 'forgotten';
      }
      memory.revision++;
      memory.updatedAt = new Date().toISOString();
      this.saveMemory(memory);
      if (params.action === 'confirm') this.advanceEpoch(memory);
      return memory;
    });
  }

  context(projectId?: string): { memories: MemoryRecord[]; text: string } {
    const candidates = this.active(projectId);
    const memories: MemoryRecord[] = [];
    const entries: string[] = [];
    let size = 128;
    for (const memory of candidates) {
      const entry = serialized({ scope: memory.scope, ...(memory.projectId ? { projectId: memory.projectId } : {}), key: memory.key, value: memory.value });
      if (size + entry.length > CONTEXT_LIMIT) continue;
      memories.push(memory);
      entries.push(entry);
      size += entry.length + 1;
      if (memories.length >= MEMORY_LIMIT) break;
    }
    return { memories, text: entries.length ? `Remembered user context (personal and the bound project):\n${entries.join('\n')}` : '' };
  }

  search(query: string, projectId?: string, limit = 10): MemoryRecord[] {
    text(query, 'query', 512);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MEMORY_LIMIT) throw new TypeError(`Search limit must be between 1 and ${MEMORY_LIMIT}`);
    const terms = query.trim().toLocaleLowerCase().split(/\s+/);
    return this.active(projectId).filter(memory => {
      const value = `${memory.key}\n${memory.value}`.toLocaleLowerCase();
      return terms.every(term => value.includes(term));
    }).slice(0, limit);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private validateMemory(params: MemoryParams | ProposalParams): void {
    commandIdentity(params.commandId);
    identity(params.memoryId, 'memoryId');
    text(params.key, 'key', 256);
    text(params.value, 'value', 32_768);
    if (!['personal', 'project'].includes(params.scope)) throw new TypeError('Unsupported memory scope');
    if (params.scope === 'project') {
      identity(params.projectId, 'projectId');
      if (!this.getProject(params.projectId)) throw new PersonalConflictError('Memory project does not exist');
    } else if (params.projectId !== undefined) throw new TypeError('Personal memories cannot have a projectId');
  }

  private memory(id: string): MemoryRecord | undefined {
    return this.record<MemoryRecord>('memories', id);
  }

  private active(projectId?: string): MemoryRecord[] {
    if (projectId !== undefined && !this.getProject(projectId)) throw new PersonalConflictError('Unknown project');
    const rows = this.db.prepare(`
      SELECT data FROM memories WHERE status = 'active' AND (scope = 'personal' OR project_id = ?)
      ORDER BY rowid DESC
    `).all(projectId ?? '') as { data: string }[];
    return rows.map(row => JSON.parse(row.data) as MemoryRecord);
  }

  private supersede(memory: MemoryRecord): void {
    const row = this.db.prepare(`
      SELECT data FROM memories WHERE scope = ? AND project_id = ? AND memory_key = ? AND status = 'active' AND id <> ?
    `).get(memory.scope, memory.projectId ?? '', memory.key, memory.id) as { data: string } | undefined;
    if (!row) return;
    const prior = JSON.parse(row.data) as MemoryRecord;
    this.saveMemory({ ...prior, status: 'superseded', revision: prior.revision + 1, updatedAt: new Date().toISOString() });
  }

  private epoch(memory: MemoryRecord): number {
    const row = this.db.prepare('SELECT epoch FROM memory_epochs WHERE scope = ? AND project_id = ? AND memory_key = ?')
      .get(memory.scope, memory.projectId ?? '', memory.key) as { epoch: number } | undefined;
    return row?.epoch ?? 0;
  }

  private advanceEpoch(memory: MemoryRecord): void {
    this.db.prepare(`
      INSERT INTO memory_epochs(scope, project_id, memory_key, epoch) VALUES (?, ?, ?, 1)
      ON CONFLICT(scope, project_id, memory_key) DO UPDATE SET epoch = epoch + 1
    `).run(memory.scope, memory.projectId ?? '', memory.key);
  }

  private saveMemory(memory: MemoryRecord, proposalEpoch?: number): void {
    this.db.prepare(`
      INSERT INTO memories(id, scope, project_id, memory_key, status, proposal_epoch, data) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data
    `).run(memory.id, memory.scope, memory.projectId ?? '', memory.key, memory.status, proposalEpoch ?? null, serialized(memory));
    this.db.prepare('INSERT INTO memory_history(memory_id, data) VALUES (?, ?)').run(memory.id, serialized(memory));
  }

  private record<T>(table: 'projects' | 'roles' | 'memories', id: string): T | undefined {
    const row = this.db.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) as T : undefined;
  }

  private rows<T>(table: 'projects' | 'roles' | 'memories'): T[] {
    return (this.db.prepare(`SELECT data FROM ${table} ORDER BY rowid`).all() as { data: string }[]).map(row => JSON.parse(row.data) as T);
  }

  private save(table: 'projects' | 'roles', record: ProjectRecord | RoleRecord): void {
    this.db.prepare(`INSERT INTO ${table}(id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`).run(record.id, serialized(record));
  }

  private receipt<T>(id: string, fingerprint: string): T | undefined {
    const row = this.db.prepare('SELECT fingerprint, result FROM commands WHERE id = ?').get(id) as { fingerprint: string; result: string } | undefined;
    if (!row) return undefined;
    if (row.fingerprint !== fingerprint) throw new PersonalConflictError('Command ID identifies a different operation');
    return JSON.parse(row.result) as T;
  }

  private command<T>(id: string, fingerprint: string, operation: () => T): T {
    return this.atomic(() => {
      const previous = this.receipt<T>(id, fingerprint);
      if (previous !== undefined) return previous;
      const result = operation();
      this.db.prepare('INSERT INTO commands(id, fingerprint, result) VALUES (?, ?, ?)').run(id, fingerprint, serialized(result));
      return result;
    });
  }

  private atomic<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
