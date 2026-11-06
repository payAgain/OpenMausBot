import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import type { SuperagentSnapshot, SuperagentUsage } from '../../../shared/superagent.ts';

export interface HostResourceOptions {
  directory: string;
  scope?: string;
  maxConcurrentCalls?: number;
  maxModelRequests?: number;
  tokenLimit?: number;
  costLimitUsd?: number;
}

interface LeaseRow {
  id: string;
  owner: string;
  parent_pid: number;
  child_pid: number;
  kind: string;
  resource: string;
  state: string;
  ordinal: number;
}

export interface WorkspaceQuarantine {
  id: string;
  workspace: string;
  reason: string;
  at: string;
}

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

function groupAlive(pid: number): boolean {
  if (process.platform === 'win32' || !Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(-pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

export function canonicalWorkspace(path: string, create = true): string {
  if (create) mkdirSync(path, { recursive: true });
  return realpathSync.native(resolve(path));
}

function writeScope(path: string): string {
  const canonical = canonicalWorkspace(path, false);
  try {
    const root = execFileSync('git', ['--no-optional-locks', '-C', canonical, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2_000,
    }).replace(/\r?\n$/, '');
    return root ? realpathSync.native(root) : canonical;
  } catch { return canonical; }
}

function overlaps(first: string, second: string): boolean {
  const contains = (parent: string, child: string) => {
    const path = relative(parent, child);
    return path === '' || !isAbsolute(path) && path !== '..' && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`);
  };
  return contains(first, second) || contains(second, first);
}

function initializeSqlite(run: () => void): void {
  const deadline = Date.now() + 5_000;
  const signal = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try { run(); return; }
    catch (error) {
      const sqlite = error as { errcode?: number; message?: string };
      if (Date.now() >= deadline || sqlite.errcode !== 5 && !/\bdatabase (?:is )?(?:locked|busy)\b/i.test(sqlite.message ?? '')) throw error;
      Atomics.wait(signal, 0, 0, 10);
    }
  }
}

/** A shared SQLite transaction admits calls and complete worker write windows across host processes. */
export class HostResources {
  private readonly db: DatabaseSync;
  private readonly instance: string;
  private readonly pending = new Map<string, AbortController>();
  private readonly options: HostResourceOptions;
  private closed = false;

  constructor(options: HostResourceOptions) {
    this.options = options;
    this.instance = `${options.scope ? `${options.scope}/` : ''}${randomUUID()}`;
    const max = options.maxConcurrentCalls ?? 4;
    if (!Number.isInteger(max) || max < 1 || max > 256) throw new TypeError('maxModelCalls must be between 1 and 256');
    for (const [name, value] of Object.entries({ maxModelRequests: options.maxModelRequests, tokenLimit: options.tokenLimit, costLimitUsd: options.costLimitUsd })) {
      if (value !== undefined && (!Number.isFinite(value) || value < 0)) throw new TypeError(`${name} must be a nonnegative finite number`);
    }
    mkdirSync(options.directory, { recursive: true, mode: 0o700 });
    const file = join(options.directory, 'host-resources.sqlite');
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db.exec('PRAGMA busy_timeout=5000');
    initializeSqlite(() => this.db.exec(`
      PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS lease (
        ordinal INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, owner TEXT NOT NULL,
        parent_pid INTEGER NOT NULL, child_pid INTEGER NOT NULL, kind TEXT NOT NULL,
        resource TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued'
      );
      CREATE TABLE IF NOT EXISTS usage (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, value TEXT NOT NULL, input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL, cost_usd REAL, at INTEGER NOT NULL, namespace TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS usage_projection(id TEXT NOT NULL,namespace TEXT NOT NULL,PRIMARY KEY(id,namespace));
      CREATE TABLE IF NOT EXISTS admitted (id TEXT PRIMARY KEY, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS policy (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS host_owner (id TEXT PRIMARY KEY,parent_pid INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS workspace_quarantine(id TEXT PRIMARY KEY,workspace TEXT NOT NULL UNIQUE,reason TEXT NOT NULL,at INTEGER NOT NULL);
    `));
    const policy = JSON.stringify({ maxConcurrentCalls: max, maxModelRequests: options.maxModelRequests ?? null, tokenLimit: options.tokenLimit ?? null, costLimitUsd: options.costLimitUsd ?? null });
    try {
      this.transaction(() => {
        if (!this.db.prepare("SELECT name FROM pragma_table_info('usage') WHERE name='namespace'").get()) this.db.exec("ALTER TABLE usage ADD COLUMN namespace TEXT NOT NULL DEFAULT ''");
        this.db.exec('CREATE INDEX IF NOT EXISTS usage_namespace ON usage(namespace)');
        this.cleanStale();
        const saved = this.db.prepare('SELECT value FROM policy WHERE id=1').get() as { value: string } | undefined;
        const owners = this.db.prepare('SELECT COUNT(*) AS n FROM host_owner').get() as { n: number };
        const leases = this.db.prepare("SELECT COUNT(*) AS n FROM lease WHERE state='active'").get() as { n: number };
        if (saved && saved.value !== policy && (owners.n || leases.n)) throw new Error('Host resource limits differ from the existing shared policy; stop every owning gateway before changing the policy.');
        this.db.prepare('INSERT INTO policy(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(policy);
        this.db.prepare('INSERT INTO host_owner(id,parent_pid) VALUES(?,?)').run(this.instance, process.pid);
      });
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  owner(bindingId: string, childId: string): string { return `${this.instance}/${bindingId}/${childId}`; }

  async acquire(kind: 'model' | 'workspace', leaseId: string, owner: string, childPid: number, workspace = ''): Promise<{ leaseId: string }> {
    if (this.closed) throw new Error('Host resources closed');
    if (!leaseId || leaseId.length > 512) throw new TypeError('Invalid host lease identity');
    const key = `${owner}/${leaseId}`;
    const controller = new AbortController();
    if (this.pending.has(key)) throw new Error('This resource lease is already queued');
    const resource = kind === 'workspace' ? writeScope(workspace) : 'model';
    if (kind === 'workspace') this.assertWorkspace(resource);
    this.db.prepare('INSERT INTO lease(id,owner,parent_pid,child_pid,kind,resource) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING')
      .run(key, owner, process.pid, childPid, kind, resource);
    this.pending.set(key, controller);
    try {
      for (;;) {
        controller.signal.throwIfAborted();
        if (this.closed) throw new Error('Host resources closed');
        const acquired = this.transaction(() => {
          this.cleanStale();
          const row = this.db.prepare('SELECT * FROM lease WHERE id=? AND owner=?').get(key, owner) as unknown as LeaseRow | undefined;
          if (!row) throw new Error('Host resource admission was cancelled');
          if (row.state === 'active') return true;
          if (kind === 'model') this.assertBudget();
          else this.assertWorkspace(resource);
          const candidates = this.db.prepare("SELECT * FROM lease WHERE kind=? AND id<>?").all(kind, key) as unknown as LeaseRow[];
          const conflicts = candidates.filter(candidate => kind === 'model' || overlaps(candidate.resource, resource));
          const ahead = conflicts.some(candidate => candidate.state === 'queued' && candidate.ordinal < row.ordinal);
          const running = conflicts.filter(candidate => candidate.state === 'active').length;
          const limit = kind === 'model' ? this.options.maxConcurrentCalls ?? 4 : 1;
          if (ahead || running >= limit) return false;
          this.db.prepare("UPDATE lease SET state='active' WHERE id=? AND owner=?").run(key, owner);
          if (kind === 'model') this.db.prepare('INSERT OR IGNORE INTO admitted(id,at) VALUES(?,?)').run(key, Date.now());
          return true;
        });
        if (acquired) return { leaseId };
        await delay(40, undefined, { signal: controller.signal });
      }
    } catch (error) {
      this.release(leaseId, owner);
      throw error;
    } finally { this.pending.delete(key); }
  }

  release(leaseId: string, owner: string): void {
    const key = `${owner}/${leaseId}`;
    this.pending.get(key)?.abort(new Error('Host resource admission cancelled'));
    if (!this.closed) this.db.prepare('DELETE FROM lease WHERE id=? AND owner=?').run(key, owner);
  }

  releaseOwner(owner: string): void {
    for (const [id, pending] of this.pending) if (id.startsWith(`${owner}/`)) pending.abort(new Error('The owning runtime exited'));
    if (!this.closed) this.db.prepare('DELETE FROM lease WHERE owner=?').run(owner);
  }

  quarantineOwner(owner: string, reason: string): void {
    if (this.closed) return;
    const leases = this.db.prepare("SELECT resource FROM lease WHERE owner=? AND kind='workspace' AND state='active'").all(owner) as { resource: string }[];
    for (const row of leases) {
      this.db.prepare('INSERT INTO workspace_quarantine(id,workspace,reason,at) VALUES(?,?,?,?) ON CONFLICT(workspace) DO NOTHING')
        .run(randomUUID(), row.resource, reason.slice(0, 2_000), Date.now());
    }
  }

  releaseWorkspace(id: string): boolean {
    if (!id || id.length > 512) return false;
    return Number(this.db.prepare('DELETE FROM workspace_quarantine WHERE id=?').run(id).changes) > 0;
  }

  hasLeases(owner: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM lease WHERE owner=? LIMIT 1').get(owner);
  }

  recordUsage(owner: string, usage: SuperagentUsage): boolean {
    for (const value of [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens ?? 0, usage.cacheWriteTokens ?? 0]) {
      if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Invalid native token usage');
    }
    if (usage.costUsd !== undefined && (!Number.isFinite(usage.costUsd) || usage.costUsd < 0)) throw new TypeError('Invalid native cost usage');
    if (!usage.usageId || usage.usageId.length > 512) throw new TypeError('Invalid native usage identity');
    if (!this.db.prepare('SELECT 1 FROM admitted WHERE id=?').get(`${owner}/${usage.usageId}`)) throw new Error('Usage must belong to an admitted native model call');
    return Number(this.db.prepare('INSERT OR IGNORE INTO usage(id,owner,value,input_tokens,output_tokens,cost_usd,at,namespace) VALUES(?,?,?,?,?,?,?,?)')
      .run(usage.usageId, owner, JSON.stringify(usage), usage.inputTokens, usage.outputTokens, usage.costUsd ?? null, Date.now(), this.options.scope ?? '').changes) > 0;
  }

  usageRecords(): Array<{ bindingId: string; usage: SuperagentUsage }> {
    const rows = this.db.prepare('SELECT owner,value FROM usage WHERE namespace=? AND NOT EXISTS(SELECT 1 FROM usage_projection WHERE id=usage.id AND namespace=usage.namespace)').all(this.options.scope ?? '');
    return (rows as { owner: string; value: string }[]).map(row => ({ bindingId: row.owner.split('/').at(-2)!, usage: JSON.parse(row.value) as SuperagentUsage }));
  }

  acknowledgeUsage(usageId: string): void {
    this.db.prepare('INSERT OR IGNORE INTO usage_projection(id,namespace) VALUES(?,?)').run(usageId, this.options.scope ?? '');
  }

  snapshot(): SuperagentSnapshot['resources'] & { admittedCalls: number; requestLimit?: number; unpricedCalls: number; unreportedCalls: number; quarantinedWorkspaces: WorkspaceQuarantine[] } {
    this.cleanStale();
    const total = this.db.prepare('SELECT COUNT(*) AS calls,COALESCE(SUM(input_tokens),0) AS input, COALESCE(SUM(output_tokens),0) AS output, SUM(cost_usd) AS cost, SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS unpriced FROM usage').get() as { calls: number; input: number; output: number; cost: number | null; unpriced: number | null };
    const counts = this.db.prepare("SELECT SUM(CASE WHEN state='active' THEN 1 ELSE 0 END) AS active, SUM(CASE WHEN state='queued' THEN 1 ELSE 0 END) AS queued FROM lease WHERE kind='model'").get() as { active: number | null; queued: number | null };
    const admitted = this.db.prepare('SELECT COUNT(*) AS n FROM admitted').get() as { n: number };
    const unreported = Math.max(0, admitted.n - total.calls - (counts.active ?? 0));
    return {
      activeCalls: counts.active ?? 0, queuedCalls: counts.queued ?? 0, maxConcurrentCalls: this.options.maxConcurrentCalls ?? 4,
      inputTokens: total.input, outputTokens: total.output, admittedCalls: admitted.n, unpricedCalls: (total.unpriced ?? 0) + unreported, unreportedCalls: unreported,
      quarantinedWorkspaces: (this.db.prepare('SELECT id,workspace,reason,at FROM workspace_quarantine ORDER BY at,id').all() as { id: string; workspace: string; reason: string; at: number }[])
        .map(row => ({ ...row, at: new Date(row.at).toISOString() })),
      ...(this.options.maxModelRequests === undefined ? {} : { requestLimit: this.options.maxModelRequests }),
      ...(this.options.tokenLimit === undefined ? {} : { tokenLimit: this.options.tokenLimit }),
      ...(total.cost === null ? {} : { costUsd: total.cost }),
      ...(this.options.costLimitUsd === undefined ? {} : { costLimitUsd: this.options.costLimitUsd }),
    };
  }

  close(preserveActive = false): void {
    if (this.closed) return;
    for (const pending of this.pending.values()) pending.abort(new Error('Host resources closed'));
    this.db.prepare(`DELETE FROM lease WHERE owner LIKE ?${preserveActive ? " AND state='queued'" : ''}`).run(`${this.instance}/%`);
    this.db.prepare('DELETE FROM host_owner WHERE id=?').run(this.instance);
    this.closed = true;
    this.db.close();
  }

  private assertBudget(): void {
    const totals = this.snapshot();
    if (this.options.maxModelRequests !== undefined && totals.admittedCalls >= this.options.maxModelRequests) throw new Error('Host model request budget reached; new model calls are paused.');
    if (this.options.tokenLimit !== undefined && totals.inputTokens + totals.outputTokens >= this.options.tokenLimit) throw new Error('Host token budget reached; new model calls are paused.');
    if (this.options.tokenLimit !== undefined && totals.unreportedCalls) throw new Error('Host token usage cannot be verified for unreported model calls; new model calls are paused.');
    if (this.options.costLimitUsd !== undefined && (totals.costUsd ?? 0) >= this.options.costLimitUsd) throw new Error('Host cost budget reached; new model calls are paused.');
    if (this.options.costLimitUsd !== undefined && totals.unpricedCalls) throw new Error('Host cost cannot be verified for unpriced model calls; new model calls are paused.');
  }

  private cleanStale(): void {
    const owners = this.db.prepare('SELECT DISTINCT owner,parent_pid,child_pid FROM lease').all() as unknown as Pick<LeaseRow, 'owner' | 'parent_pid' | 'child_pid'>[];
    for (const row of owners) {
      const parentDead = !alive(row.parent_pid);
      const childDead = !alive(row.child_pid);
      if (parentDead || childDead) this.quarantineOwner(row.owner, parentDead ? 'The host process ended while this workspace had an active write window; the owner must reconcile any surviving external work.' : 'The native runtime ended while this workspace had an active write window; the owner must reconcile any surviving external work.');
      if (childDead && !groupAlive(row.child_pid)) this.db.prepare('DELETE FROM lease WHERE owner=?').run(row.owner);
      else if (parentDead) this.db.prepare("DELETE FROM lease WHERE owner=? AND state='queued'").run(row.owner);
    }
    const hosts = this.db.prepare('SELECT id,parent_pid FROM host_owner').all() as { id: string; parent_pid: number }[];
    for (const row of hosts) if (!alive(row.parent_pid)) this.db.prepare('DELETE FROM host_owner WHERE id=?').run(row.id);
  }

  private assertWorkspace(workspace: string): void {
    const rows = this.db.prepare('SELECT id,workspace,reason FROM workspace_quarantine').all() as { id: string; workspace: string; reason: string }[];
    const quarantined = rows.find(row => overlaps(row.workspace, workspace));
    if (quarantined) throw new Error(`Workspace write admission is quarantined (${quarantined.id}): ${quarantined.reason}`);
  }

  private transaction<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = run(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
