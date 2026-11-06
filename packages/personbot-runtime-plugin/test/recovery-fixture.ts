import { writeFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { RuntimeLease } from '../src/lease.ts'

export const name = 'personbot-recovery-fixture'
export const inject = ['sessions']

export function apply(ctx: Context): void {
  ctx.on('agent/pre-step', async (request, next) => {
    if (request.messages.some(message => message.source.kind === 'user' &&
      message.content.some(block => block.type === 'text' && block.text === 'echo claimed-input'))) {
      const marker = process.env.PERSONBOT_RECOVERY_MARKER
      if (!marker) throw new Error('Recovery fixture requires its isolated marker path')
      if (!await ctx.sessions.flush(request.agent.session)) throw new Error('Recovery fixture needs native persistence')
      await writeFile(marker, JSON.stringify({ sessionId: request.agent.id, messageIds: request.messages.map(message => message.id) }))
      await new Promise<never>((_resolve, reject) => {
        const abort = () => reject(new Error('Recovery fixture preparation aborted'))
        if (request.signal.aborted) abort()
        else request.signal.addEventListener('abort', abort, { once: true })
      })
    }
    return next()
  })
}

if (process.argv[2] === 'lease') {
  try {
    const lease = await RuntimeLease.acquire(process.argv[3]!)
    process.on('message', async message => {
      if (message !== 'release') return
      await lease.close()
      process.exit(0)
    })
    process.send?.({ state: 'acquired' })
  } catch (error) {
    process.send?.({ state: 'rejected', message: String(error) }, () => process.exit(0))
  }
}
