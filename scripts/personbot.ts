import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'
import { spawnRuntime } from '../packages/personbot-runtime-host/src/index.ts'
import { EVENT_METHOD, type RuntimeEvent } from '../packages/personbot-protocol/src/index.ts'
import { prepareRuntime } from '../packages/personbot-runtime-plugin/src/launch.ts'

const { values } = parseArgs({
  options: {
    home: { type: 'string' },
    workspace: { type: 'string' },
    provider: { type: 'string' },
    model: { type: 'string' },
    session: { type: 'string', default: 'main' },
    demo: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h' },
  },
})

if (values.help) {
  console.log(`Usage: pnpm personbot [--home PATH] [--workspace PATH] [--provider ID] [--model ID] [--session ID]
       pnpm personbot --demo

/stop                     stop this session's execution tree
/approve REQUEST_ID       allow the pending tool call once
/deny REQUEST_ID          reject the pending tool call
/answer REQUEST_ID JSON   answer questions with {"answers":[{"id":"...","selected":["..."]}]}
/sessions                 show session bindings and statuses
/quit                     flush and close the runtime

The demo uses a deterministic model in a disposable home. Try: echo hello, hold, approve, question.`)
  process.exit(0)
}

const temporary = values.demo && !values.home ? await mkdtemp(join(tmpdir(), 'personbot-demo-')) : undefined
const home = resolve(values.home ?? temporary ?? join(homedir(), '.personbot'))
const workspace = resolve(values.workspace ?? (temporary ? join(temporary, 'workspace') : process.cwd()))
await mkdir(workspace, { recursive: true })
const options = await prepareRuntime({
  home,
  workspace,
  provider: values.demo ? 'personbot-fixture' : values.provider ?? process.env.PERSONBOT_PROVIDER,
  model: values.demo ? 'fixture' : values.model ?? process.env.PERSONBOT_MODEL,
  fixture: values.demo,
})
const runtime = spawnRuntime({
  ...options,
  env: temporary ? { ...options.env, HOME: temporary } : options.env,
})
const input = createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY })
const lines = input[Symbol.asyncIterator]()
const decisions = new Map<string, { generation: string; kind: string }>()
let generation = ''
let failed = false

runtime.onNotification(notification => {
  if (notification.method !== EVENT_METHOD) return
  const event = notification.params as RuntimeEvent
  const payload = event.payload as Record<string, unknown> | undefined
  if (event.type === 'approval.requested' || event.type === 'question.requested') {
    const id = String(payload?.requestId)
    decisions.set(id, { generation: event.generation, kind: event.type })
    console.log(`\n[${event.type}] ${id}\n${JSON.stringify(payload, null, 2)}`)
    console.log(event.type === 'approval.requested' ? `/approve ${id}  or  /deny ${id}` : `/answer ${id} {"answers":[...]}`)
  } else if (event.type === 'approval.closed' || event.type === 'question.closed') {
    decisions.delete(String(payload?.requestId))
  } else if (event.type === 'session.event') {
    const native = payload?.event as { type: string; data: { message?: { content?: { type: string; text?: string }[] } } } | undefined
    if (native?.type === 'assistant/message') {
      const text = native.data.message?.content?.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
      if (text) console.log(`\n[${event.sessionId}] ${text}`)
    }
  } else if (event.type === 'session.error') {
    console.error(`[${event.sessionId}] ${String(payload?.message)}`)
  }
})

input.on('SIGINT', () => input.close())
void runtime.closed.then(exit => {
  if (exit.code !== 0 || exit.error) {
    failed = true
    console.error(`Runtime exited: ${exit.signal ?? exit.code}\n${runtime.stderrTail}`)
  }
  input.close()
})

try {
  const initialized = await runtime.request<{ generation: string }>('personbot.v1.initialize', { protocolVersion: 1 })
  generation = initialized.generation
  await runtime.request('personbot.v1.sessions.create', { sessionId: values.session, conversationId: values.session, cwd: workspace })
  console.log(`personbot · dsh 0.2.2-rc.1 · session ${values.session}\nHome: ${home}\nWorkspace: ${workspace}\nType a message, /stop or /quit.`)
  for await (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (line === '/quit') break
    try {
      if (line === '/stop') {
        console.log(await runtime.request('personbot.v1.sessions.stop', { commandId: randomUUID(), sessionId: values.session }))
      } else if (line === '/sessions') {
        console.log(JSON.stringify(await runtime.request('personbot.v1.sessions.list'), null, 2))
      } else if (line.startsWith('/approve ') || line.startsWith('/deny ')) {
        const id = line.slice(line.indexOf(' ') + 1).trim()
        const pending = decisions.get(id)
        if (!pending || pending.kind !== 'approval.requested') throw new Error('Approval is no longer pending')
        await runtime.request('personbot.v1.approvals.resolve', {
          requestId: id, generation: pending.generation, outcome: line.startsWith('/approve ') ? 'allowed-once' : 'rejected',
        })
      } else if (line.startsWith('/answer ')) {
        const rest = line.slice(8)
        const split = rest.indexOf(' ')
        if (split < 0) throw new Error('Use /answer REQUEST_ID JSON')
        const id = rest.slice(0, split)
        const pending = decisions.get(id)
        if (!pending || pending.kind !== 'question.requested') throw new Error('Question is no longer pending')
        await runtime.request('personbot.v1.questions.answer', {
          requestId: id, generation: pending.generation, result: JSON.parse(rest.slice(split + 1)) as unknown,
        })
      } else if (line.startsWith('/')) {
        throw new Error('Unknown command; use /stop, /sessions, /approve, /deny, /answer or /quit')
      } else {
        await runtime.request('personbot.v1.messages.submit', {
          commandId: randomUUID(), messageId: randomUUID(), sessionId: values.session, text: raw, mode: 'followup',
        })
      }
    } catch (error) {
      console.error(String(error))
    }
  }
} catch (error) {
  failed = true
  console.error(`${String(error)}\n${runtime.stderrTail}`)
} finally {
  input.close()
  await runtime.close({ graceMs: 15_000 })
  if (temporary) await rm(temporary, { recursive: true, force: true })
}

if (!generation || failed) process.exitCode = 1
