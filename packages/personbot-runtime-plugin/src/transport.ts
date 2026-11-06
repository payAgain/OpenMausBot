import type { Readable, Writable } from 'node:stream'
import { ProtocolError, parseRequest, type RpcId } from '@personbot/protocol'

export interface RuntimeTransportOptions {
  maxLineBytes?: number
  onFailure?: (error: Error) => void
}

interface PendingWrite {
  promise: Promise<void>
  resolve: () => void
  reject: (error: Error) => void
}

type RequestHandler = (method: string, params: Record<string, unknown>) => Promise<unknown>

/** Product JSON-RPC server over caller-owned NDJSON streams; close never destroys either stream. */
export class RuntimeTransport {
  private readonly input: Readable
  private readonly output: Writable
  private readonly maxLineBytes: number
  private readonly onFailure: ((error: Error) => void) | undefined
  private readonly writes = new Set<PendingWrite>()
  private buffer: Buffer = Buffer.alloc(0)
  private handler: RequestHandler | undefined
  private started = false
  private closed = false
  private failure: Error | undefined
  private outputAttached = false
  private outputClosed = false

  constructor(input: Readable, output: Writable, options: RuntimeTransportOptions = {}) {
    this.input = input
    this.output = output
    this.maxLineBytes = options.maxLineBytes ?? 8 * 1024 * 1024
    if (!Number.isSafeInteger(this.maxLineBytes) || this.maxLineBytes < 1) {
      throw new RangeError('maxLineBytes must be a positive safe integer')
    }
    this.onFailure = options.onFailure
  }

  start(): void {
    if (this.started || this.closed) return
    this.started = true
    this.attachOutput()
    this.input.on('data', this.receive)
    this.input.on('error', this.inputError)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.input.off('data', this.receive)
    this.input.off('error', this.inputError)
    this.buffer = Buffer.alloc(0)
    const error = this.failure ?? new Error('Runtime transport is closed')
    for (const write of this.writes) write.reject(error)
    this.detachOutputWhenSettled()
  }

  onRequest(handler: RequestHandler): void {
    this.handler = handler
  }

  notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })
  }

  async flush(): Promise<void> {
    if (this.failure) throw this.failure
    if (this.closed) throw new Error('Runtime transport is closed')
    if (this.output.destroyed || this.output.writableEnded) {
      const error = new Error('Runtime output is closed')
      this.fail(error)
      throw error
    }
    await Promise.all([...this.writes].map(write => write.promise))
  }

  private attachOutput(): void {
    if (this.outputAttached) return
    this.outputAttached = true
    this.output.on('error', this.outputError)
    this.output.on('close', this.outputClose)
  }

  private detachOutputWhenSettled(): void {
    if (!this.closed || (this.writes.size && !this.outputClosed)) return
    setImmediate(() => {
      if (!this.closed || (this.writes.size && !this.outputClosed)) return
      this.output.off('error', this.outputError)
      this.output.off('close', this.outputClose)
      this.outputAttached = false
    })
  }

  private readonly receive = (chunk: Buffer | string): void => {
    if (this.closed) return
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    let start = 0
    while (start < bytes.length) {
      const newline = bytes.indexOf(10, start)
      const end = newline < 0 ? bytes.length : newline
      const part = bytes.subarray(start, end)
      if (this.buffer.length + part.length > this.maxLineBytes) {
        this.fail(new Error('Runtime JSON-RPC frame exceeds maxLineBytes'))
        return
      }
      if (newline < 0) {
        this.buffer = Buffer.concat([this.buffer, part])
        return
      }
      const frame = this.buffer.length ? Buffer.concat([this.buffer, part]) : part
      this.buffer = Buffer.alloc(0)
      if (frame.length && frame.toString('utf8').trim()) void this.dispatch(frame.toString('utf8'))
      if (this.closed) return
      start = newline + 1
    }
  }

  private async dispatch(line: string): Promise<void> {
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      this.error(null, -32700, 'Invalid JSON')
      return
    }
    let id: RpcId | null = null
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const candidate = (value as Record<string, unknown>).id
      if ((typeof candidate === 'string' && candidate.length > 0 && candidate.length <= 256) ||
        (typeof candidate === 'number' && Number.isSafeInteger(candidate))) id = candidate
    }
    try {
      const request = parseRequest(value)
      if (!this.handler) throw new ProtocolError(-32601, 'Runtime request handler is unavailable')
      const result = await this.handler(request.method, request.params)
      this.write({ jsonrpc: '2.0', id: request.id, result: result === undefined ? null : result })
    } catch (error) {
      this.error(id, error instanceof ProtocolError ? error.code : -32000, error instanceof Error ? error.message : String(error))
    }
  }

  private error(id: RpcId | null, code: number, message: string): void {
    this.write({ jsonrpc: '2.0', id, error: { code, message } })
  }

  private write(value: unknown): void {
    if (this.closed) return
    if (this.output.destroyed || this.output.writableEnded) {
      this.fail(new Error('Runtime output is closed'))
      return
    }
    let line: string
    try {
      line = `${JSON.stringify(value)}\n`
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)))
      return
    }
    this.attachOutput()
    let resolve!: () => void
    let reject!: (error: Error) => void
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
    void promise.catch(() => {})
    const pending = { promise, resolve, reject }
    this.writes.add(pending)
    try {
      this.output.write(line, error => {
        this.writes.delete(pending)
        if (error) {
          pending.reject(error)
          this.fail(error)
        } else if (this.failure) pending.reject(this.failure)
        else pending.resolve()
        this.detachOutputWhenSettled()
      })
    } catch (error) {
      this.writes.delete(pending)
      const failure = error instanceof Error ? error : new Error(String(error))
      pending.reject(failure)
      this.fail(failure)
    }
  }

  private readonly inputError = (error: Error): void => { this.fail(error) }
  private readonly outputError = (error: Error): void => { this.fail(error) }
  private readonly outputClose = (): void => {
    this.outputClosed = true
    this.fail(new Error('Runtime output is closed'))
    this.detachOutputWhenSettled()
  }

  private fail(error: Error): void {
    if (this.closed) return
    this.failure = error
    this.close()
    try { this.onFailure?.(error) } catch {}
  }
}
