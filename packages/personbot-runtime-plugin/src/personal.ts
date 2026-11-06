import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { ArtifactStore } from '../../personbot-artifacts/src/index.ts'
import { PersonalStore, planTaskWorkspace, prepareTaskWorkspace } from '../../personbot-personal/src/index.ts'
import { parseRequest, type CommandParamsMap, type TaskRecord } from '../../personbot-protocol/src/index.ts'
import type { InputContext, SessionRow } from './store.ts'

interface PersonalPorts {
  session(id: string): SessionRow | undefined
  root(agent: Agent): string | undefined
  task(id: string): TaskRecord | undefined
  changed(): void
}

function identity(...parts: string[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 40)
}

/** Personal state augments native inputs and tools without running a second inference loop. */
export class PersonalRuntime {
  readonly personal: PersonalStore
  readonly artifacts: ArtifactStore
  private readonly unregister: (() => void)[] = []
  private readonly home: string
  private readonly ports: PersonalPorts

  constructor(ctx: Context, home: string, workspace: string, ports: PersonalPorts) {
    this.home = home
    this.ports = ports
    this.personal = new PersonalStore(home, { workspace })
    this.artifacts = new ArtifactStore(home)
    const output = {
      schema: { type: 'object', additionalProperties: true } as const,
      render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
    }
    const bound = (agent: Agent | undefined): SessionRow => {
      const id = agent ? ports.root(agent) : undefined
      const row = id ? ports.session(id) : undefined
      if (!row) throw new Error('This tool requires an owned Personbot Session')
      return row
    }
    this.unregister.push(ctx.tools.register({
      name: 'personbot_memory_search',
      description: 'Search confirmed personal and current-project memory. Unconfirmed proposals and forgotten or superseded facts are excluded.',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 40 } },
        required: ['query'],
      },
      output,
      execute: async (args, exec) => {
        exec.signal.throwIfAborted()
        const row = bound(exec.agent)
        const value = args as { query: string; limit?: number }
        if (typeof value.query !== 'string' || value.query.length > 8192) throw new Error('Invalid memory search query')
        return { memories: this.personal.search(value.query, row.projectId, value.limit) }
      },
    }))
    this.unregister.push(ctx.tools.register({
      name: 'personbot_memory_propose',
      description: 'Propose a durable personal or current-project fact or preference. It remains unconfirmed and cannot affect recall until the user confirms it in Personbot. Do not store credentials or infer consent.',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: { scope: { type: 'string', enum: ['personal', 'project'] }, key: { type: 'string' }, value: { type: 'string' } },
        required: ['scope', 'key', 'value'],
      },
      output,
      execute: async (args, exec) => {
        exec.signal.throwIfAborted()
        const row = bound(exec.agent)
        const value = args as { scope: 'personal' | 'project'; key: string; value: string }
        const id = identity(row.sessionId, exec.agent!.id, exec.callId ?? '')
        const request = parseRequest({
          jsonrpc: '2.0', id: 0, method: 'personbot.v1.memory.put',
          params: {
            ...value, ...(value.scope === 'project' ? { projectId: row.projectId } : {}),
            commandId: `memory-propose-${id}`, memoryId: `memory-${id}`,
          },
        })
        if (request.method !== 'personbot.v1.memory.put') throw new Error('Invalid memory proposal')
        const memory = this.personal.proposeMemory({ ...request.params, sourceSessionId: row.sessionId })
        ports.changed()
        return { memory }
      },
    }))
    this.unregister.push(ctx.tools.register({
      name: 'personbot_artifact_publish',
      description: 'Publish a regular file from this Session workspace as an immutable artifact. The user can preview or download its copied bytes later even if the source changes. A task report can reference its artifact id.',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: { path: { type: 'string' }, name: { type: 'string' } },
        required: ['path'],
      },
      output,
      execute: async (args, exec) => {
        exec.signal.throwIfAborted()
        const row = bound(exec.agent)
        const id = identity(row.sessionId, exec.agent!.id, exec.callId ?? '')
        const value = args as { path: string; name?: string }
        if (typeof value.path !== 'string') throw new Error('Artifact path is required')
        const artifact = await this.publish({
          ...value, path: resolve(exec.agent!.session.header.cwd ?? row.cwd, value.path), commandId: `artifact-publish-${id}`,
          artifactId: `artifact-${id}`, sessionId: row.sessionId,
        }, exec.signal)
        exec.signal.throwIfAborted()
        return { artifact }
      },
    }))
    this.unregister.push(ctx.tools.register({
      name: 'personbot_artifact_list',
      description: 'List immutable artifacts belonging to this conversation or task.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output,
      execute: async (_args, exec) => {
        exec.signal.throwIfAborted()
        const row = bound(exec.agent)
        return this.artifacts.list(row.taskId ? { taskId: row.taskId } : { sessionId: row.sessionId })
      },
    }))
  }

  binding(params: CommandParamsMap['personbot.v1.sessions.create']): Pick<SessionRow, 'projectId' | 'project' | 'roleId' | 'roleRevision' | 'roleInstructions'> {
    const project = params.projectId ? this.personal.getProject(params.projectId) : undefined
    if (params.projectId && !project) throw new Error('Unknown project')
    const role = params.roleId ? this.personal.getRole(params.roleId) : undefined
    if (params.roleId && !role) throw new Error('Unknown role')
    return {
      ...(project ? { projectId: project.id, project: { id: project.id, path: project.path, kind: project.kind } } : {}),
      ...(role ? { roleId: role.id, roleRevision: role.revision, roleInstructions: role.instructions } : {}),
    }
  }

  taskBinding(taskId: string, source: SessionRow): Pick<TaskRecord, 'projectId' | 'roleId' | 'workspace'> {
    const project = source.projectId ? this.personal.getProject(source.projectId) : undefined
    if (source.projectId && !project) throw new Error('Bound project is missing')
    return {
      ...(project ? { projectId: project.id, workspace: planTaskWorkspace(this.home, taskId, { ...project, ...source.project, path: source.project?.path ?? source.cwd }) } : {}),
      ...(source.roleId ? { roleId: source.roleId } : {}),
    }
  }

  async workspace(task: TaskRecord, origin: SessionRow): Promise<string> {
    return task.workspace ? prepareTaskWorkspace(task.workspace) : origin.cwd
  }

  context(row: SessionRow): InputContext {
    const active = this.personal.context(row.projectId)
    const text = [
      row.roleInstructions ? `Personbot role ${row.roleId} (frozen revision ${row.roleRevision}):\n${row.roleInstructions}` : '',
      row.projectId ? `Current Personbot project: ${row.projectId}. Session working directory: ${row.cwd}.` : '',
      active.text ? `Confirmed memory snapshot for this input. These current facts supersede conflicting older memory in the conversation. A forgotten fact is omitted from future recall; native history is preserved.\n${active.text}` : '',
    ].filter(Boolean).join('\n\n')
    return {
      text,
      ...(row.roleId ? { roleId: row.roleId } : {}),
      ...(row.roleRevision === undefined ? {} : { roleRevision: row.roleRevision }),
      memories: active.memories.map(({ id, revision }) => ({ id, revision })),
    }
  }

  async publish(params: CommandParamsMap['personbot.v1.artifacts.publish'], signal?: AbortSignal) {
    const request = parseRequest({ jsonrpc: '2.0', id: 0, method: 'personbot.v1.artifacts.publish', params })
    if (request.method !== 'personbot.v1.artifacts.publish') throw new Error('Invalid artifact publication')
    const row = this.ports.session(params.sessionId)
    if (!row) throw new Error('Unknown artifact Session')
    const task = row.taskId ? this.ports.task(row.sessionId) : undefined
    const previous = this.artifacts.get(params.artifactId)
    if (previous && previous.sessionId !== row.sessionId) throw new Error('Artifact belongs to another Session')
    const executionId = previous?.executionId ?? task?.currentExecutionId
    const admitted = () => {
      signal?.throwIfAborted()
      if (!row.taskId) return
      const current = this.ports.task(row.sessionId)
      if (!current || current.lifecycle !== 'open' || !executionId || current.currentExecutionId !== executionId ||
        !['queued', 'working', 'waiting_person'].includes(current.stage)) {
        throw new Error('Task execution no longer admits artifact publication')
      }
    }
    const artifact = await this.artifacts.publish({
      ...request.params, cwd: row.cwd, originSessionId: task?.originSessionId ?? row.sessionId,
      ...(row.taskId ? { taskId: row.taskId, executionId } : {}),
      ...(row.projectId ? { projectId: row.projectId } : {}),
    }, admitted)
    this.ports.changed()
    return artifact
  }

  validateArtifacts(taskId: string, executionId: string, ids: string[]): void {
    for (const id of ids) {
      const artifact = this.artifacts.get(id)
      if (!artifact || artifact.taskId !== taskId || artifact.executionId !== executionId) {
        throw new Error(`Artifact ${id} does not belong to this task execution`)
      }
    }
  }

  close(): void {
    for (const unregister of this.unregister.splice(0)) unregister()
    this.personal.close()
    this.artifacts.close()
  }
}
