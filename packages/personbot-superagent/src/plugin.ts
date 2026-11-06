import { randomUUID, createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { type GenerateOptions, type TokenUsage, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions';
import type {} from '@deepseek-ai/dsh-api-session-controller';
import type {} from '@deepseek-ai/dsh-user-approval';
import { z } from 'zod';
import type { SuperagentCaller, SuperagentInput, SuperagentInterrupt } from '../../../shared/superagent.ts';
import { parseProtocolAskQuestions, pickedOptionLabels, questionAnswersById, type ProtocolAskQuestion } from '../../../shared/ask-question.ts';
import { Runtime } from '../upstream/src/app/runtime.ts';
import { type DomainEvent, type OutboundMessage, type Ticket, type Trigger } from '../upstream/src/core/index.ts';
import { ticketCard } from '../upstream/src/app/cards.ts';
import { ticketOfSession, workerSessionId } from '../upstream/src/executor/dsh.ts';
import { runningJobs } from '../upstream/src/executor/background.ts';
import { tool, type Tool } from '../upstream/src/app/tools/tool.ts';
import type { SourceKind } from '../upstream/src/sources/kind.ts';
import type { ChildConfiguration } from './launch.ts';
import { Peer } from './rpc.ts';

export const name = 'openmausbot-superagent';
export const inject = ['agents', 'sessions', 'sessionController', 'sessionPersistence', 'workspaceRegistry', 'permissionPresets', 'tools', 'systemPrompt', 'skills', 'llm', 'subprocess', 'approval', 'userQuestions'];

interface Pending {
  kind: 'approval' | 'question';
  caller: SuperagentCaller;
  prompt: string;
  callId?: string;
  settle(value: unknown, behavior?: 'allow' | 'deny' | 'answer', reason?: string): void;
  questions?: readonly ProtocolAskQuestion[];
}

export async function apply(ctx: Context, config: ChildConfiguration): Promise<void> {
  const peer = new Peer(process.stdin, process.stdout);
  const pending = new Map<string, Pending>();
  const auxiliary = new Map<string, AbortController>();
  let runtime: Runtime;
  let latestRequestId = '';
  let approvalMode = config.approvalMode ?? 'ask';
  let instructions = config.instructions ?? '';
  let closed = false;
  const activeTools = new Map<string, string>();
  const stoppedRequests = new Set(config.stoppedRequestIds ?? []);
  const fencedRequests = new Set(config.fencedRequestIds ?? []);
  const stoppedTickets = new Set(config.stoppedTicketIds ?? []);
  const authorizations = new Map((config.requestAuthorizations ?? []).map(value => [value.requestId, value]));
  const consumed = new Map<string, string>();
  const consumedAdmissions = new Map<string, boolean>();
  const requestModes = new Map<string, string>();
  const auxiliaryContext = new AsyncLocalStorage<SuperagentCaller>();
  const masterWorkspaceContext = new AsyncLocalStorage<{ leaseId: string; active: boolean }>();
  const workspaceLeases = new Map<string, { leaseId: string; acquired: boolean; ready: Promise<void> }>();
  const masterLeases = new Map<string, { agentId: Agent['id']; leaseId: string }>();
  const emit = (value: Record<string, unknown>) => { peer.notify('event', value); };
  const ticketOf = (agent: Agent): string | undefined => {
    let current: Agent | undefined = agent;
    for (let depth = 0; current && depth < 16; depth++) {
      const ticketId = ticketOfSession(current.id);
      if (ticketId && runtime?.store.tickets.get(ticketId)) return ticketId;
      const parent: Agent['id'] | undefined = current.session.header.parentSession;
      current = parent ? ctx.agents.get(parent) : undefined;
    }
    return undefined;
  };
  const triggerRequest = (id: unknown): string | undefined => {
    const trigger = typeof id === 'string' ? runtime?.store.triggers.get(id) : undefined;
    return trigger?.source === 'openmausbot' && typeof trigger.meta.requestId === 'string' ? trigger.meta.requestId : undefined;
  };
  const publishTask = (ticket: Ticket) => {
    const triggerId = ticket.inputs.filter(input => input.kind === 'trigger').findLast(input => input.human && input.readAt !== null)?.triggerId ?? ticket.origin.triggerId;
    const trigger = runtime.store.triggers.get(triggerId);
    const requestId = String(trigger?.meta.requestId ?? latestRequestId);
    emit({ type: 'task', requestId, ticketId: ticket.id, title: ticket.title, state: ticketCard(ticket).state, ended: Boolean(ticket.ended), workspace: ticket.execution?.directory ?? config.workspace, sessionId: workerSessionId(ticket.id), sourceMessageId: trigger?.meta.sourceMessageId });
  };
  const admissionRevoked = (requestId: string) => stoppedRequests.has(requestId) || fencedRequests.has(requestId);
  const ticketRequests = (ticket: Ticket, consumedOnly = false): string[] => [
    ticket.origin.triggerId, ...ticket.origin.triggerIds,
    ...ticket.inputs.flatMap(input => input.kind === 'trigger' && (!consumedOnly || input.readAt !== null) ? [input.triggerId] : []),
  ].flatMap(triggerId => {
    const requestId = triggerRequest(triggerId);
    return requestId ? [requestId] : [];
  });
  const stoppedOriginRequest = (ticket: Ticket) => ticketRequests(ticket).find(requestId => stoppedRequests.has(requestId));
  const fenceAdmissions = async (ticketIds: Iterable<string>, requestStops: ReadonlyMap<string, string> = new Map()) => {
    const packets: Array<{ ticketId: string; requestIds: string[]; stoppedRequestId?: string }> = [];
    for (const ticketId of ticketIds) {
      const ticket = runtime.store.tickets.get(ticketId);
      if (!ticket) continue;
      const requestIds = new Set(ticketRequests(ticket, true));
      const stoppedRequestId = requestStops.get(ticketId);
      if (stoppedRequestId) requestIds.add(stoppedRequestId);
      for (const requestId of requestIds) fencedRequests.add(requestId);
      if (requestIds.size) {
        publishTask(ticket);
        packets.push({ ticketId, requestIds: [...requestIds], ...(stoppedRequestId ? { stoppedRequestId } : {}) });
      }
    }
    await Promise.all(packets.map(packet => peer.request('fence-admission', { bindingId: config.bindingId, ...packet })));
  };
  const consumedRequest = (text: string): string | undefined => {
    let value: { trigger_id?: unknown; trigger?: { trigger_id?: unknown }; ticket?: { ticket_id?: unknown } };
    try { value = JSON.parse(text) as typeof value; } catch { return undefined; }
    if (!value || typeof value !== 'object') return undefined;
    const direct = triggerRequest(value.trigger_id ?? value.trigger?.trigger_id);
    if (direct) return direct;
    const ticket = typeof value.ticket?.ticket_id === 'string' ? runtime?.store.tickets.get(value.ticket.ticket_id) : undefined;
    const input = ticket?.inputs.filter(input => input.kind === 'trigger').findLast(input => input.readAt !== null);
    return triggerRequest(input?.triggerId ?? ticket?.origin.triggerId);
  };
  const admissionPayload = (text: string): boolean => {
    try { return (JSON.parse(text) as { kind?: string } | null)?.kind === 'candidate'; } catch { return false; }
  };
  const consumingAdmission = (agent: Agent): boolean => {
    const claimed = consumedAdmissions.get(agent.id);
    if (claimed !== undefined) return claimed;
    for (const event of agent.session.snapshotEvents().toReversed()) {
      if (event.type === 'user/message' && event.data.source.kind === 'dsh-superagent') {
        return admissionPayload(event.data.content.filter(block => block.type === 'text').map(block => block.text).join('\n'));
      }
    }
    return false;
  };
  const requestOf = (agent?: Agent): string => {
    if (!agent) return '';
    const claimed = consumed.get(agent.id);
    if (claimed) return claimed;
    const ticketId = ticketOf(agent);
    const ticket = ticketId ? runtime?.store.tickets.get(ticketId) : undefined;
    const triggerId = ticket?.inputs.filter(input => input.kind === 'trigger').findLast(input => input.readAt !== null)?.triggerId ?? ticket?.origin.triggerId;
    if (triggerId) return triggerRequest(triggerId) ?? '';
    for (const event of agent.session.snapshotEvents().toReversed()) {
      if (event.type !== 'user/message' || event.data.source.kind !== 'dsh-superagent') continue;
      const request = consumedRequest(event.data.content.filter(block => block.type === 'text').map(block => block.text).join('\n'));
      if (request) return request;
    }
    return '';
  };
  const own = (agent: Agent) => agent.id === runtime?.masterId || ticketOf(agent) !== undefined;
  const callerOf = (agent: Agent): SuperagentCaller => {
    const requestId = requestOf(agent);
    const authorization = authorizations.get(requestId);
    const ticketId = ticketOf(agent);
    return {
      requestId, sourceMessageId: authorization?.sourceMessageId, authorizationVersion: authorization?.authorizationVersion ?? 0,
      agentId: agent.id, role: agent.id === runtime?.masterId ? 'master' : 'worker', ...(ticketId ? { ticketId } : {}),
    };
  };
  const permission = (agent?: Agent) => {
    const ticketId = agent && ticketOf(agent);
    const ticket = ticketId ? runtime?.store.tickets.get(ticketId) : undefined;
    const origin = ticket && runtime.store.triggers.get(ticket.origin.triggerId);
    const mode = ticket ? origin?.meta.approvalMode === 'full' && requestModes.get(requestOf(agent!)) === 'full' ? 'full' : 'ask'
      : (agent ? requestModes.get(requestOf(agent)) : undefined) ?? approvalMode;
    return mode === 'full' ? 'danger-full-access' : 'workspace-write';
  };
  const memory = (agent: Agent, operation: string, value: Record<string, unknown>) => {
    const caller = callerOf(agent);
    if (!caller.requestId || stoppedRequests.has(caller.requestId) || caller.ticketId && stoppedTickets.has(caller.ticketId)) throw new Error('Memory caller authorization is unavailable');
    if ((operation === 'remember' || operation === 'forget') && caller.role !== 'master') throw new Error('Workers may propose memory candidates to the main assistant, but cannot change personal memory');
    return peer.request('memory', { bindingId: config.bindingId, operation, ...value, caller });
  };
  const personalContext = () => [
      'You are operating inside an OpenMausBot personal conversation. Use the provided memory tools for durable user facts; task history remains task history.',
      'This installation uses a local workspace. GitHub, pull requests and remote accounts are optional; do not require or invent them.',
      'For a human question or ordinary conversation, route ignore then answer the original trigger with orchestrator_reply. For requested work, route accept and let its persistent worker execute. Send the final result with orchestrator_reply after the worker report.',
      'Personal memory writes require the current owner request and its exact quoted evidence. Workers have read-only memory tools; propose any durable-memory candidate to the main assistant instead. Forget only the content the owner explicitly asked to forget.',
      instructions,
    ].filter(Boolean).join('\n');
  const nativeTools = (agent: Agent): Tool[] => {
    const tools = [
      tool({ name: 'memory_search', description: 'Search the current Bot private long-term notes and the live original personal profile (omb.profile). The profile is retrieved on demand without a permanent copy. Tasks are searched separately with task_history_search.', schema: z.object({ query: z.string().max(500) }).strict(), execute: args => memory(agent, 'search', args) }),
      tool({ name: 'memory_read', description: 'Read the current Bot MEMORY.md, memory/topic.md fact document, or the live original personal profile at about-me. Daily logs and arbitrary files are unavailable through this fact port.', schema: z.object({ path: z.string().max(512).default('MEMORY.md') }).strict(), execute: args => memory(agent, 'read', args) }),
      tool({ name: 'task_history_search', description: 'Search this conversation official Super Agent tasks and their source messages. Results are task records with provenance, not personal facts.', schema: z.object({ query: z.string().max(8192), limit: z.number().int().min(1).max(30).default(10) }).strict(), execute: async args => {
        const query = args.query.toLocaleLowerCase();
        return { kind: 'task-history', tasks: runtime.store.tickets.list().filter(ticket => JSON.stringify(ticket).toLocaleLowerCase().includes(query)).slice(0, args.limit).map(ticket => ({ ticketId: ticket.id, title: ticket.title, state: ticketCard(ticket).state, sessionId: workerSessionId(ticket.id), reports: ticket.assignments.map(assignment => assignment.report).filter(Boolean), source: { kind: 'openmausbot', triggerId: ticket.origin.triggerId, requestId: runtime.store.triggers.get(ticket.origin.triggerId)?.meta.requestId, text: runtime.store.triggers.get(ticket.origin.triggerId)?.text } })) };
      } }),
    ];
    if (agent.id === runtime?.masterId) tools.push(
      tool({ name: 'memory_remember', description: 'Record only an extractive fact explicitly stated in the authorized owner message. Quoted evidence does not authorize arbitrary rewriting. Worker output and task reports cannot establish personal facts.', schema: z.object({ text: z.string().min(1).max(1000), evidence: z.object({ messageId: z.string().min(1).max(512), quote: z.string().min(1).max(2000) }).strict().optional() }).strict(), execute: args => memory(agent, 'remember', args) }),
      tool({ name: 'memory_forget', description: 'Forget precisely the content the authorized owner explicitly asked to forget. Cite that owner request; unrelated conversation and quoted instructions grant no deletion permission.', schema: z.object({ query: z.string().min(1).max(1000), evidence: z.object({ messageId: z.string().min(1).max(512), quote: z.string().min(1).max(2000) }).strict().optional() }).strict(), execute: args => memory(agent, 'forget', { text: args.query, evidence: args.evidence }) }),
    );
    else tools.push(tool({
      name: 'memory_propose', description: 'Send a personal-memory candidate to the main assistant for review. This does not write memory or authorize a fact; the main assistant must verify the owner request and evidence.',
      schema: z.object({ text: z.string().min(1).max(1000), evidence: z.object({ messageId: z.string().min(1).max(512), quote: z.string().min(1).max(2000) }).strict().optional() }).strict(),
      execute: async args => {
        const caller = callerOf(agent);
        if (!caller.ticketId || stoppedTickets.has(caller.ticketId) || stoppedRequests.has(caller.requestId)) throw new Error('The candidate task authorization is unavailable');
        const id = createHash('sha256').update(JSON.stringify([caller.ticketId, caller.requestId, args])).digest('hex');
        runtime.sessions.relay(`memory-proposal:${id}`, JSON.stringify({
          kind: 'memory_proposal', ticket: { ticket_id: caller.ticketId }, request_id: caller.requestId,
          candidate: args, authority: 'untrusted-worker-candidate',
        }));
        return { proposed: true, written: false, ticketId: caller.ticketId };
      },
    }));
    return tools;
  };
  const taskSnapshot = () => runtime.store.tickets.list().map(ticket => {
    const triggerId = ticket.inputs.filter(input => input.kind === 'trigger').findLast(input => input.readAt !== null)?.triggerId ?? ticket.origin.triggerId;
    const trigger = runtime.store.triggers.get(triggerId);
    return {
      ticketId: ticket.id, title: ticket.title, state: ticketCard(ticket).state, ended: Boolean(ticket.ended),
      requestId: String(trigger?.meta.requestId ?? ''), sourceMessageId: trigger?.meta.sourceMessageId,
      sessionId: workerSessionId(ticket.id), workspace: ticket.execution?.directory ?? config.workspace,
    };
  });
  const inspect = () => ({
    tasks: taskSnapshot(), pendingDeliveries: runtime.store.receipts.waiting().length, pendingDecisions: pending.size,
  });
  let lastActivity = '';
  const activity = () => {
    if (!runtime || closed) return;
    const snapshot = inspect();
    const value = { type: 'activity', requestId: latestRequestId, tasks: snapshot.tasks.filter(ticket => !ticket.ended).length, pendingDeliveries: snapshot.pendingDeliveries, pendingDecisions: snapshot.pendingDecisions };
    const fingerprint = JSON.stringify(value);
    if (lastActivity !== fingerprint) { lastActivity = fingerprint; emit(value); }
  };
  const acquire = async (kind: 'model' | 'workspace', packet: Record<string, unknown>, signal?: AbortSignal): Promise<void> => {
    signal?.throwIfAborted();
    const leaseId = String(packet.leaseId);
    let aborted: (() => void) | undefined;
    const cancellation = new Promise<never>((_resolve, reject) => {
      aborted = () => {
        peer.notify(`${kind}-cancel`, { bindingId: config.bindingId, leaseId });
        reject(signal?.reason ?? new Error('Native resource acquisition cancelled'));
      };
      signal?.addEventListener('abort', aborted, { once: true });
    });
    try {
      await Promise.race([peer.request(`${kind}-acquire`, { bindingId: config.bindingId, ...packet }, 24 * 60 * 60_000), cancellation]);
      signal?.throwIfAborted();
    } finally { if (aborted) signal?.removeEventListener('abort', aborted); }
  };
  const ensureWorkspace = async (agent: Agent, signal?: AbortSignal) => {
    const ticketId = ticketOf(agent);
    if (!ticketId) return;
    let lease = workspaceLeases.get(ticketId);
    if (!lease) {
      const caller = callerOf(agent);
      const created = { leaseId: randomUUID(), acquired: false, ready: Promise.resolve() };
      workspaceLeases.set(ticketId, created);
      created.ready = acquire('workspace', {
        leaseId: created.leaseId, requestId: caller.requestId, agentId: workerSessionId(ticketId), ticketId, mode: 'write',
      }, signal).then(() => { created.acquired = true; }).catch(error => {
        if (workspaceLeases.get(ticketId) === created) workspaceLeases.delete(ticketId);
        throw error;
      });
      lease = created;
    }
    await lease.ready;
  };
  const releaseQuietWorkspaces = () => {
    if (!runtime) return;
    for (const [ticketId, lease] of workspaceLeases) {
      if (!lease.acquired || runtime.executor.workspaceBusy(ticketId)) continue;
      workspaceLeases.delete(ticketId);
      void peer.request('workspace-release', { bindingId: config.bindingId, leaseId: lease.leaseId }).catch(() => {});
    }
    for (const [key, lease] of masterLeases) {
      if (ctx.agents.get(lease.agentId)?.status === 'running' || runningJobs(ctx, lease.agentId).length) continue;
      masterLeases.delete(key);
      void peer.request('workspace-release', { bindingId: config.bindingId, leaseId: lease.leaseId }).catch(() => {});
    }
  };
  const source: SourceKind = {
    kind: 'openmausbot', title: { zh: '原会话', en: 'OpenMausBot' }, description: { zh: '本地个人会话', en: 'Local personal conversation' },
    schema: z.object({}).strict(), fields: [], health: [],
    scope: input => admissionRevoked(String(input.meta.requestId ?? ''))
      ? { listened: false, reason: 'OpenMausBot source routing admission was revoked' }
      : { listened: true, observed: false },
    policy: { schema: z.object({ allowed: z.array(z.object({ id: z.string(), name: z.string().optional() })).default([{ id: 'owner' }]) }), fields: [], explicit: { zh: '会话所有者直接发送', en: 'Conversation owner direct message' } },
    channel: {
      link: () => ({ url: '', label: { zh: '原会话', en: 'Original conversation' } }),
      send: async (_host, message: OutboundMessage) => {
        const ticket = message.ticketId ? runtime.store.tickets.get(message.ticketId) : undefined;
        const worker = ticket && ctx.agents.get(workerSessionId(ticket.id) as Agent['id']);
        if (worker && (message.purpose === 'result' || message.purpose === 'attention')) await ctx.sessions.flush(worker.session);
        const reportAt = ticket?.assignments.findLast(assignment => assignment.report)?.report?.at;
        const triggerId = message.sourceTriggerId ?? (message.purpose === 'attention' && ticket?.attention?.triggerId ? ticket.attention.triggerId
          : message.purpose === 'result' || message.purpose === 'attention'
            ? ticket?.inputs.filter(input => input.kind === 'trigger').findLast(input => input.human && input.readAt !== null && (!reportAt || input.at <= reportAt))?.triggerId : undefined);
        const requestId = (triggerId ? runtime.store.triggers.get(triggerId)?.meta.requestId : undefined) ?? message.channel.address.requestId ?? latestRequestId;
        const receipt = await peer.request('deliver', { bindingId: config.bindingId, requestId, messageId: message.id, text: message.text, purpose: message.purpose ?? message.kind, ticketId: message.ticketId });
        if (!(receipt as { suppressed?: boolean })?.suppressed && message.kind === 'reply') emit({ type: 'completed', requestId, sessionId: message.ticketId ? workerSessionId(message.ticketId) : runtime.masterId });
        return 'sent';
      },
    },
    threadContext: {
      messageId: trigger => trigger.id,
      read: async (_commands, trigger) => ({ messages: [{ id: trigger.id, from: 'owner', at: trigger.at, text: trigger.text }], body: { source: 'openmausbot' } }),
    },
  };
  const domain = (event: DomainEvent) => {
    const ticketId = 'ticketId' in event.data ? String(event.data.ticketId) : undefined;
    const ticket = ticketId ? runtime.store.tickets.get(ticketId) : undefined;
    if (!ticket) return;
    publishTask(ticket);
    activity();
  };
  runtime = new Runtime(ctx, {
    stateDir: join(config.home, 'state'), localWorkspace: config.workspace,
    promptMaxChars: { get: () => 100_000 }, admissionContextMaxPages: { get: () => 10 }, admissionContextTimeoutMs: { get: () => 15_000 },
  }, () => { throw new Error('Restart the managed runtime to apply deployment changes'); }, {
    managementHttp: false, permissionPreset: permission, promptSuffix: personalContext, additionalTools: nativeTools,
    additionalWorkerToolNames: ['ask_user_question'], onDomainEvent: domain,
    beforeResume: async () => {
      const requestStops = new Map<string, string>();
      for (const ticket of runtime.store.tickets.list()) {
        const requestId = stoppedOriginRequest(ticket);
        if (requestId) { stoppedTickets.add(ticket.id); requestStops.set(ticket.id, requestId); }
        if (config.stopBeforeRecovery) stoppedTickets.add(ticket.id);
      }
      await fenceAdmissions(stoppedTickets, requestStops);
      for (const ticketId of stoppedTickets) runtime.engine.stopTicket(ticketId, 'Stopped from the original conversation before recovery');
    },
  });
  const unsource = runtime.sources.register(source);
  const saved = runtime.store.settings();
  runtime.store.saveSettings({ ...saved, sources: { ...saved.sources, openmausbot: { enabled: true, config: {} } }, policy: { ...saved.policy, sources: { ...saved.policy.sources, openmausbot: { allowed: [{ id: 'owner' }], admission: {} } } }, eval: { ...saved.eval, model: { provider: config.provider, model: config.model } }, executor: { ...saved.executor, model: { provider: config.provider, model: config.model } } });
  const prior = runtime.store.db.prepare("SELECT value FROM trigger WHERE value ->> '$.source' = 'openmausbot' ORDER BY at DESC LIMIT 1").get() as { value: string } | undefined;
  if (prior) latestRequestId = String((JSON.parse(prior.value) as Trigger).meta.requestId ?? '');
  for (const row of runtime.store.db.prepare("SELECT value FROM trigger WHERE value ->> '$.source' = 'openmausbot'").all()) {
    const trigger = JSON.parse(String(row.value)) as Trigger;
    if (typeof trigger.meta.requestId === 'string' && typeof trigger.meta.approvalMode === 'string') requestModes.set(trigger.meta.requestId, trigger.meta.approvalMode);
  }
  const ready = runtime.ready;
  const decide = (kind: Pending['kind'], agent: Agent, prompt: string, signal?: AbortSignal, questions?: unknown, callId?: string): Promise<unknown> => {
    const decisionId = randomUUID();
    const caller = callerOf(agent);
    if (!caller.requestId || stoppedRequests.has(caller.requestId) || caller.ticketId && stoppedTickets.has(caller.ticketId)) return Promise.resolve(kind === 'approval' ? 'cancelled' : undefined);
    if (kind === 'approval') prompt = `Execution directory: ${config.workspace}\n${prompt}`;
    return new Promise(resolve => {
      const settle: Pending['settle'] = (value, behavior, reason) => {
        if (!pending.delete(decisionId)) return;
        signal?.removeEventListener('abort', abort);
        emit({ type: 'decision.resolved', requestId: caller.requestId, decisionId, behavior, reason });
        activity();
        resolve(value);
      };
      const abort = () => settle(kind === 'approval' ? 'cancelled' : undefined, 'deny', 'Native operation was cancelled');
      pending.set(decisionId, { kind, caller, prompt, callId, settle, questions: parseProtocolAskQuestions(questions) ?? undefined });
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener('abort', abort, { once: true });
      emit({ type: kind, ...caller, decisionId, prompt, callId });
      activity();
    });
  };
  const disposers = [
    ctx.on('approval/request', (request, next) => own(request.agent) ? decide('approval', request.agent, JSON.stringify({ toolName: request.toolName, reason: request.reason, callId: request.callId }), request.signal, undefined, request.callId) as Promise<'allowed-once' | 'rejected' | 'cancelled'> : next()),
    ctx.on('user-questions/request', async (request, next) => {
      if (!request.agent || !own(request.agent)) return next();
      const answer = await decide('question', request.agent, JSON.stringify(request.questions), request.signal, request.questions);
      if (!answer) throw new UserQuestionError('OpenMausBot question cancelled', 'ASK_CANCELLED');
      return answer as { answers: { id: string; selected: string[]; custom?: string }[] };
    }),
    ctx.on('agent/assistant-stream', ({ agent, frame }) => {
      if (!own(agent) || frame.type !== 'chunk' || frame.chunk.type !== 'text-delta') return;
      emit({ type: 'text', requestId: requestOf(agent), text: frame.chunk.text, sessionId: agent.id });
    }),
    ctx.on('agent/inbox/claimed', ({ agent, message }) => {
      if (!own(agent) || message.source.kind !== 'dsh-superagent') return;
      const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
      consumedAdmissions.set(agent.id, admissionPayload(text));
      const requestId = consumedRequest(text);
      if (requestId) consumed.set(agent.id, requestId);
    }),
    ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      if (own(agent)) {
        ctx.permissionPresets.set(agent.session, permission(agent));
        await ensureWorkspace(agent, signal);
      }
      return next();
    }),
    ctx.on('tools/execute', async (execution, next) => {
      const agent = execution.agent;
      if (!agent || agent.id !== runtime.masterId || masterWorkspaceContext.getStore()?.active
        || execution.name.startsWith('orchestrator_') || execution.name.startsWith('memory_')
        || ['task_history_search', 'read', 'read_image', 'glob', 'grep', 'web_search', 'web_fetch', 'skill', 'job_list', 'job_output', 'job_kill'].includes(execution.name)) return next();
      const caller = callerOf(agent);
      if (admissionRevoked(caller.requestId)) throw new Error('This source no longer authorizes main-assistant workspace mutations');
      const leaseId = randomUUID();
      await acquire('workspace', { leaseId, requestId: caller.requestId, agentId: agent.id, mode: 'write' }, execution.signal);
      const scope = { leaseId, active: true };
      try { return await masterWorkspaceContext.run(scope, next); }
      finally {
        scope.active = false;
        if (runningJobs(ctx, agent.id).length) masterLeases.set(leaseId, { agentId: agent.id, leaseId });
        else await peer.request('workspace-release', { bindingId: config.bindingId, leaseId }).catch(() => {});
      }
    }),
    ctx.on('llm/stream', (options, next) => {
      const agent = options.sessionId ? ctx.agents.get(options.sessionId) : undefined;
      const caller = agent && own(agent) ? callerOf(agent) : auxiliaryContext.getStore()
        ?? { requestId: `auxiliary-${randomUUID()}`, agentId: 'upkeep', role: 'upkeep' as const, authorizationVersion: 0 };
      const leaseId = randomUUID();
      return (async function* (): AsyncIterable<StreamChunk> {
        let acquired = false;
        let usage: TokenUsage | undefined;
        try {
          await acquire('model', {
            leaseId, requestId: caller.requestId, agentId: caller.agentId, role: caller.role, ticketId: caller.ticketId,
            provider: options.provider, model: options.model,
            ...(caller.role === 'master' && agent ? { routingAdmission: consumingAdmission(agent) } : {}),
          }, options.signal);
          acquired = true;
          for await (const chunk of next()) {
            if (chunk.type === 'usage') usage = chunk.usage;
            yield chunk;
          }
        } finally {
          if (acquired) {
            await peer.request('model-release', {
              bindingId: config.bindingId, leaseId,
              ...(usage ? { usage: { usageId: leaseId, requestId: caller.requestId, agentId: caller.agentId, role: caller.role, ticketId: caller.ticketId, provider: options.provider, model: options.model, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens, cacheWriteTokens: usage.cacheWriteTokens } } : {}),
            }).catch(error => { if (!closed) throw error; });
          }
        }
      })();
    }, { global: true }),
    ctx.on('session/event', (session, event) => {
      const agent = ctx.agents.get(session.id);
      if (!agent || !own(agent)) return;
      if (event.type === 'tool/call') {
        activeTools.set(event.data.callId, event.data.name);
        emit({ type: 'tool', requestId: requestOf(agent), callId: event.data.callId, name: event.data.name, phase: 'start', input: event.data.arguments });
      } else if (event.type === 'tool/result') {
        const callId = event.data.message.toolCallId;
        emit({ type: 'tool', requestId: requestOf(agent), callId, name: activeTools.get(callId) ?? 'tool', phase: 'end', output: event.data.message });
      }
    }),
    ctx.on('agent/error', ({ agent, error }) => { if (own(agent)) emit({ type: 'failed', requestId: requestOf(agent), error: String(error) }); }),
  ];
  const timer = setInterval(() => { activity(); releaseQuietWorkspaces(); }, 200);
  timer.unref();
  peer.notification = (method, params) => { if (method === 'cancel-generate') auxiliary.get((params as { requestId: string }).requestId)?.abort(); };
  peer.handler = async (method, params) => {
    await ready;
    if (method === 'initialize') {
      for (const task of taskSnapshot()) emit({ type: 'task', ...task });
      activity();
      return { upstream: '8c32a9dc5d72c033816c6a8110b37f40cf94fba4', masterId: runtime.masterId, configured: runtime.configured(), ...inspect() };
    }
    if (method === 'inspect') return inspect();
    if (method === 'submit') {
      if (closed) throw new Error('Runtime is closed');
      const input = params as Omit<SuperagentInput, 'botId' | 'threadId'>;
      if (!input || typeof input.requestId !== 'string' || typeof input.text !== 'string') throw new TypeError('Invalid input');
      latestRequestId = input.requestId;
      authorizations.set(input.requestId, { requestId: input.requestId, sourceMessageId: input.sourceMessageId, authorizationVersion: input.authorizationVersion ?? 0 });
      approvalMode = input.approvalMode ?? 'ask';
      requestModes.set(input.requestId, approvalMode);
      if (input.instructions !== undefined) instructions = input.instructions;
      const selected = await ctx.llm.resolveCallConfig({ provider: config.provider, model: config.model });
      for (const agent of ctx.agents.list()) if (own(agent)) {
        agent.session.append('model/selection', { provider: selected.provider, model: selected.model });
      }
      const id = createHash('sha256').update(JSON.stringify([config.bindingId, input.requestId])).digest('hex');
      const trigger: Trigger = { id, source: 'openmausbot', actor: { source: 'openmausbot', id: 'owner' }, human: true, addressed: 'direct', at: new Date().toISOString(), text: input.text, threads: [{ source: 'openmausbot', id: config.bindingId }], channel: { source: 'openmausbot', thread: config.bindingId, address: { bindingId: config.bindingId, requestId: input.requestId } }, meta: { requestId: input.requestId, sourceMessageId: input.sourceMessageId, approvalMode } };
      emit({ type: 'started', requestId: input.requestId, sessionId: runtime.masterId });
      return { received: runtime.receive(trigger) };
    }
    if (method === 'interrupt') {
      const value = params as (Partial<SuperagentInterrupt> & { stoppedRequestIds?: string[]; stoppedTicketIds?: string[]; fencedRequestIds?: string[] }) | undefined;
      for (const requestId of value?.stoppedRequestIds ?? []) { stoppedRequests.add(requestId); authorizations.delete(requestId); }
      for (const requestId of value?.fencedRequestIds ?? []) fencedRequests.add(requestId);
      for (const ticketId of value?.stoppedTicketIds ?? []) stoppedTickets.add(ticketId);
      const selected = new Set(runtime.store.tickets.list().filter(ticket => {
        if (ticket.ended?.by === 'human') return false;
        if (!value?.scope || value.scope === 'conversation') return true;
        if (value.scope === 'task') return ticket.id === value.ticketId;
        return ticketRequests(ticket).includes(value.requestId ?? '');
      }).map(ticket => ticket.id));
      for (const ticketId of selected) stoppedTickets.add(ticketId);
      const fencedTickets = new Set(value?.stoppedTicketIds ?? []);
      if (value?.scope === 'task' && value.ticketId) fencedTickets.add(value.ticketId);
      const requestStops = new Map<string, string>();
      for (const ticketId of selected) {
        const ticket = runtime.store.tickets.get(ticketId)!;
        const requestId = value?.scope === 'request' ? value.requestId : stoppedOriginRequest(ticket);
        if (requestId) { fencedTickets.add(ticketId); requestStops.set(ticketId, requestId); }
      }
      await fenceAdmissions(fencedTickets, requestStops);
      for (const ticketId of selected) runtime.engine.stopTicket(ticketId, 'Stopped from the original conversation');
      for (const decision of pending.values()) {
        if (selected.has(decision.caller.ticketId ?? '') || stoppedRequests.has(decision.caller.requestId)) decision.settle(decision.kind === 'approval' ? 'cancelled' : undefined, 'deny', 'Task authorization was revoked');
      }
      for (const agent of ctx.agents.list()) {
        if (!own(agent)) continue;
        if (!value?.scope || value.scope === 'conversation' || selected.has(ticketOf(agent) ?? '')) {
          agent.cancel({ kind: 'user' });
          continue;
        }
        if (agent.id !== runtime.masterId) continue;
        for (const message of [...agent.inbox.nextStep, ...agent.inbox.nextTurn]) {
          const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
          const requestId = consumedRequest(text);
          if (requestId && (stoppedRequests.has(requestId) || fencedRequests.has(requestId) && admissionPayload(text))) agent.inbox.remove(message.id);
        }
        const requestId = requestOf(agent);
        if (stoppedRequests.has(requestId) || fencedRequests.has(requestId) && consumingAdmission(agent)) agent.cancel({ kind: 'user' }, { keepInbox: true });
      }
      await runtime.pump();
      activity();
      return true;
    }
    if (method === 'respond') {
      const value = params as { decisionId: string; behavior: string; message?: string };
      const decision = pending.get(value.decisionId);
      if (!decision) return false;
      if (!['allow', 'deny', 'answer'].includes(value.behavior)
        || decision.kind === 'approval' && value.behavior === 'answer'
        || decision.kind === 'question' && value.behavior === 'allow') return false;
      if (stoppedRequests.has(decision.caller.requestId) || decision.caller.ticketId && stoppedTickets.has(decision.caller.ticketId)) {
        decision.settle(decision.kind === 'approval' ? 'cancelled' : undefined, 'deny', 'Task authorization was revoked');
        return false;
      }
      if (decision.kind === 'approval') decision.settle(value.behavior === 'allow' ? 'allowed-once' : 'rejected', value.behavior === 'allow' ? 'allow' : 'deny');
      else if (value.behavior === 'answer') {
        const questions = decision.questions ?? [];
        const answers = questionAnswersById(value.message ?? '', questions);
        decision.settle({ answers: questions.flatMap(({ id, question }) => {
          const answer = answers[id];
          if (answer === undefined) return [];
          const picked = pickedOptionLabels(answer, question);
          return [{ id, selected: picked.labels, ...(picked.other ? { custom: picked.other } : {}) }];
        }) }, 'answer');
      } else decision.settle(undefined, 'deny');
      return true;
    }
    if (method === 'generate') {
      const value = params as { prompt: string; requestId: string };
      const controller = new AbortController();
      auxiliary.set(value.requestId, controller);
      try {
        const request: GenerateOptions = { provider: config.provider, model: config.model, messages: [{ role: 'user', content: [{ type: 'text', text: value.prompt }] }], tools: [], signal: controller.signal, maxTokens: 8192 };
        return await auxiliaryContext.run({ requestId: value.requestId, agentId: 'upkeep', role: 'upkeep', authorizationVersion: 0 }, async () => {
          let text = '';
          for await (const chunk of ctx.llm.stream(request)) {
            if (chunk.type === 'text-delta') text += chunk.text;
            if (chunk.type === 'tool-call-delta') throw new Error('Auxiliary generation cannot call tools');
          }
          return text;
        });
      } finally { auxiliary.delete(value.requestId); }
    }
    if (method === 'shutdown') {
      closed = true;
      for (const decision of pending.values()) decision.settle(undefined);
      for (const controller of auxiliary.values()) controller.abort();
      await runtime.stop();
      clearInterval(timer);
      for (const lease of workspaceLeases.values()) await peer.request('workspace-release', { bindingId: config.bindingId, leaseId: lease.leaseId }).catch(() => {});
      workspaceLeases.clear();
      for (const lease of masterLeases.values()) await peer.request('workspace-release', { bindingId: config.bindingId, leaseId: lease.leaseId }).catch(() => {});
      masterLeases.clear();
      return true;
    }
    throw new Error(`Unknown Super Agent operation ${method}`);
  };
  ctx.effect(() => async () => {
    closed = true;
    clearInterval(timer);
    for (const decision of pending.values()) decision.settle(undefined);
    await runtime.stop();
    for (const dispose of disposers) dispose();
    unsource();
    peer.close();
  });
  await ready;
}
