import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, rmdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SuperagentBinding, SuperagentCaller, SuperagentDecisionState, SuperagentDelivery, SuperagentEvent, SuperagentGateway, SuperagentInput, SuperagentInterrupt, SuperagentMemoryRequest, SuperagentSnapshot, SuperagentTaskState, SuperagentUsage } from '../../../shared/superagent.ts';
import { canonicalWorkspace, HostResources } from './host-resources.ts';
import { prepareLaunch } from './launch.ts';
import { Peer } from './rpc.ts';

export interface SuperagentGatewayOptions {
  home: string;
  workspace: string;
  provider: string;
  model: string;
  fixture?: boolean;
  /** Running conversation runtimes, including the tool-free upkeep runtime. */
  maxChildren?: number;
  resourceDirectory?: string;
  maxModelCalls?: number;
  maxModelRequests?: number;
  tokenLimit?: number;
  costLimitUsd?: number;
  recoveryIntervalMs?: number;
  onDiagnostic?: (text: string) => void;
  memory(request: SuperagentMemoryRequest): Promise<unknown>;
  /** Acknowledges only after the original product durably stores the source reply. */
  deliver?: (delivery: SuperagentDelivery) => Promise<void>;
  usage?: (event: SuperagentBinding & SuperagentUsage & { type: 'usage' }) => void | Promise<void>;
  onModelAdmission?: (caller: SuperagentBinding & Pick<SuperagentUsage, 'requestId' | 'agentId' | 'role' | 'ticketId'>) => void | Promise<void>;
  canRecover?: (binding: SuperagentBinding, input: SuperagentInput) => boolean;
  resolveLaunch?: () => Promise<{ provider?: string; model?: string; env?: NodeJS.ProcessEnv }>;
  onLaunch?: (configuration: { provider: string; model: string; env: NodeJS.ProcessEnv; binding?: SuperagentBinding; pid?: number }) => void | Promise<void>;
}

interface BindingRow { id: string; bot_id: string; thread_id: string; context_id: string; input: string; active: number; stop_pending: number; workspace: string; needs_recovery: number; activity: string; next_wake: number; failures: number }
interface RequestRow { request_id: string; source_message_id: string | null; text_hash: string; status: string; authorization_version: number; revoked: number; admitted: number; write_revoked: number; admission_revoked: number }
interface Child { process: ChildProcessWithoutNullStreams; peer: Peer; ready: Promise<void>; initialized: boolean; error: string; closing: boolean; fingerprint: string; busy: Set<string>; lastUsed: number; owner: string; masterId?: string; workspace: string; grouped: boolean; graceful: boolean; groupCleanup?: Promise<void> }
interface DecisionRow { binding_id: string; decision_id: string; request_id: string; owner: string; status: string; value: string }
interface Activity { tasks: number; pendingDeliveries: number; pendingDecisions: number }

const emptyActivity = (): Activity => ({ tasks: 0, pendingDeliveries: 0, pendingDecisions: 0 });
const endedStates = new Set(['completed', 'merged', 'closed', 'dropped', 'stopped']);

function bindingKey(binding: SuperagentBinding): string {
  return createHash('sha256').update(JSON.stringify([binding.botId, binding.threadId, binding.contextId ?? 'default'])).digest('hex');
}

class Gateway implements SuperagentGateway {
  private db?: DatabaseSync;
  private readonly children = new Map<string, Child>();
  private readonly listeners = new Set<(event: SuperagentEvent) => void>();
  private opening?: Promise<void>;
  private closing?: Promise<void>;
  private state = 'stopped';
  private error?: string;
  private childQueue: Promise<void> = Promise.resolve();
  private readonly retiring = new Set<Promise<void>>();
  private readonly retiringChildren = new Map<string, Promise<void>>();
  private readonly admissionEpoch = new Map<string, number>();
  private readonly threadEpoch = new Map<string, number>();
  private readonly pendingAdmissions = new Map<string, number>();
  private resources?: HostResources;
  private recoveryTimer?: ReturnType<typeof setTimeout>;
  private recovering = false;
  private retainedGroups = false;
  private readonly projectingUsage = new Map<string, Promise<void>>();

  private readonly options: SuperagentGatewayOptions;

  constructor(options: SuperagentGatewayOptions) {
    this.options = options;
    if (!isAbsolute(options.home) || !isAbsolute(options.workspace)) throw new TypeError('Super Agent home and workspace must be absolute');
  }

  start(): Promise<void> {
    if (this.closing) return Promise.reject(new Error('Super Agent gateway closed'));
    return this.opening ??= this.initialize();
  }

  private async initialize(): Promise<void> {
    this.state = 'starting';
    try {
      const directory = join(this.options.home, 'official-superagent');
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const file = join(directory, 'bindings.sqlite');
      this.db = new DatabaseSync(file);
      chmodSync(file, 0o600);
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS bindings (id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, thread_id TEXT NOT NULL, context_id TEXT NOT NULL, input TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, UNIQUE(bot_id, thread_id, context_id));');
      this.db.exec('CREATE TABLE IF NOT EXISTS requests (binding_id TEXT NOT NULL, request_id TEXT NOT NULL, source_message_id TEXT, text_hash TEXT NOT NULL, status TEXT NOT NULL DEFAULT \'active\', PRIMARY KEY(binding_id, request_id)); CREATE TABLE IF NOT EXISTS deliveries (binding_id TEXT NOT NULL, message_id TEXT NOT NULL, request_id TEXT NOT NULL, persisted INTEGER NOT NULL DEFAULT 0, suppressed INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(binding_id, message_id));');
      const columns: Record<string, Record<string, string>> = {
        bindings: { stop_pending: 'INTEGER NOT NULL DEFAULT 0', workspace: "TEXT NOT NULL DEFAULT ''", needs_recovery: 'INTEGER NOT NULL DEFAULT 0', activity: `TEXT NOT NULL DEFAULT '${JSON.stringify(emptyActivity())}'`, next_wake: 'INTEGER NOT NULL DEFAULT 0', failures: 'INTEGER NOT NULL DEFAULT 0' },
        requests: { authorization_version: 'INTEGER NOT NULL DEFAULT 1', revoked: 'INTEGER NOT NULL DEFAULT 0', admitted: 'INTEGER NOT NULL DEFAULT 1', write_revoked: 'INTEGER NOT NULL DEFAULT 0', admission_revoked: 'INTEGER NOT NULL DEFAULT 0' },
      };
      for (const [table, fields] of Object.entries(columns)) for (const [name, definition] of Object.entries(fields)) {
        if (!this.db.prepare(`SELECT name FROM pragma_table_info('${table}') WHERE name=?`).get(name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
      }
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS task_state(binding_id TEXT NOT NULL,ticket_id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(binding_id,ticket_id));
        CREATE TABLE IF NOT EXISTS decisions(binding_id TEXT NOT NULL,decision_id TEXT NOT NULL,request_id TEXT NOT NULL,owner TEXT NOT NULL,status TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(binding_id,decision_id));
        CREATE TABLE IF NOT EXISTS stopped_tickets(binding_id TEXT NOT NULL,ticket_id TEXT NOT NULL,PRIMARY KEY(binding_id,ticket_id));
        CREATE TABLE IF NOT EXISTS usage_events(id TEXT PRIMARY KEY,value TEXT NOT NULL,projected INTEGER NOT NULL DEFAULT 0);
        CREATE INDEX IF NOT EXISTS bindings_recovery ON bindings(active,needs_recovery,next_wake);
        CREATE INDEX IF NOT EXISTS usage_events_projection ON usage_events(projected);
      `);
      for (const row of this.db.prepare("SELECT * FROM bindings WHERE workspace=''").all() as unknown as BindingRow[]) {
        const input = JSON.parse(row.input) as SuperagentInput;
        let workspace = resolve(input.cwd ?? this.options.workspace);
        try { workspace = canonicalWorkspace(workspace, false); } catch {}
        this.db.prepare('UPDATE bindings SET workspace=? WHERE id=?').run(workspace, row.id);
      }
      this.db.prepare("UPDATE bindings SET needs_recovery=1 WHERE active=1 AND (stop_pending=1 OR EXISTS(SELECT 1 FROM requests WHERE binding_id=bindings.id AND status='active') OR EXISTS(SELECT 1 FROM deliveries WHERE binding_id=bindings.id AND persisted=0 AND suppressed=0))").run();
      this.db.prepare("UPDATE decisions SET status='expired',value=json_set(value,'$.status','expired') WHERE status='pending'").run();
      if (this.options.canRecover) {
        const existing = this.db.prepare('SELECT * FROM bindings WHERE active=1').all() as unknown as BindingRow[];
        this.fenceBindings(existing.filter(row => this.options.canRecover!(this.identity(row), JSON.parse(row.input) as SuperagentInput) === false));
      }
      this.resources = new HostResources({
        directory: this.options.resourceDirectory ?? (this.options.fixture ? join(this.options.home, 'host-resources') : join(homedir(), '.personbot-host')),
        scope: createHash('sha256').update(canonicalWorkspace(this.options.home)).digest('hex'),
        maxConcurrentCalls: this.options.maxModelCalls, maxModelRequests: this.options.maxModelRequests, tokenLimit: this.options.tokenLimit, costLimitUsd: this.options.costLimitUsd,
      });
      for (const { bindingId, usage } of this.resources.usageRecords()) {
        const binding = this.binding(bindingId);
        if (!binding && bindingId !== 'upkeep') continue;
        const event = { ...usage, ...(binding ? this.identity(binding) : { botId: '__superagent_upkeep__', threadId: '__superagent_upkeep__', contextId: 'upkeep' }), type: 'usage' as const };
        this.db.prepare('INSERT OR IGNORE INTO usage_events(id,value) VALUES(?,?)').run(usage.usageId, JSON.stringify(event));
      }
      this.state = 'ready';
      this.scheduleRecovery(0);
    } catch (error) { this.state = 'failed'; this.error = String(error); throw error; }
  }

  async submit(input: SuperagentInput): Promise<void> {
    if (!input.botId || !input.threadId || !input.requestId || typeof input.text !== 'string' || input.text.length > 1024 * 1024) throw new TypeError('Invalid Super Agent input');
    if (input.cwd && !isAbsolute(input.cwd)) throw new TypeError('Super Agent workspace must be absolute');
    const id = bindingKey(input);
    const epoch = this.admissionEpoch.get(id) ?? 0;
    const threadKey = JSON.stringify([input.botId, input.threadId]);
    const threadEpoch = this.threadEpoch.get(threadKey) ?? 0;
    await this.start();
    const previous = this.db!.prepare('SELECT * FROM bindings WHERE id = ?').get(id) as unknown as BindingRow | undefined;
    const priorInput = previous ? JSON.parse(previous.input) as SuperagentInput : undefined;
    const workspace = canonicalWorkspace(input.cwd ?? priorInput?.cwd ?? this.options.workspace, !previous);
    if (previous && previous.workspace !== workspace) throw new Error('A native context has a fixed working directory. Create a new workspace context before changing directories.');
    const merged = { ...input, cwd: workspace, instructions: input.instructions ?? priorInput?.instructions, approvalMode: input.approvalMode ?? priorInput?.approvalMode };
    const workspaceTransition = input.contextTransition === 'workspace' && input.previousContextId
      && this.isActiveBinding({ botId: input.botId, threadId: input.threadId, contextId: input.previousContextId });
    if (input.contextTransition === 'workspace' && !workspaceTransition) throw new Error('A workspace transition requires its active preceding context');
    if (previous && !previous.active) throw new Error('A retired native context cannot be reactivated; create a new branch context');
    const retireBranch = input.contextTransition === 'branch' || !previous && !workspaceTransition;
    const retired = retireBranch ? this.db!.prepare('SELECT * FROM bindings WHERE bot_id = ? AND thread_id = ? AND id <> ? AND active = 1').all(input.botId, input.threadId, id) as unknown as BindingRow[] : [];
    this.fenceBindings(retired);
    await Promise.all(retired.map(row => this.retire(row.id)));
    if (epoch !== (this.admissionEpoch.get(id) ?? 0) || threadEpoch !== (this.threadEpoch.get(threadKey) ?? 0)
      || previous && !this.binding(id)?.active) throw new Error('Super Agent request stopped before admission; create a new context after revocation');
    if (previous) this.db!.prepare('UPDATE bindings SET input = ?,needs_recovery=1,next_wake=0 WHERE id = ? AND active=1').run(JSON.stringify(merged), id);
    else this.db!.prepare('INSERT INTO bindings(id, bot_id, thread_id, context_id, input,workspace,needs_recovery) VALUES (?, ?, ?, ?, ?,?,1)').run(id, input.botId, input.threadId, input.contextId ?? 'default', JSON.stringify(merged), workspace);
    const textHash = createHash('sha256').update(input.text).digest('hex');
    const request = this.db!.prepare('SELECT text_hash, source_message_id, status FROM requests WHERE binding_id=? AND request_id=?').get(id, input.requestId) as { text_hash: string; source_message_id: string | null; status: string } | undefined;
    if (request && (request.text_hash !== textHash || request.source_message_id !== (input.sourceMessageId ?? null))) throw new Error('A Super Agent request ID cannot be reused for different source input');
    if (request?.status === 'stopped') throw new Error('This Super Agent request was explicitly stopped; submit a new request');
    if (request?.status === 'failed') throw new Error('This Super Agent request failed; submit a new request to continue the recovered conversation');
    if (request?.status === 'completed') {
      for (const listener of this.listeners) listener({ type: 'completed', botId: input.botId, threadId: input.threadId, contextId: input.contextId, requestId: input.requestId });
      return;
    }
    if (!request) this.db!.prepare('INSERT INTO requests(binding_id,request_id,source_message_id,text_hash,admitted) VALUES(?,?,?,?,0)').run(id, input.requestId, input.sourceMessageId ?? null, textHash);
    this.pendingAdmissions.set(id, (this.pendingAdmissions.get(id) ?? 0) + 1);
    let child: Child;
    try { child = await this.child(id, merged); await child.ready; }
    catch (error) {
      this.db!.prepare("UPDATE requests SET status='failed',revoked=1,authorization_version=authorization_version+1 WHERE binding_id=? AND request_id=? AND admitted=0").run(id, input.requestId);
      this.updateRecoveryNeed(id);
      throw error;
    }
    finally {
      const pending = (this.pendingAdmissions.get(id) ?? 1) - 1;
      if (pending) this.pendingAdmissions.set(id, pending); else this.pendingAdmissions.delete(id);
    }
    const admission = this.db!.prepare('SELECT status FROM requests WHERE binding_id=? AND request_id=?').get(id, input.requestId) as { status: string } | undefined;
    const active = this.db!.prepare('SELECT active FROM bindings WHERE id=?').get(id) as { active: number } | undefined;
    if (!active?.active || admission?.status === 'stopped' || epoch !== (this.admissionEpoch.get(id) ?? 0)) {
      this.db!.prepare("UPDATE requests SET status='stopped' WHERE binding_id=? AND request_id=?").run(id, input.requestId);
      child.busy.delete(input.requestId);
      if (!active?.active) await this.retire(id);
      throw new Error('Super Agent request stopped before admission');
    }
    child.busy.add(input.requestId);
    const authorization = this.request(id, input.requestId)!;
    try {
      await child.peer.request('submit', { ...merged, authorizationVersion: authorization.authorization_version, botId: undefined, threadId: undefined });
      this.db!.prepare('UPDATE requests SET admitted=1 WHERE binding_id=? AND request_id=?').run(id, input.requestId);
    }
    catch (error) { child.busy.delete(input.requestId); throw error; }
  }

  async interrupt(binding: SuperagentBinding, target: SuperagentInterrupt = { scope: 'conversation' }): Promise<void> {
    await this.start();
    const rows = target.scope === 'conversation'
      ? this.db!.prepare('SELECT * FROM bindings WHERE bot_id=? AND thread_id=? AND active=1').all(binding.botId, binding.threadId) as unknown as BindingRow[]
      : [this.binding(bindingKey(binding))].filter((row): row is BindingRow => !!row && !!row.active);
    if (target.scope === 'task' && !target.ticketId || target.scope === 'request' && !target.requestId) throw new TypeError('Scoped Stop requires the exact task or request identity');
    for (const row of rows) {
      const id = row.id;
      if (target.scope === 'conversation') {
        this.admissionEpoch.set(id, (this.admissionEpoch.get(id) ?? 0) + 1);
        this.db!.prepare("UPDATE requests SET status='stopped',revoked=1,write_revoked=1,admission_revoked=1,authorization_version=authorization_version+1 WHERE binding_id=? AND status<>'stopped'").run(id);
        this.db!.prepare('UPDATE bindings SET stop_pending=1,needs_recovery=1 WHERE id=?').run(id);
      } else if (target.scope === 'request') {
        this.db!.prepare("UPDATE requests SET status='stopped',revoked=1,write_revoked=1,admission_revoked=1,authorization_version=authorization_version+1 WHERE binding_id=? AND request_id=? AND status<>'stopped'").run(id, target.requestId!);
      } else {
        const task = this.db!.prepare('SELECT value FROM task_state WHERE binding_id=? AND ticket_id=?').get(id, target.ticketId!) as { value: string } | undefined;
        if (!task) continue;
        this.db!.prepare('INSERT OR IGNORE INTO stopped_tickets(binding_id,ticket_id) VALUES(?,?)').run(id, target.ticketId!);
        this.db!.prepare('UPDATE requests SET write_revoked=1 WHERE binding_id=? AND request_id=?').run(id, (JSON.parse(task.value) as SuperagentTaskState).requestId);
      }
      this.expireDecisions(id, 'Stopped by the conversation owner', decision => target.scope === 'conversation'
        || target.scope === 'request' && decision.requestId === target.requestId
        || target.scope === 'task' && decision.ticketId === target.ticketId);
      if (!this.children.has(id) && this.pendingAdmissions.has(id)) continue;
      const child = this.children.get(id) ?? await this.child(id, JSON.parse(row.input) as SuperagentInput);
      await child.ready;
      const stoppedRequestIds = this.stoppedRequests(id);
      const stoppedTicketIds = this.stoppedTickets(id);
      await child.peer.request('interrupt', { ...target, stoppedRequestIds, stoppedTicketIds });
      this.db!.prepare('UPDATE bindings SET stop_pending=0 WHERE id=?').run(id);
      if (target.scope === 'conversation') child.busy.clear();
      else if (target.requestId) child.busy.delete(target.requestId);
      await this.refreshActivity(id, child);
      if (target.scope === 'conversation') {
        const deadline = Date.now() + 3_000;
        while (Date.now() < deadline && !this.evictable(id, child)) {
          await new Promise<void>(resolve => setTimeout(resolve, 40));
          await this.refreshActivity(id, child);
        }
      }
    }
  }

  async respond(binding: SuperagentBinding, decisionId: string, answer: { behavior: 'allow' | 'deny' | 'answer'; message?: string }): Promise<boolean> {
    await this.start();
    const id = bindingKey(binding);
    const row = this.db!.prepare("SELECT * FROM decisions WHERE binding_id=? AND decision_id=? AND status='pending'").get(id, decisionId) as unknown as DecisionRow | undefined;
    if (!row || !this.isActiveBinding(binding)) return false;
    const decision = JSON.parse(row.value) as SuperagentDecisionState;
    if (decision.kind === 'approval' && answer.behavior === 'answer' || decision.kind === 'question' && answer.behavior === 'allow') return false;
    const request = this.request(id, decision.requestId);
    const child = this.children.get(id);
    if (!child || child.owner !== row.owner || request?.revoked || request?.authorization_version !== decision.authorizationVersion
      || decision.ticketId && (this.ticketStopped(id, decision.ticketId) || this.tasks(id).find(task => task.ticketId === decision.ticketId)?.ended)) {
      this.resolveDecision(id, decisionId, 'expired', undefined, 'The native approval is no longer authorized');
      return false;
    }
    await child.ready;
    if (await child.peer.request('respond', { decisionId, ...answer }) !== true) {
      this.resolveDecision(id, decisionId, 'expired', undefined, 'The native tool no longer waits for this answer');
      return false;
    }
    this.resolveDecision(id, decisionId, 'resolved', answer.behavior);
    await this.refreshActivity(id, child);
    return true;
  }

  async generateText(prompt: string, options?: { signal?: AbortSignal }): Promise<string> {
    if (typeof prompt !== 'string' || prompt.length > 1024 * 1024) throw new TypeError('Invalid auxiliary prompt');
    options?.signal?.throwIfAborted();
    await this.start();
    const child = await this.child('upkeep', undefined);
    await child.ready;
    const requestId = randomUUID();
    child.busy.add(requestId);
    const abort = () => { child.peer.notify('cancel-generate', { requestId }); };
    options?.signal?.addEventListener('abort', abort, { once: true });
    try { return String(await child.peer.request('generate', { requestId, prompt })); }
    finally { child.busy.delete(requestId); options?.signal?.removeEventListener('abort', abort); }
  }

  subscribe(listener: (event: SuperagentEvent) => void): () => void {
    this.listeners.add(listener);
    void this.start().then(() => {
      if (!this.listeners.has(listener) || !this.db) return;
      for (const row of this.db.prepare('SELECT * FROM decisions').all() as unknown as DecisionRow[]) {
        const decision = JSON.parse(row.value) as SuperagentDecisionState;
        if (row.status === 'pending' && this.isActiveBinding(decision)) listener({ ...decision, type: decision.kind });
        else listener({ ...decision, type: 'decision.resolved', reason: 'The native approval expired or was already answered' });
      }
    }).catch(error => this.options.onDiagnostic?.(`Could not restore native approvals: ${String(error)}\n`));
    return () => { this.listeners.delete(listener); };
  }

  isActiveBinding(binding: SuperagentBinding): boolean {
    return !!this.binding(bindingKey(binding))?.active;
  }

  revoke(binding: SuperagentBinding): Promise<void> {
    if (binding.contextId === undefined) {
      const key = JSON.stringify([binding.botId, binding.threadId]);
      this.threadEpoch.set(key, (this.threadEpoch.get(key) ?? 0) + 1);
    } else {
      const id = bindingKey(binding);
      this.admissionEpoch.set(id, (this.admissionEpoch.get(id) ?? 0) + 1);
    }
    const revoke = () => {
      const rows = this.db!.prepare('SELECT * FROM bindings WHERE bot_id=? AND thread_id=? AND active=1')
        .all(binding.botId, binding.threadId) as unknown as BindingRow[];
      const selected = rows.filter(row => binding.contextId === undefined || row.context_id === binding.contextId);
      this.fenceBindings(selected);
      return Promise.all(selected.map(row => this.retire(row.id))).then(() => {});
    };
    return this.db ? revoke() : this.start().then(revoke);
  }

  private fenceBindings(rows: BindingRow[]): void {
    if (!rows.length) return;
    this.db!.exec('BEGIN IMMEDIATE');
    try {
      for (const row of rows) {
        this.admissionEpoch.set(row.id, (this.admissionEpoch.get(row.id) ?? 0) + 1);
        this.db!.prepare('UPDATE bindings SET active=0,stop_pending=0,needs_recovery=0,next_wake=0,activity=? WHERE id=?')
          .run(JSON.stringify(emptyActivity()), row.id);
        this.db!.prepare("UPDATE requests SET status='stopped',revoked=1,write_revoked=1,admission_revoked=1,authorization_version=authorization_version+1 WHERE binding_id=?")
          .run(row.id);
        this.db!.prepare('UPDATE deliveries SET suppressed=1 WHERE binding_id=? AND persisted=0').run(row.id);
        for (const task of this.tasks(row.id).filter(task => !task.ended)) {
          this.db!.prepare('INSERT OR IGNORE INTO stopped_tickets(binding_id,ticket_id) VALUES(?,?)').run(row.id, task.ticketId);
          this.db!.prepare('UPDATE task_state SET value=? WHERE binding_id=? AND ticket_id=?')
            .run(JSON.stringify({ ...task, state: 'stopped', ended: true }), row.id, task.ticketId);
        }
        this.db!.prepare("UPDATE decisions SET status='expired',value=json_set(value,'$.status','expired') WHERE binding_id=? AND status='pending'").run(row.id);
      }
      this.db!.exec('COMMIT');
    } catch (error) { this.db!.exec('ROLLBACK'); throw error; }
    for (const row of rows) {
      for (const task of this.tasks(row.id)) this.emit({ ...task, type: 'task' });
      for (const decision of this.db!.prepare("SELECT value FROM decisions WHERE binding_id=? AND status='expired'").all(row.id) as { value: string }[]) {
        this.emit({ ...JSON.parse(decision.value) as SuperagentDecisionState, type: 'decision.resolved', reason: 'The native conversation context was revoked' });
      }
    }
  }

  async releaseWorkspace(id: string): Promise<boolean> {
    await this.start();
    return this.resources!.releaseWorkspace(id);
  }

  authorizeMemory(value: SuperagentMemoryRequest): boolean {
    const id = bindingKey(value);
    const child = this.children.get(id);
    const request = value.caller && this.request(id, value.caller.requestId);
    if (!child?.initialized || child.closing || this.closing || !child.masterId || !request || request.write_revoked || value.caller?.role !== 'master'
      || value.caller.agentId !== child.masterId || !value.caller.sourceMessageId) return false;
    try {
      const caller = this.authorizedCaller(id, child, value.caller);
      return caller.sourceMessageId === value.caller.sourceMessageId;
    } catch { return false; }
  }

  async inspect(binding?: SuperagentBinding): Promise<SuperagentSnapshot> {
    await this.start();
    const matches = (value: SuperagentBinding) => !binding || value.botId === binding.botId && value.threadId === binding.threadId
      && (binding.contextId === undefined || value.contextId === binding.contextId);
    const bindings = (this.db!.prepare('SELECT * FROM bindings').all() as unknown as BindingRow[]).map(row => ({ ...this.identity(row), workspace: row.workspace, active: !!row.active })).filter(matches);
    const tasks = (this.db!.prepare('SELECT value FROM task_state').all() as { value: string }[]).map(row => JSON.parse(row.value) as SuperagentTaskState).filter(matches);
    const decisions = (this.db!.prepare('SELECT value FROM decisions').all() as { value: string }[]).map(row => JSON.parse(row.value) as SuperagentDecisionState).filter(matches);
    return { bindings, tasks, decisions, resources: this.resources!.snapshot() };
  }

  status() {
    const latest = [...this.children.values()].sort((a, b) => b.lastUsed - a.lastUsed)[0];
    return { enabled: true, state: this.state, ...(latest ? { pid: latest.process.pid } : {}), ...(this.error ? { error: this.error } : {}) };
  }

  close(): Promise<void> { return this.closing ??= this.shutdown(); }

  private async shutdown(): Promise<void> {
    await this.opening?.catch(() => {});
    this.state = 'stopping';
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
    await this.childQueue.catch(() => {});
    await Promise.all([...this.children.keys()].map(id => this.retire(id)));
    await Promise.all(this.retiring);
    this.children.clear();
    this.resources?.close(this.retainedGroups);
    this.resources = undefined;
    this.db?.close();
    this.db = undefined;
    this.state = 'stopped';
  }

  private async retire(id: string): Promise<void> {
    const pending = this.retiringChildren.get(id);
    if (pending) return pending;
    const child = this.children.get(id);
    if (!child) return;
    const stopping = this.stopChild(child);
    this.retiringChildren.set(id, stopping);
    this.retiring.add(stopping);
    try { await stopping; } finally {
      if (this.children.get(id) === child) this.children.delete(id);
      this.retiring.delete(stopping);
      this.retiringChildren.delete(id);
    }
  }

  private async stopChild(child: Child): Promise<void> {
    child.closing = true;
    await child.ready.catch(() => {});
    try { child.graceful = await child.peer.request('shutdown', undefined, 15_000) === true; } catch {}
    if (!child.graceful) this.resources?.quarantineOwner(child.owner, 'The native runtime could not confirm a graceful shutdown while holding a workspace write window.');
    child.process.stdin.end();
    const exited = () => child.process.exitCode !== null || child.process.signalCode !== null;
    const wait = (timeout: number) => exited() ? Promise.resolve() : new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); child.process.off('exit', done); resolve(); };
      const timer = setTimeout(done, timeout);
      child.process.once('exit', done);
    });
    await wait(1500);
    if (!exited()) {
      child.graceful = false;
      this.resources?.quarantineOwner(child.owner, 'The native runtime required forced termination while holding a workspace write window.');
      child.process.kill('SIGTERM'); await wait(1500);
    }
    if (!exited()) {
      this.resources?.quarantineOwner(child.owner, 'The native runtime required SIGKILL while holding a workspace write window.');
      child.process.kill('SIGKILL'); await wait(1500);
    }
    await this.cleanupProcessGroup(child);
    child.peer.close();
  }

  private cleanupProcessGroup(child: Child): Promise<void> {
    return child.groupCleanup ??= (async () => {
      if (!child.graceful) this.resources?.quarantineOwner(child.owner, 'The native runtime ended unexpectedly while holding a workspace write window; the owner must reconcile any surviving external work.');
      const pid = child.process.pid;
      if (!pid) { this.resources?.releaseOwner(child.owner); return; }
      const groupAlive = () => {
        if (!child.grouped) return child.process.exitCode === null && child.process.signalCode === null;
        try { process.kill(-pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
      };
      const send = (signal: NodeJS.Signals) => {
        try { if (child.grouped) process.kill(-pid, signal); else child.process.kill(signal); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') this.options.onDiagnostic?.(`Could not stop an owned tool process group: ${String(error)}\n`); }
      };
      if (groupAlive()) send('SIGTERM');
      const deadline = Date.now() + 1_500;
      while (groupAlive() && Date.now() < deadline) await new Promise<void>(resolve => setTimeout(resolve, 25));
      if (groupAlive()) send('SIGKILL');
      const killedDeadline = Date.now() + 1_500;
      while (groupAlive() && Date.now() < killedDeadline) await new Promise<void>(resolve => setTimeout(resolve, 25));
      if (!groupAlive()) this.resources?.releaseOwner(child.owner);
      else {
        this.retainedGroups = true;
        this.options.onDiagnostic?.('An owned native process group did not exit; its host leases remain held.\n');
      }
    })();
  }

  private async child(id: string, input: SuperagentInput | undefined): Promise<Child> {
    const result = this.childQueue.then(() => this.openChild(id, input));
    this.childQueue = result.then(() => {}, () => {});
    return result;
  }

  private async openChild(id: string, input: SuperagentInput | undefined): Promise<Child> {
    if (this.closing) throw new Error('Super Agent gateway closed');
    const resolved = await this.options.resolveLaunch?.();
    const provider = this.options.fixture ? 'official-fixture' : resolved?.provider ?? this.options.provider;
    const model = this.options.fixture ? 'fixture' : input?.model ?? resolved?.model ?? this.options.model;
    const bound = this.binding(id);
    if (bound && !bound.active) throw new Error('The native conversation context was retired');
    const workspace = canonicalWorkspace(bound?.workspace || input?.cwd || this.options.workspace, !bound);
    if (bound && workspace !== bound.workspace) throw new Error('The fixed native working directory was redirected; create a new workspace context before resuming work.');
    const fingerprint = createHash('sha256').update(JSON.stringify([provider, model, resolved?.env ?? {}, workspace])).digest('hex');
    const existing = this.children.get(id);
    if (existing?.fingerprint === fingerprint) { existing.lastUsed = Date.now(); return existing; }
    if (existing) {
      if (!existing.busy.size && existing.initialized) await this.refreshActivity(id, existing);
      if (!this.evictable(id, existing, true)) throw new Error('The model or credentials changed while this conversation has active work. Stop it before applying the new configuration.');
      await this.retire(id);
    }
    const limit = this.options.maxChildren ?? 8;
    if (!Number.isInteger(limit) || limit < 1 || limit > 64) throw new TypeError('maxChildren must be between 1 and 64');
    if (this.children.size >= limit) {
      const idle = [...this.children.entries()].filter(([id, child]) => this.evictable(id, child)).sort(([, a], [, b]) => a.lastUsed - b.lastUsed)[0];
      if (!idle) throw new Error(`All ${limit} Super Agent conversation runtimes are busy. Stop one before starting another.`);
      await this.retire(idle[0]);
    }
    const config = {
      home: join(this.options.home, 'official-superagent', id),
      workspace,
      bindingId: id,
      provider,
      model,
      fixture: this.options.fixture,
      instructions: input?.instructions,
      approvalMode: input?.approvalMode,
      stopBeforeRecovery: id === 'upkeep' ? false : Boolean((this.db!.prepare('SELECT stop_pending FROM bindings WHERE id=?').get(id) as { stop_pending: number } | undefined)?.stop_pending),
      stoppedRequestIds: id === 'upkeep' ? [] : (this.db!.prepare("SELECT request_id FROM requests WHERE binding_id=? AND status='stopped'").all(id) as { request_id: string }[]).map(row => row.request_id),
      stoppedTicketIds: this.stoppedTickets(id),
      fencedRequestIds: id === 'upkeep' ? [] : (this.db!.prepare('SELECT request_id FROM requests WHERE binding_id=? AND admission_revoked=1').all(id) as { request_id: string }[]).map(row => row.request_id),
      requestAuthorizations: id === 'upkeep' ? [] : (this.db!.prepare('SELECT request_id,source_message_id,authorization_version FROM requests WHERE binding_id=? AND revoked=0').all(id) as { request_id: string; source_message_id: string | null; authorization_version: number }[])
        .map(row => ({ requestId: row.request_id, sourceMessageId: row.source_message_id ?? undefined, authorizationVersion: row.authorization_version })),
    };
    const launch = await prepareLaunch(config);
    if (bound && !this.binding(id)?.active) throw new Error('The native conversation context was retired before launch');
    const raced = this.children.get(id);
    if (raced) return raced;
    const grouped = globalThis.process.platform !== 'win32';
    const process = spawn(launch.command, launch.args, { cwd: launch.cwd, env: { ...launch.env, ...resolved?.env }, stdio: ['pipe', 'pipe', 'pipe'], detached: grouped });
    const peer = new Peer(process.stdout, process.stdin);
    const child: Child = { process, peer, ready: Promise.resolve(), initialized: false, error: '', closing: false, fingerprint, busy: new Set(input ? [input.requestId] : ['upkeep-startup']), lastUsed: Date.now(), owner: this.resources!.owner(id, randomUUID()), workspace, grouped, graceful: false };
    this.children.set(id, child);
    process.stderr.on('data', chunk => { child.error = (child.error + String(chunk)).slice(-24_000); this.options.onDiagnostic?.(String(chunk)); });
    peer.handler = async (method, params) => {
      if (this.children.get(id) !== child) throw new Error('The owning native runtime is no longer active');
      if (method === 'model-release' || method === 'workspace-release') return this.resourceRequest(id, child, method, params);
      if (child.closing || this.closing) throw new Error('The owning native runtime is no longer active');
      if (['model-acquire', 'model-release', 'workspace-acquire', 'workspace-release'].includes(method)) return this.resourceRequest(id, child, method, params);
      if (method === 'fence-admission') {
        const value = params as { bindingId?: string; ticketId?: string; requestIds?: string[]; stoppedRequestId?: string };
        const stoppedRequest = typeof value?.stoppedRequestId === 'string' ? this.request(id, value.stoppedRequestId) : undefined;
        const fromRequest = stoppedRequest?.status === 'stopped' && !!stoppedRequest.revoked
          && Array.isArray(value.requestIds) && value.requestIds.includes(value.stoppedRequestId!);
        if (value?.bindingId !== id || !this.binding(id)?.active || !value.ticketId
          || !this.db!.prepare('SELECT 1 FROM task_state WHERE binding_id=? AND ticket_id=?').get(id, value.ticketId)
          || !this.ticketStopped(id, value.ticketId) && !fromRequest
          || !Array.isArray(value.requestIds) || value.requestIds.length > 100_000
          || value.requestIds.some(requestId => typeof requestId !== 'string' || !this.request(id, requestId))) throw new Error('Admission fencing requires the exact stopped ticket or a revoked original request selecting its native ticket');
        this.db!.exec('BEGIN IMMEDIATE');
        try {
          this.db!.prepare('INSERT OR IGNORE INTO stopped_tickets(binding_id,ticket_id) VALUES(?,?)').run(id, value.ticketId);
          for (const requestId of value.requestIds) this.db!.prepare('UPDATE requests SET admission_revoked=1,write_revoked=1 WHERE binding_id=? AND request_id=?').run(id, requestId);
          this.db!.exec('COMMIT');
        } catch (error) { this.db!.exec('ROLLBACK'); throw error; }
        this.expireDecisions(id, 'The native task was stopped from its original request', decision => decision.ticketId === value.ticketId);
        return true;
      }
      if (!['memory', 'deliver'].includes(method) || id === 'upkeep') throw new Error('Unrecognized reverse Super Agent request');
      if (method === 'deliver') return this.deliver(id, params);
      const value = params as { bindingId?: string; operation?: string; query?: string; path?: string; text?: string; evidence?: { messageId: string; quote: string }; caller?: SuperagentCaller };
      if (!value || value.bindingId !== id || !['search', 'read', 'remember', 'forget'].includes(value.operation ?? '')) throw new Error('Invalid private memory binding');
      const binding = this.db?.prepare('SELECT bot_id, thread_id, context_id FROM bindings WHERE id = ? AND active = 1').get(id) as { bot_id: string; thread_id: string; context_id: string } | undefined;
      if (!binding) throw new Error('Memory binding is no longer available');
      const caller = this.authorizedCaller(id, child, value.caller);
      if ((value.operation === 'remember' || value.operation === 'forget') && caller.role !== 'master') throw new Error('Worker memory access is read-only');
      if ((value.operation === 'remember' || value.operation === 'forget') && this.request(id, caller.requestId)?.write_revoked) throw new Error('This request memory-write authorization was revoked by Stop');
      return this.options.memory({ botId: binding.bot_id, threadId: binding.thread_id, contextId: binding.context_id, operation: value.operation as SuperagentMemoryRequest['operation'], query: value.query, path: value.path, text: value.text, evidence: value.evidence, caller });
    };
    peer.notification = (method, params) => {
      if (method === 'model-cancel' || method === 'workspace-cancel') {
        const value = params as { bindingId?: string; leaseId?: string };
        if (value?.bindingId === id && value.leaseId) this.resources?.release(value.leaseId, child.owner);
        return;
      }
      if (method !== 'event' || id === 'upkeep') return;
      this.receiveEvent(id, child, params);
    };
    process.once('error', error => { peer.close(error); this.error = String(error); this.childFailed(id, child, String(error)); });
    process.once('exit', (code, signal) => {
      void this.cleanupProcessGroup(child);
      // proper-lockfile's heartbeat would otherwise block crash recovery for 30s.
      // Only remove the empty lock of a child that successfully owned this
      // private Runtime and whose exact process has now exited.
      if (child.initialized) {
        try { rmdirSync(join(config.home, 'state.lock')); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.options.onDiagnostic?.(`Could not release exited Super Agent state lock: ${String(error)}\n`);
        }
      }
      peer.close(new Error(`Super Agent exited (${code ?? signal}): ${child.error.slice(-3000)}`));
      if (!child.closing) { this.children.delete(id); this.state = 'failed'; this.error = `Super Agent exited (${code ?? signal}): ${child.error.slice(-3000)}`; this.childFailed(id, child, this.error); }
    });
    child.ready = peer.request('initialize', undefined, 45_000).then(async result => {
      child.busy.delete('upkeep-startup');
      child.initialized = true;
      child.masterId = (result as { masterId?: string })?.masterId;
      const savedRequest = input && this.request(id, input.requestId);
      if (input && savedRequest?.status !== 'active') child.busy.delete(input.requestId);
      if (config.stopBeforeRecovery) this.db?.prepare('UPDATE bindings SET stop_pending=0 WHERE id=?').run(id);
      if (id !== 'upkeep') this.updateRecoveryNeed(id);
      this.state = 'ready'; this.error = undefined;
      const launchedBinding = this.binding(id);
      await this.options.onLaunch?.({
        provider: resolved?.provider ?? this.options.provider, model: input?.model ?? resolved?.model ?? this.options.model, env: resolved?.env ?? {},
        ...(launchedBinding ? { binding: this.identity(launchedBinding) } : {}), pid: process.pid,
      });
    }).catch(error => {
      const failure = new Error(`${String(error)}${child.error ? `\n${child.error.slice(-12_000)}` : ''}`);
      this.state = 'failed'; this.error = failure.message;
      this.childFailed(id, child, failure.message);
      queueMicrotask(() => { if (this.children.get(id) === child) void this.retire(id); });
      throw failure;
    });
    return child;
  }

  private childFailed(id: string, child: Child, error: string): void {
    if (child.closing || id === 'upkeep') return;
    if (child.process.pid) void this.cleanupProcessGroup(child);
    else this.resources?.releaseOwner(child.owner);
    this.expireDecisions(id, 'The native runtime exited; recovered tools must ask again');
    const binding = this.db?.prepare('SELECT bot_id, thread_id, context_id FROM bindings WHERE id=? AND active=1').get(id) as { bot_id: string; thread_id: string; context_id: string } | undefined;
    if (!binding) return;
    for (const requestId of child.busy) {
      const request = this.db?.prepare('SELECT status FROM requests WHERE binding_id=? AND request_id=?').get(id, requestId) as { status: string } | undefined;
      if (request?.status === 'stopped') continue;
      this.db?.prepare("UPDATE requests SET status='failed' WHERE binding_id=? AND request_id=? AND status <> 'stopped'").run(id, requestId);
      const event: SuperagentEvent = { type: 'failed', botId: binding.bot_id, threadId: binding.thread_id, contextId: binding.context_id, requestId, error };
      for (const listener of this.listeners) listener(event);
    }
    child.busy.clear();
    const failures = (this.binding(id)?.failures ?? 0) + 1;
    this.db?.prepare('UPDATE bindings SET needs_recovery=1,failures=?,next_wake=? WHERE id=?')
      .run(failures, Date.now() + Math.min(30_000, 250 * 2 ** Math.min(failures, 7)), id);
    this.scheduleRecovery();
  }

  private identity(row: Pick<BindingRow, 'bot_id' | 'thread_id' | 'context_id'>): SuperagentBinding {
    return { botId: row.bot_id, threadId: row.thread_id, contextId: row.context_id };
  }

  private binding(id: string): BindingRow | undefined {
    return this.db?.prepare('SELECT * FROM bindings WHERE id=?').get(id) as unknown as BindingRow | undefined;
  }

  private request(id: string, requestId: string): RequestRow | undefined {
    return this.db?.prepare('SELECT * FROM requests WHERE binding_id=? AND request_id=?').get(id, requestId) as unknown as RequestRow | undefined;
  }

  private stoppedRequests(id: string): string[] {
    return (this.db?.prepare("SELECT request_id FROM requests WHERE binding_id=? AND status='stopped'").all(id) as { request_id: string }[] ?? []).map(row => row.request_id);
  }

  private stoppedTickets(id: string): string[] {
    return (this.db?.prepare('SELECT ticket_id FROM stopped_tickets WHERE binding_id=?').all(id) as { ticket_id: string }[] ?? []).map(row => row.ticket_id);
  }

  private ticketStopped(id: string, ticketId: string): boolean {
    return !!this.db?.prepare('SELECT 1 FROM stopped_tickets WHERE binding_id=? AND ticket_id=?').get(id, ticketId);
  }

  private authorizedCaller(id: string, child: Child, caller: SuperagentCaller | undefined): SuperagentCaller {
    if (!caller || typeof caller.requestId !== 'string' || typeof caller.agentId !== 'string' || !caller.agentId
      || !['master', 'worker'].includes(caller.role) || !Number.isSafeInteger(caller.authorizationVersion)) throw new Error('Memory requires a native caller and request authorization');
    const request = this.request(id, caller.requestId);
    if (!this.binding(id)?.active || !request || request.revoked || request.authorization_version !== caller.authorizationVersion) throw new Error('The memory request authorization is no longer valid');
    if (caller.role === 'master' && child.masterId && caller.agentId !== child.masterId) throw new Error('Only the native main agent may use a master memory capability');
    if (caller.role === 'worker' && child.masterId === caller.agentId) throw new Error('Invalid native worker identity');
    if (caller.ticketId && this.ticketStopped(id, caller.ticketId)) throw new Error('The task memory capability was revoked');
    if (caller.sourceMessageId !== undefined && caller.sourceMessageId !== (request.source_message_id ?? undefined)) throw new Error('Memory source message does not match its original request');
    return { ...caller, sourceMessageId: request.source_message_id ?? undefined, authorizationVersion: request.authorization_version };
  }

  private evictable(id: string, child: Child, admittingCurrent = false): boolean {
    if (child.busy.size || !admittingCurrent && this.pendingAdmissions.has(id)) return false;
    if (this.resources?.hasLeases(child.owner)) return false;
    const row = this.binding(id);
    const activity = row ? JSON.parse(row.activity) as Activity : emptyActivity();
    if (activity.tasks || activity.pendingDecisions || activity.pendingDeliveries) return false;
    if (this.db?.prepare("SELECT 1 FROM decisions WHERE binding_id=? AND status='pending' LIMIT 1").get(id)) return false;
    return !this.tasks(id).some(task => !task.ended);
  }

  private tasks(id: string): SuperagentTaskState[] {
    return (this.db?.prepare('SELECT value FROM task_state WHERE binding_id=?').all(id) as { value: string }[] ?? []).map(row => JSON.parse(row.value) as SuperagentTaskState);
  }

  private saveTask(id: string, value: SuperagentTaskState): void {
    const binding = this.binding(id);
    if (!binding?.active) return;
    const request = this.request(id, value.requestId);
    const task: SuperagentTaskState = { ...value, ...this.identity(binding), workspace: binding.workspace,
      sourceMessageId: request?.source_message_id ?? undefined, ended: value.ended ?? endedStates.has(value.state) };
    this.db!.prepare('INSERT INTO task_state(binding_id,ticket_id,value) VALUES(?,?,?) ON CONFLICT(binding_id,ticket_id) DO UPDATE SET value=excluded.value').run(id, task.ticketId, JSON.stringify(task));
  }

  private receiveEvent(id: string, child: Child, value: unknown): void {
    const binding = this.binding(id);
    if (!binding?.active || !value || typeof value !== 'object' || this.children.get(id) !== child) return;
    let event = { ...value, ...this.identity(binding) } as SuperagentEvent;
    const request = this.request(id, event.requestId);
    if (event.type === 'activity') {
      const activity = { tasks: event.tasks, pendingDecisions: event.pendingDecisions, pendingDeliveries: event.pendingDeliveries };
      this.saveActivity(id, activity);
      this.emit(event);
      return;
    }
    if (event.type === 'decision.resolved') {
      this.resolveDecision(id, event.decisionId, 'resolved', event.behavior, event.reason);
      return;
    }
    if (event.type === 'task') {
      this.saveTask(id, event);
      event = { ...event, sourceMessageId: request?.source_message_id ?? undefined, workspace: binding.workspace, ended: event.ended ?? endedStates.has(event.state) };
      if (event.ended) {
        const pending = this.db!.prepare("SELECT value FROM decisions WHERE binding_id=? AND status='pending'").all(id) as { value: string }[];
        for (const row of pending) {
          const decision = JSON.parse(row.value) as SuperagentDecisionState;
          if (decision.ticketId !== event.ticketId) continue;
          void child.peer.request('respond', { decisionId: decision.decisionId, behavior: 'deny' }).catch(() => {});
          this.resolveDecision(id, decision.decisionId, 'expired', undefined, 'The task ended before this approval was answered');
        }
      }
    }
    if ((event.type === 'approval' || event.type === 'question')) {
      if (!request || request.revoked || event.ticketId && this.ticketStopped(id, event.ticketId)
        || event.authorizationVersion !== undefined && event.authorizationVersion !== request.authorization_version) {
        void child.peer.request('respond', { decisionId: event.decisionId, behavior: 'deny' }).catch(() => {});
        return;
      }
      const decision: SuperagentDecisionState = { ...event, kind: event.type, status: 'pending', sourceMessageId: request.source_message_id ?? undefined, authorizationVersion: request.authorization_version };
      event = { ...event, sourceMessageId: decision.sourceMessageId, authorizationVersion: decision.authorizationVersion };
      this.db!.prepare("INSERT INTO decisions(binding_id,decision_id,request_id,owner,status,value) VALUES(?,?,?,?,'pending',?) ON CONFLICT(binding_id,decision_id) DO NOTHING")
        .run(id, decision.decisionId, decision.requestId, child.owner, JSON.stringify(decision));
    }
    if (event.type === 'started') child.busy.add(event.requestId);
    if (event.type === 'completed' || event.type === 'failed') child.busy.delete(event.requestId);
    if (request?.status === 'stopped' && event.type !== 'task') return;
    if (event.type === 'completed' || event.type === 'failed') this.db!.prepare("UPDATE requests SET status=? WHERE binding_id=? AND request_id=? AND status<>'stopped'").run(event.type, id, event.requestId);
    child.lastUsed = Date.now();
    this.emit(event);
    this.updateRecoveryNeed(id);
  }

  private emit(event: SuperagentEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private resolveDecision(id: string, decisionId: string, status: 'resolved' | 'expired', behavior?: 'allow' | 'deny' | 'answer', reason?: string): void {
    const row = this.db?.prepare("SELECT * FROM decisions WHERE binding_id=? AND decision_id=? AND status='pending'").get(id, decisionId) as unknown as DecisionRow | undefined;
    if (!row) return;
    const decision = JSON.parse(row.value) as SuperagentDecisionState;
    this.db!.prepare('UPDATE decisions SET status=?,value=? WHERE binding_id=? AND decision_id=?').run(status, JSON.stringify({ ...decision, status }), id, decisionId);
    this.emit({ ...decision, type: 'decision.resolved', ...(behavior ? { behavior } : {}), ...(reason ? { reason } : {}) });
    this.updateRecoveryNeed(id);
  }

  private expireDecisions(id: string, reason: string, matches: (decision: SuperagentDecisionState) => boolean = () => true): void {
    const pending = this.db?.prepare("SELECT * FROM decisions WHERE binding_id=? AND status='pending'").all(id) as unknown as DecisionRow[] ?? [];
    for (const row of pending) if (matches(JSON.parse(row.value) as SuperagentDecisionState)) this.resolveDecision(id, row.decision_id, 'expired', undefined, reason);
  }

  private saveActivity(id: string, activity: Activity): void {
    if (![activity.tasks, activity.pendingDeliveries, activity.pendingDecisions].every(count => Number.isSafeInteger(count) && count >= 0)) return;
    this.db?.prepare('UPDATE bindings SET activity=? WHERE id=?').run(JSON.stringify(activity), id);
    this.updateRecoveryNeed(id);
  }

  private updateRecoveryNeed(id: string): void {
    const binding = this.binding(id);
    if (!binding) return;
    if (!binding.active) {
      this.db!.prepare('UPDATE bindings SET needs_recovery=0,next_wake=0 WHERE id=?').run(id);
      return;
    }
    const activity = JSON.parse(binding.activity) as Activity;
    const pending = this.db!.prepare("SELECT 1 FROM requests WHERE binding_id=? AND status='active' LIMIT 1").get(id);
    const decisions = this.db!.prepare("SELECT 1 FROM decisions WHERE binding_id=? AND status='pending' LIMIT 1").get(id);
    const delivery = this.db!.prepare('SELECT 1 FROM deliveries WHERE binding_id=? AND persisted=0 AND suppressed=0 LIMIT 1').get(id);
    const needed = !!(binding.stop_pending || pending || decisions || delivery || activity.tasks || activity.pendingDeliveries || activity.pendingDecisions || this.tasks(id).some(task => !task.ended));
    this.db!.prepare('UPDATE bindings SET needs_recovery=? WHERE id=?').run(needed ? 1 : 0, id);
  }

  private async refreshActivity(id: string, child: Child): Promise<void> {
    const value = await child.peer.request('inspect', undefined, 15_000) as { tasks?: SuperagentTaskState[]; pendingDeliveries?: number; pendingDecisions?: number };
    if (!this.binding(id)?.active && id !== 'upkeep') return;
    for (const task of value.tasks ?? []) this.saveTask(id, task);
    this.saveActivity(id, { tasks: (value.tasks ?? []).filter(task => !task.ended && !endedStates.has(task.state)).length, pendingDeliveries: value.pendingDeliveries ?? 0, pendingDecisions: value.pendingDecisions ?? 0 });
  }

  private async resourceRequest(id: string, child: Child, method: string, params: unknown): Promise<unknown> {
    const value = params as { bindingId?: string; leaseId?: string; requestId?: string; agentId?: string; role?: SuperagentCaller['role']; ticketId?: string; routingAdmission?: boolean; usage?: SuperagentUsage };
    if (!value || value.bindingId !== id || typeof value.leaseId !== 'string' || !value.leaseId) throw new Error('Invalid private resource lease');
    if (method.endsWith('-release')) {
      try {
        if (method === 'model-release' && value.usage) {
          const usage = value.usage;
          if (usage.usageId !== value.leaseId) throw new Error('Usage does not match the acquired model call');
          const saved = this.request(id, usage.requestId);
          if (id !== 'upkeep' && !saved) throw new Error('Usage has no original source request');
          this.resources!.recordUsage(child.owner, usage);
          const binding = this.binding(id);
          const event = { ...usage, ...(binding ? this.identity(binding) : { botId: '__superagent_upkeep__', threadId: '__superagent_upkeep__', contextId: 'upkeep' }), type: 'usage' as const };
          this.db!.prepare('INSERT OR IGNORE INTO usage_events(id,value) VALUES(?,?)').run(usage.usageId, JSON.stringify(event));
          await this.projectUsage(event);
        }
      } finally { this.resources!.release(value.leaseId, child.owner); }
      return true;
    }
    const request = value.requestId ? this.request(id, value.requestId) : undefined;
    if (id !== 'upkeep' && (!this.binding(id)?.active || !request || request.revoked || value.ticketId && this.ticketStopped(id, value.ticketId))) throw new Error('The resource request was stopped or retired');
    if (method === 'model-acquire' && value.role === 'master' && value.routingAdmission && request?.admission_revoked) throw new Error('The source routing admission was stopped');
    if (method === 'workspace-acquire' && !value.ticketId && request?.write_revoked) throw new Error('The stopped task source no longer authorizes main-agent workspace writes');
    if (typeof value.agentId !== 'string' || !value.agentId || method === 'model-acquire' && !['master', 'worker', 'upkeep'].includes(value.role ?? '')) throw new Error('A model call needs its native agent identity');
    const binding = this.binding(id);
    const admission = { ...(binding ? this.identity(binding) : { botId: '__superagent_upkeep__', threadId: '__superagent_upkeep__' }), requestId: value.requestId ?? 'upkeep', agentId: value.agentId, role: value.role ?? 'worker', ticketId: value.ticketId };
    if (method === 'model-acquire') await this.options.onModelAdmission?.(admission);
    const acquired = await this.resources!.acquire(method === 'model-acquire' ? 'model' : 'workspace', value.leaseId, child.owner, child.process.pid!, child.workspace);
    const check = () => {
      const current = value.requestId ? this.request(id, value.requestId) : undefined;
      if (this.children.get(id) !== child || child.closing
        || id !== 'upkeep' && (!this.binding(id)?.active || !current || current.revoked || value.ticketId && this.ticketStopped(id, value.ticketId))
        || method === 'workspace-acquire' && !value.ticketId && current?.write_revoked
        || method === 'model-acquire' && value.role === 'master' && value.routingAdmission && current?.admission_revoked) throw new Error('The resource request was stopped before admission');
    };
    try {
      check();
      if (method === 'model-acquire') await this.options.onModelAdmission?.(admission);
      check();
      return acquired;
    } catch (error) { this.resources!.release(value.leaseId, child.owner); throw error; }
  }

  private projectUsage(event: SuperagentBinding & SuperagentUsage & { type: 'usage' }): Promise<void> {
    const pending = this.projectingUsage.get(event.usageId);
    if (pending) return pending;
    const projection = (async () => {
      const row = this.db?.prepare('SELECT projected FROM usage_events WHERE id=?').get(event.usageId) as { projected: number } | undefined;
      if (row?.projected) return;
      await this.options.usage?.(event);
      this.emit(event);
      this.resources?.acknowledgeUsage(event.usageId);
      this.db?.prepare('UPDATE usage_events SET projected=1 WHERE id=?').run(event.usageId);
    })();
    this.projectingUsage.set(event.usageId, projection);
    void projection.finally(() => this.projectingUsage.delete(event.usageId)).catch(() => {});
    return projection;
  }

  private scheduleRecovery(delay = this.options.recoveryIntervalMs ?? 500): void {
    if (this.closing || this.recoveryTimer) return;
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined;
      void this.recover().catch(error => this.options.onDiagnostic?.(`Super Agent lifecycle recovery: ${String(error)}\n`)).finally(() => this.scheduleRecovery());
    }, delay);
    this.recoveryTimer.unref();
  }

  private async recover(): Promise<void> {
    if (this.closing || this.recovering || !this.db) return;
    this.recovering = true;
    try {
      for (const row of this.db.prepare('SELECT value FROM usage_events WHERE projected=0').all() as { value: string }[]) {
        try { await this.projectUsage(JSON.parse(row.value) as SuperagentBinding & SuperagentUsage & { type: 'usage' }); }
        catch (error) { this.options.onDiagnostic?.(`Usage ledger projection will retry: ${String(error)}\n`); }
      }
      const rows = this.db.prepare('SELECT * FROM bindings WHERE active=1 AND needs_recovery=1 AND next_wake<=? ORDER BY next_wake,id').all(Date.now()) as unknown as BindingRow[];
      for (const row of rows) {
        if (this.closing) return;
        if (this.children.has(row.id) || this.pendingAdmissions.has(row.id)) continue;
        try {
          const input = JSON.parse(row.input) as SuperagentInput;
          if (this.options.canRecover?.(this.identity(row), input) === false) {
            await this.revoke(this.identity(row));
            continue;
          }
          const child = await this.child(row.id, input);
          await child.ready;
          const unadmitted = this.request(row.id, input.requestId);
          if (unadmitted?.status === 'active' && !unadmitted.admitted) {
            child.busy.add(input.requestId);
            await child.peer.request('submit', { ...input, authorizationVersion: unadmitted.authorization_version, botId: undefined, threadId: undefined });
            this.db.prepare('UPDATE requests SET admitted=1 WHERE binding_id=? AND request_id=?').run(row.id, input.requestId);
          }
          await this.refreshActivity(row.id, child);
          this.db.prepare('UPDATE bindings SET failures=0,next_wake=0 WHERE id=?').run(row.id);
        } catch (error) {
          const failures = row.failures + 1;
          this.db?.prepare('UPDATE bindings SET failures=?,next_wake=? WHERE id=? AND active=1').run(failures, Date.now() + Math.min(30_000, 250 * 2 ** Math.min(failures, 7)), row.id);
          this.options.onDiagnostic?.(`Background binding recovery deferred: ${String(error)}\n`);
        }
      }
    } finally { this.recovering = false; }
  }

  private async deliver(id: string, params: unknown): Promise<{ persisted: boolean; suppressed?: boolean }> {
    const value = params as Partial<SuperagentDelivery> & { bindingId?: string };
    if (!value || value.bindingId !== id || typeof value.requestId !== 'string' || typeof value.messageId !== 'string' || typeof value.text !== 'string' || typeof value.purpose !== 'string' || value.text.length > 1024 * 1024) throw new Error('Invalid private source delivery');
    const receipt = this.db?.prepare('SELECT request_id,persisted,suppressed FROM deliveries WHERE binding_id=? AND message_id=?').get(id, value.messageId) as { request_id: string; persisted: number; suppressed: number } | undefined;
    value.requestId = receipt?.request_id ?? value.requestId;
    const binding = this.db?.prepare('SELECT bot_id, thread_id, context_id FROM bindings WHERE id=? AND active=1').get(id) as { bot_id: string; thread_id: string; context_id: string } | undefined;
    const request = this.db?.prepare('SELECT source_message_id, status FROM requests WHERE binding_id=? AND request_id=?').get(id, value.requestId) as { source_message_id: string | null; status: string } | undefined;
    if (!request) throw new Error('Source delivery has no durable original request');
    if (!binding || request.status === 'stopped' || value.ticketId && this.ticketStopped(id, value.ticketId)) {
      this.db?.prepare('INSERT INTO deliveries(binding_id,message_id,request_id,suppressed) VALUES(?,?,?,1) ON CONFLICT(binding_id,message_id) DO UPDATE SET suppressed=1').run(id, value.messageId, value.requestId);
      return { persisted: false, suppressed: true };
    }
    const delivery: SuperagentDelivery = { botId: binding.bot_id, threadId: binding.thread_id, contextId: binding.context_id, requestId: value.requestId, sourceMessageId: request.source_message_id ?? undefined, messageId: value.messageId, text: value.text, purpose: value.purpose, ...(typeof value.ticketId === 'string' ? { ticketId: value.ticketId } : {}) };
    if (receipt?.suppressed) return { persisted: false, suppressed: true };
    this.db?.prepare('INSERT INTO deliveries(binding_id,message_id,request_id) VALUES(?,?,?) ON CONFLICT(binding_id,message_id) DO NOTHING').run(id, value.messageId, value.requestId);
    this.db?.prepare('UPDATE bindings SET needs_recovery=1 WHERE id=?').run(id);
    if (this.options.deliver && !receipt?.persisted) await this.options.deliver(delivery);
    const current = this.db?.prepare('SELECT active FROM bindings WHERE id=?').get(id) as { active: number } | undefined;
    const stopped = this.db?.prepare('SELECT status FROM requests WHERE binding_id=? AND request_id=?').get(id, value.requestId) as { status: string } | undefined;
    if (!current?.active || stopped?.status === 'stopped' || value.ticketId && this.ticketStopped(id, value.ticketId)) return { persisted: !!this.options.deliver, suppressed: true };
    this.db?.prepare('INSERT INTO deliveries(binding_id,message_id,request_id,persisted) VALUES(?,?,?,?) ON CONFLICT(binding_id,message_id) DO UPDATE SET persisted=excluded.persisted').run(id, value.messageId, value.requestId, this.options.deliver ? 1 : 0);
    for (const listener of this.listeners) listener({ type: 'reply', ...delivery, persisted: !!this.options.deliver });
    return { persisted: !!this.options.deliver };
  }
}

export function createSuperagentGateway(options: SuperagentGatewayOptions): SuperagentGateway { return new Gateway(options); }
