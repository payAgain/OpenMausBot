import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { MessageId, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-subagent'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { UserQuestionError, type AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import { EVENT_METHOD, PROTOCOL_VERSION, parseRequest, type CommandParamsMap, type QuestionResult } from '@personbot/protocol'
import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import { DSH_COMMIT, DSH_VERSION } from './launch.ts'
import { RuntimeLease } from './lease.ts'
import { PersonalRuntime } from './personal.ts'
import { RuntimeStore } from './store.ts'
import type { InputParams, SessionRow } from './store.ts'
import { TaskRuntime } from './tasks.ts'
import { RuntimeTransport } from './transport.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'personbot-supervisor': { kind: 'personbot-supervisor'; form: 'notice'; summary: string }
  }
}

export const name = 'personbot-protocol'
export const inject = ['agents', 'sessions', 'sessionPersistence', 'llm', 'tools']

export interface Config {
  home: string
  workspace: string
  provider: string
  model: string
}

interface PendingDecision {
  kind: 'approval' | 'question'
  sessionId: string
  rootSessionId: string
  payload: object
  settle(value: unknown): void
}

interface Jobs {
  list(caller: string): { id: string; owner?: string; status: string }[]
  wait(id: string, timeoutMs: number, caller: string): Promise<{ status: string }>
  kill(id: string, caller: string, reason: string): unknown
}

class PersonbotRuntime {
  readonly generation = randomUUID()
  private readonly store: RuntimeStore
  private readonly lease: RuntimeLease
  private readonly handles = new Map<string, AgentHandle>()
  private readonly opening = new Set<string>()
  private readonly delivered = new WeakMap<Agent, Set<string>>()
  private readonly serial = new Map<string, Promise<unknown>>()
  private readonly pending = new Map<string, PendingDecision>()
  private readonly closing = new AbortController()
  private readonly unregister: (() => void)[] = []
  private readonly parents = new Map<string, string>()
  private readonly ctx: Context
  private readonly config: Config
  private readonly transport: RuntimeTransport
  private readonly tasks: TaskRuntime
  private readonly personal: PersonalRuntime
  private initialized = false
  private initializing = false
  private eventSeq = 0
  private shutdownTask: Promise<void> | undefined

  constructor(
    ctx: Context,
    config: Config,
    transport: RuntimeTransport,
    lease: RuntimeLease,
  ) {
    this.ctx = ctx
    this.config = config
    this.transport = transport
    this.lease = lease
    this.store = new RuntimeStore(join(config.home, 'runtime', 'personbot.sqlite'))
    this.personal = new PersonalRuntime(ctx, config.home, config.workspace, {
      session: id => this.store.getSession(id),
      root: agent => this.owns(agent) ? this.rootId(agent) : undefined,
      task: id => this.tasks.taskForSession(id),
      changed: () => this.emit('personal.changed', {}),
    })
    this.tasks = new TaskRuntime(ctx, config.home, {
      session: id => this.store.getSession(id),
      create: task => this.exclusive(task.workerSessionId, async () => {
        const origin = this.store.getSession(task.originSessionId)
        if (!origin) throw new Error('Task origin Session is missing')
        const cwd = await this.personal.workspace(task, origin)
        await this.create({
          sessionId: task.workerSessionId, taskId: task.id, cwd,
          ...(task.projectId ? { projectId: task.projectId } : {}),
          ...(task.roleId ? { roleId: task.roleId } : {}),
        }, origin)
      }),
      submit: (input, executionId) => this.exclusive(input.sessionId, () => {
        if (executionId) {
          const task = this.tasks.taskForSession(input.sessionId)
          if (task?.lifecycle !== 'open' || task.currentExecutionId !== executionId ||
            !['queued', 'working', 'waiting_person'].includes(task.stage)) return Promise.resolve({ state: 'cancelled' })
        }
        return this.submit(input)
      }),
      hasInput: commandId => !!this.store.getInput(commandId),
      stop: id => this.exclusive(id, () => this.store.getSession(id)
        ? this.stop(id)
        : Promise.resolve({ sessionId: id, confirmed: true, errors: [] })),
      running: id => this.handles.get(id)?.agent.status === 'running',
      root: agent => this.owns(agent) ? this.rootId(agent) : undefined,
      taskRoot: agent => this.boundRootId(agent),
      emit: task => this.emit('task.changed', { task }, task.originSessionId),
      integrationsChanged: () => this.emit('integrations.changed', {}),
      binding: (taskId, source) => this.personal.taskBinding(taskId, source),
      artifacts: (taskId, executionId, ids) => this.personal.validateArtifacts(taskId, executionId, ids),
    })
    this.unregister.push(ctx.on('approval/request', async (request, next) => {
      if (!this.owns(request.agent)) return next()
      return this.approve(request)
    }))
    this.unregister.push(ctx.on('session/created', session => {
      if (session.header.origin === 'subagent' && session.header.parentSession) this.parents.set(session.id, session.header.parentSession)
    }))
    this.unregister.push(ctx.on('user-questions/request', async (request, next) => {
      if (request.agent === undefined || !this.owns(request.agent)) return next()
      const result = await this.decision('question', request.agent, { questions: request.questions }, request.signal)
      if (!result || typeof result !== 'object' || 'cancelled' in result) {
        throw new UserQuestionError('personbot question cancelled', 'ASK_CANCELLED')
      }
      return result as Exclude<QuestionResult, { cancelled: true }>
    }))
    this.unregister.push(ctx.on('session/event', (session, event) => {
      const agent = ctx.agents.get(session.id)
      if (agent === undefined || !this.owns(agent)) return
      this.emit('session.event', { event, durable: false }, session.id, event.seq)
    }))
    this.unregister.push(ctx.on('agent/status', ({ agent, status }) => {
      if (this.owns(agent)) {
        this.emit('session.status', { status }, agent.id)
        this.tasks.status(agent, status)
      }
    }))
    this.unregister.push(ctx.on('agent/assistant-stream', ({ agent, frame }) => {
      if (this.owns(agent)) this.emit('session.stream', frame, agent.id)
    }))
    this.unregister.push(ctx.on('agent/error', ({ agent, error }) => {
      if (this.owns(agent)) this.emit('session.error', { message: String(error) }, agent.id)
    }))
  }

  async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    const request = parseRequest({ jsonrpc: '2.0', id: 0, method, params })
    if (request.method === 'personbot.v1.initialize') {
      if (this.initialized || this.initializing) throw new Error('personbot runtime already initialized or initializing')
      this.initializing = true
      try {
        await this.ctx.get('loader')?.await()
        this.closing.signal.throwIfAborted()
        await this.ctx.llm.resolveCallConfig({ provider: this.config.provider, model: this.config.model })
        for (const entry of await this.ctx.sessionPersistence.list()) {
          if (entry.header.origin === 'subagent' && entry.header.parentSession) this.parents.set(entry.header.id, entry.header.parentSession)
        }
        this.closing.signal.throwIfAborted()
        this.initialized = true
        this.tasks.start()
        return {
          protocolVersion: PROTOCOL_VERSION,
          generation: this.generation,
          runtime: { name: 'personbot', dshVersion: DSH_VERSION, sourceReference: DSH_COMMIT },
          capabilities: ['native-sessions', 'followup', 'steer', 'approval', 'questions', 'session-tree-stop', 'durable-snapshots', 'persistent-tasks', 'task-reports', 'task-review', 'task-outbox', 'projects', 'roles', 'confirmed-memory', 'immutable-artifacts', 'task-workspaces', 'task-supplement', 'durable-triggers', 'source-subscriptions', 'source-schedules', 'channel-outbox'],
          provider: this.config.provider,
          model: this.config.model,
        }
      } finally {
        this.initializing = false
      }
    }
    if (request.method === 'personbot.v1.shutdown') {
      await this.shutdown()
      return {}
    }
    if (!this.initialized) throw new Error('Initialize personbot before sending commands')
    this.closing.signal.throwIfAborted()
    switch (request.method) {
      case 'personbot.v1.sessions.create':
        return this.exclusive(request.params.sessionId, () => {
          this.requireConversationControl(request.params.sessionId)
          return this.create(request.params)
        })
      case 'personbot.v1.sessions.resume':
        return this.exclusive(request.params.sessionId, async () => {
          this.requireConversationControl(request.params.sessionId)
          if (this.store.pendingStops(request.params.sessionId).length) throw new Error('Retry the unfinished stop command first')
          const handle = await this.open(request.params.sessionId)
          await this.recover(handle.agent)
          return this.sessionView(request.params.sessionId)
        })
      case 'personbot.v1.sessions.list':
        return { sessions: this.store.listSessions().map(row => this.sessionView(row.sessionId)) }
      case 'personbot.v1.messages.submit':
        return this.exclusive(request.params.sessionId, () => {
          this.requireConversationControl(request.params.sessionId)
          return this.submit(request.params)
        })
      case 'personbot.v1.sessions.stop':
        return this.exclusive(request.params.sessionId, async () => {
          this.requireConversationControl(request.params.sessionId)
          const previous = this.store.beginStop(request.params.commandId, request.params.sessionId)
          if (previous.result) return previous.result
          const result = await this.stop(request.params.sessionId)
          this.store.finishStop(request.params.commandId, result)
          return result
        })
      case 'personbot.v1.tasks.create':
        return this.tasks.create(request.params)
      case 'personbot.v1.tasks.list':
        return this.tasks.snapshot(request.params.originSessionId)
      case 'personbot.v1.tasks.control':
        return this.tasks.control(request.params)
      case 'personbot.v1.integrations.snapshot':
      case 'personbot.v1.sources.put':
      case 'personbot.v1.subscriptions.put':
      case 'personbot.v1.schedules.put':
      case 'personbot.v1.deliveries.control':
      case 'personbot.v1.sources.ingest':
        return this.tasks.integrationCommand(request)
      case 'personbot.v1.personal.snapshot':
        return this.personal.personal.snapshot()
      case 'personbot.v1.projects.put': {
        const result = await this.personal.personal.putProject(request.params)
        this.emit('personal.changed', {})
        return result
      }
      case 'personbot.v1.roles.put': {
        const result = this.personal.personal.putRole(request.params)
        this.emit('personal.changed', {})
        return result
      }
      case 'personbot.v1.memory.put': {
        const result = this.personal.personal.putMemory(request.params)
        this.emit('personal.changed', {})
        return result
      }
      case 'personbot.v1.memory.control': {
        const result = this.personal.personal.controlMemory(request.params)
        this.emit('personal.changed', {})
        return result
      }
      case 'personbot.v1.artifacts.list':
        return this.personal.artifacts.list(request.params)
      case 'personbot.v1.artifacts.publish':
        return this.personal.publish(request.params)
      case 'personbot.v1.artifacts.read':
        return this.personal.artifacts.read(request.params)
      case 'personbot.v1.approvals.resolve': {
        const decision = this.requireDecision(request.params.requestId, request.params.generation, 'approval')
        decision.settle(request.params.outcome)
        return { accepted: true }
      }
      case 'personbot.v1.questions.answer': {
        const decision = this.requireDecision(request.params.requestId, request.params.generation, 'question')
        const result = request.params.result
        if ('answers' in result) {
          const questions = (decision.payload as { questions: AskUserQuestionRequest['questions'] }).questions
          if (result.answers.length !== questions.length || !questions.every(q => result.answers.some(a => a.id === q.id))) {
            throw new Error('Answer each question exactly once')
          }
          for (const answer of result.answers) {
            const question = questions.find(q => q.id === answer.id)
            if (!question) throw new Error('Unknown question')
            if (!question.multiSelect && answer.selected.length > 1) throw new Error('Question permits one option')
            if (answer.selected.some(label => !question.options?.some(option => option.label === label))) {
              throw new Error('Answer contains an unknown option')
            }
          }
        }
        decision.settle(result)
        return { accepted: true }
      }
      case 'personbot.v1.snapshots.get':
        return this.snapshot(request.params)
    }
  }

  private exclusive<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const task = (this.serial.get(id) ?? Promise.resolve()).catch(() => {}).then(() => {
      this.closing.signal.throwIfAborted()
      return operation()
    })
    this.serial.set(id, task)
    void task.finally(() => { if (this.serial.get(id) === task) this.serial.delete(id) }).catch(() => {})
    return task
  }

  private requireConversationControl(id: string): void {
    if (this.tasks.taskForSession(id)) throw new Error('Task workers must be controlled through the task supervisor')
  }

  private async create(params: CommandParamsMap['personbot.v1.sessions.create'], inherited?: SessionRow) {
    const existingTask = this.tasks.taskForSession(params.sessionId)
    if (existingTask && existingTask.id !== params.taskId) throw new Error('Task worker Session belongs to the supervisor')
    if (params.conversationId && params.taskId) throw new Error('Session must have one owner')
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(params.sessionId)) throw new Error('Invalid session ID')
    const existing = this.store.getSession(params.sessionId)
    const binding = existing
      ? { projectId: existing.projectId, project: existing.project, roleId: existing.roleId, roleRevision: existing.roleRevision, roleInstructions: existing.roleInstructions }
      : inherited
        ? { projectId: params.projectId, project: inherited.project, roleId: inherited.roleId, roleRevision: inherited.roleRevision, roleInstructions: inherited.roleInstructions }
        : this.personal.binding(params)
    if (existing && (params.projectId !== existing.projectId || params.roleId !== existing.roleId)) {
      throw new Error('Session project and role bindings are immutable')
    }
    const projectPath = binding.project?.path
    const cwd = params.cwd ?? existing?.cwd ?? projectPath ?? this.config.workspace
    if (!isAbsolute(cwd) || !(await stat(cwd)).isDirectory()) throw new Error('Session cwd must be an absolute directory')
    const canonical = await realpath(cwd)
    if (!inherited && binding.project && canonical !== binding.project.path) throw new Error('A project Session must use its bound project directory')
    if (this.store.pendingStops(params.sessionId).length) throw new Error('Retry the unfinished stop command first')
    this.store.createSession({
      sessionId: params.sessionId,
      cwd: canonical,
      ...binding,
      ...(params.taskId ? { taskId: params.taskId } : { conversationId: params.conversationId ?? params.sessionId }),
    })
    const handle = await this.open(params.sessionId, false, true)
    await this.flush(handle.agent)
    this.store.markNativeReady(params.sessionId)
    await this.recover(handle.agent)
    return this.sessionView(params.sessionId)
  }

  private async open(id: string, clearInbox = false, allowCreate = false): Promise<AgentHandle> {
    const existing = this.handles.get(id)
    if (existing) return existing
    const row = this.store.getSession(id)
    if (!row) throw new Error(`Unknown personbot session: ${id}`)
    const sessionId = SessionId(id)
    const stored = await this.ctx.sessionPersistence.stat(sessionId)
    if (!stored && (!allowCreate || this.store.isNativeReady(id))) throw new Error(`Native history is missing for Session ${id}; refusing to replace its context`)
    if (stored?.header.origin === 'subagent') throw new Error('A native child cannot be opened as a root')
    const agentOptions = { provider: this.config.provider, model: this.config.model }
    const events = stored ? await this.readEvents(id) : []
    const known = new Set<string>(events.filter((e): e is SessionEvent<'user/message'> => e.type === 'user/message').map(e => e.data.id))
    const setup = (_ctx: Context, agent: Agent) => {
      if (clearInbox) {
        agent.inbox.clear()
        return
      }
      this.restoreInputs(agent, known)
    }
    this.opening.add(id)
    try {
      const handle = stored
        ? await this.ctx.agents.resume({ resumeSessionId: sessionId, agentOptions, setup })
        : await this.ctx.agents.create({ sessionId, meta: { cwd: row.cwd }, agentOptions, setup })
      this.handles.set(id, handle)
      this.delivered.set(handle.agent, known)
      await this.flush(handle.agent)
      this.store.markNativeReady(id)
      return handle
    } finally {
      this.opening.delete(id)
    }
  }

  private restoreInputs(agent: Agent, known: Set<string>): void {
    const inputs = this.store.recoveryInputs(agent.id)
    const order = new Map(inputs.map((input, index) => [input.messageId, index]))
    for (const message of agent.inbox.nextTurn.filter(message => message.source.kind === 'personbot-supervisor')) {
      agent.inbox.remove(message.id)
      agent.inbox.append('next-step', message)
    }
    for (const message of [...agent.inbox.nextTurn, ...agent.inbox.nextStep]) known.add(message.id)
    // dsh 0.2.2-rc.1 can persist an inbox claim before committing user/message.
    for (const [index, input] of inputs.entries()) {
      if (known.has(input.messageId)) continue
      const target = input.source === 'supervisor' || input.mode === 'steer' ? 'next-step' : 'next-turn'
      const queue = target === 'next-step' ? agent.inbox.nextStep : agent.inbox.nextTurn
      const next = queue.findIndex(message => (order.get(message.id) ?? -1) > index)
      agent.inbox.splice(target, next < 0 ? queue.length : next, 0, [this.message(input)])
      known.add(input.messageId)
    }
    for (const target of ['next-turn', 'next-step'] as const) {
      const queue = target === 'next-turn' ? agent.inbox.nextTurn : agent.inbox.nextStep
      const wakeable = new Set(inputs.filter(input => !input.source).map(input => input.messageId))
      const index = queue.findLastIndex(message => wakeable.has(message.id))
      if (index < 0) continue
      const message = queue[index]!
      agent.inbox.remove(message.id)
      // dsh 0.2.2-rc.1 setup runs under maintenance: send latches a wake until setup exits.
      agent.send(message, target, true)
      if (index !== queue.length - 1) agent.inbox.splice(target, index, queue.length - index, queue.slice(index))
      return
    }
  }

  private async submit(params: InputParams) {
    const input = this.store.beginInput(params, params.source ? undefined : () => this.personal.context(this.store.getSession(params.sessionId)!))
    if (input.state === 'cancelled') return { commandId: params.commandId, messageId: params.messageId, state: 'cancelled' }
    if (this.store.pendingStops(params.sessionId).length) {
      return { commandId: params.commandId, messageId: params.messageId, state: input.state }
    }
    if (input.state === 'queued') return { commandId: params.commandId, messageId: params.messageId, state: 'queued' }
    const handle = await this.open(params.sessionId)
    await this.recover(handle.agent)
    return { commandId: params.commandId, messageId: params.messageId, state: this.store.getInput(params.commandId)!.state }
  }

  private async recover(agent: Agent): Promise<void> {
    const inputs = this.store.pendingInputs(agent.id)
    if (!inputs.length) return
    const events = await this.readEvents(agent.id)
    const known = new Set([
      ...this.delivered.get(agent) ?? [],
      ...agent.inbox.nextTurn.map(m => m.id),
      ...agent.inbox.nextStep.map(m => m.id),
      ...events.filter((e): e is SessionEvent<'user/message'> => e.type === 'user/message').map(e => e.data.id),
    ])
    for (const input of inputs) {
      if (input.source === 'supervisor' && agent.status === 'running') continue
      if (!known.has(MessageId(input.messageId))) {
        const message = this.message(input)
        if (input.source === 'supervisor') agent.inject(message)
        else if (input.mode === 'steer') agent.steer(message)
        else agent.followup(message)
        known.add(message.id)
        this.delivered.set(agent, known)
      }
      await this.flush(agent)
      this.store.markQueued(input.commandId)
      this.emit('input.queued', { commandId: input.commandId, messageId: input.messageId }, agent.id)
    }
  }

  private message(input: InputParams): UserMessage {
    const context = input.source ? undefined : this.store.inputContext(input.commandId, () => this.personal.context(this.store.getSession(input.sessionId)!))
    const metadata = context ? {
      userBlock: 1, memories: context.memories,
      ...(context.roleId ? { roleId: context.roleId } : {}),
      ...(context.roleRevision === undefined ? {} : { roleRevision: context.roleRevision }),
    } : undefined
    const source = input.source === 'supervisor'
      ? { kind: 'personbot-supervisor' as const, form: 'notice' as const, summary: input.text.replace(/\s+/g, ' ').slice(0, 120) }
      : { kind: 'user' as const, ...(context?.text ? { personbotContext: metadata } : {}) }
    return Object.freeze<UserMessage>({
      role: 'user', id: MessageId(input.messageId),
      content: [...(context?.text ? [{ type: 'text' as const, text: context.text }] : []), { type: 'text', text: input.text }],
      source,
    })
  }

  private owns(agent: Agent): boolean {
    if (this.ctx.agents.get(agent.id) !== agent) return false
    return this.rootId(agent) !== undefined
  }

  private rootId(agent: Agent): string | undefined {
    let id: string = agent.id
    const visited = new Set<string>()
    while (!visited.has(id)) {
      visited.add(id)
      if (this.handles.has(id) || this.opening.has(id)) return id
      const parent = this.parents.get(id)
      if (!parent) return undefined
      id = parent
    }
    return undefined
  }

  private boundRootId(agent: Agent): string | undefined {
    let id: string = agent.id
    const visited = new Set<string>()
    while (!visited.has(id)) {
      visited.add(id)
      if (this.store.getSession(id)) return id
      const parent = this.parents.get(id)
      if (!parent) return undefined
      id = parent
    }
    return undefined
  }

  private approve(request: ApprovalRequest): Promise<ApprovalOutcome> {
    return this.decision('approval', request.agent, {
      toolName: request.toolName,
      ...(request.callId ? { callId: request.callId } : {}),
      ...(request.reason ? { reason: request.reason } : {}),
    }, request.signal).then(value =>
      value === 'allowed-once' || value === 'rejected' ? value : 'cancelled')
  }

  private decision(kind: PendingDecision['kind'], agent: Agent, payload: object, signal?: AbortSignal): Promise<unknown> {
    const requestId = randomUUID()
    const rootSessionId = this.rootId(agent)
    if (!rootSessionId) return Promise.reject(new Error('Decision has no owned root Session'))
    const lifetime = signal ? AbortSignal.any([this.closing.signal, signal]) : this.closing.signal
    if (lifetime.aborted) return Promise.resolve(kind === 'approval' ? 'cancelled' : { cancelled: true })
    return new Promise(resolve => {
      const settle = (value: unknown) => {
        if (!this.pending.delete(requestId)) return
        lifetime.removeEventListener('abort', aborted)
        this.emit(`${kind}.closed`, { requestId }, agent.id)
        this.tasks.waiting(rootSessionId, [...this.pending.values()].some(decision => decision.rootSessionId === rootSessionId))
        resolve(value)
      }
      const aborted = () => settle(kind === 'approval' ? 'cancelled' : { cancelled: true })
      this.pending.set(requestId, { kind, sessionId: agent.id, rootSessionId, payload, settle })
      this.tasks.waiting(rootSessionId, true)
      lifetime.addEventListener('abort', aborted, { once: true })
      this.emit(`${kind}.requested`, { requestId, rootSessionId, ...payload }, agent.id)
    })
  }

  private requireDecision(id: string, generation: string, kind: PendingDecision['kind']): PendingDecision {
    if (generation !== this.generation) throw new Error('Decision belongs to an expired runtime generation')
    const pending = this.pending.get(id)
    if (!pending || pending.kind !== kind) throw new Error('Decision is no longer pending')
    return pending
  }

  private async stop(id: string, preserveInput = false): Promise<{ sessionId: string; confirmed: boolean; errors: string[] }> {
    if (!this.store.getSession(id)) throw new Error(`Unknown personbot session: ${id}`)
    if (!preserveInput) this.store.cancelOutstanding(id)
    let handle = this.handles.get(id)
    if (!handle && !preserveInput && await this.ctx.sessionPersistence.stat(SessionId(id))) handle = await this.open(id, true)
    if (!handle) return { sessionId: id, confirmed: true, errors: [] }
    const root = handle.agent
    const members = this.ctx.agents.list().filter(agent => this.rootId(agent) === id)
    const errors: string[] = []
    const attempt = async (operation: () => unknown) => {
      try { await operation() } catch (error) { errors.push(String(error)) }
    }
    for (const agent of members) agent.cancel({ kind: 'user' }, { keepInbox: preserveInput && agent === root })
    for (const pending of this.pending.values()) {
      if (members.some(agent => agent.id === pending.sessionId)) pending.settle(pending.kind === 'approval' ? 'cancelled' : { cancelled: true })
    }
    await attempt(() => this.ctx.get('subagents')?.drainDescendants([root]))
    const jobs = this.ctx.get('jobs') as Jobs | undefined
    if (jobs) {
      await Promise.all(members.map(async agent => {
        const running = jobs.list(agent.id).filter(job => job.owner === agent.id && ['running', 'stopping'].includes(job.status))
        await Promise.all(running.map(async job => {
          const waited = jobs.wait(job.id, 10_000, agent.id).catch(error => { errors.push(String(error)) })
          await attempt(() => jobs.kill(job.id, agent.id, 'personbot stopped this session'))
          await attempt(async () => {
            const result = await waited
            if (result && ['running', 'stopping'].includes(result.status)) throw new Error(`Job ${job.id} did not stop`)
          })
        }))
      }))
    }
    root.cancel({ kind: 'user' }, { keepInbox: preserveInput })
    await attempt(() => root.whenIdle())
    if (preserveInput) this.store.requeueInputs(id, [...root.inbox.nextTurn, ...root.inbox.nextStep].map(message => message.id))
    await attempt(() => this.flush(root))
    // dsh 0.2.2-rc.1 closes subagent admission until this exact root is disposed.
    await attempt(() => handle.dispose())
    if (this.ctx.agents.get(root.id) !== root) this.handles.delete(id)
    else errors.push('Root Agent remains registered')
    const result = { sessionId: id, confirmed: errors.length === 0, errors }
    this.emit('session.stopped', result, id)
    return result
  }

  private async flush(agent: Agent): Promise<void> {
    if (!await this.ctx.sessions.flush(agent.session)) throw new Error('No session durability listener')
  }

  private async readEvents(id: string, offset = 0, limit?: number): Promise<readonly SessionEvent[]> {
    const handle = this.handles.get(id)
    if (handle) await this.flush(handle.agent)
    const stored = await this.ctx.sessionPersistence.open(SessionId(id), 'read')
    try { return (await stored.read(offset, limit)).events } finally { await stored.close() }
  }

  private sessionView(id: string) {
    const row = this.store.getSession(id)
    if (!row) throw new Error(`Unknown personbot session: ${id}`)
    const { roleInstructions: _roleInstructions, project: _project, ...summary } = row
    return { ...summary, status: this.handles.get(id)?.agent.status ?? 'closed', pendingStops: this.store.pendingStops(id) }
  }

  private async snapshot(params: CommandParamsMap['personbot.v1.snapshots.get']) {
    const id = params.sessionId
    const sessions = id ? [this.sessionView(id)] : this.store.listSessions().map(row => this.sessionView(row.sessionId))
    const logs = []
    if (id) {
      const limit = params.limit ?? 128
      const fromSeq = params.fromSeq ?? 0
      const page = await this.readEvents(id, fromSeq, limit + 1)
      const events: SessionEvent[] = []
      let bytes = 0
      for (const event of page.slice(0, limit)) {
        bytes += Buffer.byteLength(JSON.stringify(event))
        if (bytes > 4 * 1024 * 1024) {
          if (!events.length) throw new Error('Native event exceeds snapshot transport budget')
          break
        }
        events.push(event)
      }
      logs.push({ sessionId: id, events, nextSeq: fromSeq + events.length, hasMore: page.length > events.length })
    }
    return {
      generation: this.generation,
      eventSeq: this.eventSeq,
      sessions,
      logs,
      pending: [...this.pending].filter(([, decision]) => !id || decision.rootSessionId === id).map(([requestId, decision]) => ({
        requestId, generation: this.generation, kind: decision.kind, sessionId: decision.sessionId, rootSessionId: decision.rootSessionId, ...decision.payload,
      })),
    }
  }

  private emit(type: string, payload: unknown, sessionId?: string, nativeSeq?: number): void {
    this.transport.notify(EVENT_METHOD, {
      generation: this.generation,
      eventSeq: ++this.eventSeq,
      type,
      ...(sessionId ? { sessionId } : {}),
      ...(nativeSeq === undefined ? {} : { nativeSeq }),
      payload,
    })
  }

  shutdown(): Promise<void> {
    this.shutdownTask ??= this.dispose()
    return this.shutdownTask
  }

  private async dispose(): Promise<void> {
    this.closing.abort(new Error('personbot runtime shutting down'))
    await this.tasks.close()
    await Promise.allSettled(this.serial.values())
    const results = await Promise.allSettled([...this.handles.keys()].map(id => this.stop(id, true)))
    this.tasks.releaseGuard()
    for (const unregister of this.unregister.splice(0)) unregister()
    this.personal.close()
    this.store.close()
    await this.lease.close()
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : result.value.errors ?? [])
    if (errors.length) throw new AggregateError(errors, 'personbot runtime did not stop cleanly')
  }
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  let exiting = false
  let runtime: PersonbotRuntime
  const transport = new RuntimeTransport(process.stdin, process.stdout, {
    onFailure(error) {
      if (exiting) return
      exiting = true
      process.stderr.write(`${String(error)}\n`)
      void (async () => {
        await runtime.shutdown()
        await ctx.root.fiber.dispose()
        process.exit(1)
      })().catch(failure => { process.stderr.write(`${String(failure)}\n`); process.exit(1) })
    },
  })
  const lease = await RuntimeLease.acquire(join(config.home, 'runtime', 'runtime.lock'))
  try {
    runtime = new PersonbotRuntime(ctx, config, transport, lease)
  } catch (error) {
    await lease.close()
    transport.close()
    throw error
  }
  transport.onRequest(async (method, params) => {
    const result = await runtime.dispatch(method, params)
    if (method === 'personbot.v1.shutdown' && !exiting) {
      exiting = true
      setImmediate(() => {
        void (async () => {
          await transport.flush()
          await ctx.root.fiber.dispose()
          process.exit(0)
        })().catch(error => { process.stderr.write(`${String(error)}\n`); process.exit(1) })
      })
    }
    return result
  })
  ctx.effect(() => {
    transport.start()
    return async () => {
      try { await runtime.shutdown() } finally { transport.close() }
    }
  }, 'personbot.protocol')
}
