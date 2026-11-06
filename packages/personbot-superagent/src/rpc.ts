import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import type { Readable, Writable } from 'node:stream';

interface Deferred { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }

export class Peer {
  private buffer = '';
  private readonly decoder = new StringDecoder('utf8');
  private readonly pending = new Map<string, Deferred>();
  private closed = false;
  handler?: (method: string, params: unknown) => Promise<unknown>;
  notification?: (method: string, params: unknown) => void;

  private readonly input: Readable;
  private readonly output: Writable;

  constructor(input: Readable, output: Writable) {
    this.input = input;
    this.output = output;
    input.on('data', this.receive);
    input.on('error', this.fail);
    output.on('error', this.fail);
    input.on('end', this.end);
  }

  request(method: string, params?: unknown, timeoutMs = 120_000): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('Super Agent transport closed'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Super Agent ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: unknown): void { this.write({ jsonrpc: '2.0', method, params }); }

  close(error = new Error('Super Agent transport closed')): void {
    if (this.closed) return;
    this.closed = true;
    this.input.off('data', this.receive);
    this.input.off('error', this.fail);
    this.input.off('end', this.end);
    this.output.off('error', this.fail);
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }

  private readonly fail = (error: Error): void => { this.close(error); };
  private readonly end = (): void => { this.close(); };
  private readonly receive = (chunk: Buffer | string): void => {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    if (Buffer.byteLength(this.buffer) > 8 * 1024 * 1024) { this.close(new Error('Super Agent frame too large')); return; }
    let end: number;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      if (line.trim()) void this.dispatch(line);
    }
  };

  private async dispatch(line: string): Promise<void> {
    let value: Record<string, unknown>;
    try { value = JSON.parse(line) as Record<string, unknown>; } catch { this.close(new Error('Invalid Super Agent frame')); return; }
    if (!value || value.jsonrpc !== '2.0') { this.close(new Error('Invalid Super Agent RPC')); return; }
    if (typeof value.method === 'string') {
      if (typeof value.id !== 'string') { this.notification?.(value.method, value.params); return; }
      try {
        if (!this.handler) throw new Error('Super Agent handler unavailable');
        const result = await this.handler(value.method, value.params);
        this.write({ jsonrpc: '2.0', id: value.id, result: result ?? null });
      } catch (error) { this.write({ jsonrpc: '2.0', id: value.id, error: { code: -32000, message: String(error) } }); }
      return;
    }
    if (typeof value.id !== 'string') return;
    const pending = this.pending.get(value.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(value.id);
    if (value.error) pending.reject(new Error(String((value.error as { message?: string }).message ?? 'Super Agent RPC failed')));
    else pending.resolve(value.result);
  }

  private write(value: unknown): void {
    if (!this.closed && !this.output.destroyed && !this.output.writableEnded) this.output.write(`${JSON.stringify(value)}\n`);
  }
}
