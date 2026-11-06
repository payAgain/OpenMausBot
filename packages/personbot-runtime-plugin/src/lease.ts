import { tryLockExclusive } from '@deepseek-ai/node-addon-system/flock'
import { open, stat, type FileHandle } from 'node:fs/promises'

/** A kernel-owned lock survives a stalled holder and releases on process death. Never unlink its inode. */
export class RuntimeLease {
  private readonly handle: FileHandle
  private closing: Promise<void> | undefined

  private constructor(handle: FileHandle) {
    this.handle = handle
  }

  static async acquire(path: string): Promise<RuntimeLease> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const handle = await open(path, 'a+', 0o600)
      try {
        await tryLockExclusive(handle.fd)
        const held = await handle.stat({ bigint: true })
        const current = await stat(path, { bigint: true })
        if (held.ino === current.ino && held.dev === current.dev) return new RuntimeLease(handle)
      } catch (error) {
        await handle.close()
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'EAGAIN' || code === 'EWOULDBLOCK') throw new Error('personbot runtime is already running for this home')
        throw error
      }
      await handle.close()
    }
    throw new Error('personbot runtime lock inode changed during acquisition')
  }

  close(): Promise<void> {
    this.closing ??= this.handle.close()
    return this.closing
  }
}
