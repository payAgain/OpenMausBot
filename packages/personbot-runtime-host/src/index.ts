import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export interface RuntimeOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  defaultTimeoutMs?: number;
  maxLineBytes?: number;
  stderrLimitBytes?: number;
  onNotificationError?: (error: Error) => void;
}

export interface RequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface CloseOptions {
  shutdownMethod?: string | null;
  graceMs?: number;
  terminateMs?: number;
}

export interface RuntimeExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

export interface RuntimeNotification {
  method: string;
  params?: unknown;
}

export class RuntimeRpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'RuntimeRpcError';
    this.code = code;
    this.data = data;
  }
}

export class RuntimeProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeProtocolError';
  }
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}

function milliseconds(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 2_147_483_647) {
    throw new RangeError(`${label} must be a finite non-negative timer duration`);
  }
  return value;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive integer`);
  }
  return value;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/** Owns one child process and its newline-delimited JSON-RPC connection. */
export class RuntimeHost {
  readonly closed: Promise<RuntimeExit>;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly defaultTimeoutMs: number;
  private readonly maxLineBytes: number;
  private readonly stderrLimitBytes: number;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly listeners = new Set<(notification: RuntimeNotification) => void>();
  private stdoutBuffer: Buffer = Buffer.alloc(0);
  private stderrBuffer: Buffer = Buffer.alloc(0);
  private nextId = 1;
  private failure: Error | undefined;
  private exit: RuntimeExit | undefined;
  private closing = false;
  private closePromise: Promise<RuntimeExit> | undefined;
  private readonly onNotificationError: ((error: Error) => void) | undefined;

  constructor(options: RuntimeOptions) {
    this.defaultTimeoutMs = milliseconds(options.defaultTimeoutMs ?? 30_000, 'defaultTimeoutMs');
    this.maxLineBytes = positiveInteger(options.maxLineBytes ?? 8 * 1024 * 1024, 'maxLineBytes');
    this.stderrLimitBytes = positiveInteger(options.stderrLimitBytes ?? 64 * 1024, 'stderrLimitBytes');
    this.onNotificationError = options.onNotificationError;
    this.child = spawn(options.command, options.args ?? [], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.closed = new Promise(resolve => {
      this.child.once('close', (code, signal) => {
        if (this.stdoutBuffer.length && !this.failure) {
          this.fail(new RuntimeProtocolError('Runtime exited with an unfinished JSON-RPC line'));
        }
        this.exit = { code, signal, ...(this.failure ? { error: this.failure } : {}) };
        this.rejectPending(this.failure ?? new Error(`Runtime exited (${signal ?? code ?? 'unknown'})`));
        this.listeners.clear();
        resolve(this.exit);
      });
    });
    this.child.once('error', error => this.fail(error));
    this.child.stdin.on('error', error => this.fail(error));
    this.child.stdout.on('error', error => this.fail(error));
    this.child.stderr.on('error', error => this.fail(error));
    this.child.stdout.on('data', (chunk: Buffer) => this.receive(chunk));
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.stderrBuffer = Buffer.concat([this.stderrBuffer, chunk]);
      if (this.stderrBuffer.length > this.stderrLimitBytes) {
        this.stderrBuffer = this.stderrBuffer.subarray(-this.stderrLimitBytes);
      }
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get stderrTail(): string {
    return this.stderrBuffer.toString('utf8');
  }

  onNotification(listener: (notification: RuntimeNotification) => void): () => void {
    if (this.exit) return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** A timeout or abort stops waiting locally; task cancellation requires its own runtime command. */
  request<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    options: RequestOptions = {},
  ): Promise<T> {
    return this.send<T>(method, params, options, false);
  }

  close(options: CloseOptions = {}): Promise<RuntimeExit> {
    if (this.closePromise) return this.closePromise;
    const graceMs = milliseconds(options.graceMs ?? 2_000, 'graceMs');
    const terminateMs = milliseconds(options.terminateMs ?? 1_000, 'terminateMs');
    this.closing = true;
    this.closePromise = this.closeChild(options.shutdownMethod, graceMs, terminateMs);
    return this.closePromise;
  }

  private send<T>(
    method: string,
    params: Record<string, unknown>,
    options: RequestOptions,
    allowClosing: boolean,
  ): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.exit || (this.closing && !allowClosing)) {
      return Promise.reject(new Error('Runtime is closed or closing'));
    }
    if (!method) return Promise.reject(new TypeError('JSON-RPC method must not be empty'));
    if (options.signal?.aborted) {
      return Promise.reject(asError(options.signal.reason ?? new Error('Request aborted')));
    }
    let timeoutMs: number;
    let line: string;
    const id = this.nextId++;
    try {
      timeoutMs = milliseconds(options.timeoutMs ?? this.defaultTimeoutMs, 'timeoutMs');
      line = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
      if (Buffer.byteLength(line) - 1 > this.maxLineBytes) {
        throw new RangeError('JSON-RPC request exceeds maxLineBytes');
      }
    } catch (error) {
      return Promise.reject(asError(error));
    }
    return new Promise<T>((resolve, reject) => {
      const finishError = (error: Error) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        pending.cleanup();
        reject(error);
      };
      const abort = () => finishError(asError(options.signal?.reason ?? new Error('Request aborted')));
      const timer = setTimeout(() => finishError(new Error(`Runtime request timed out: ${method}`)), timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
      };
      this.pending.set(id, { resolve: value => resolve(value as T), reject, cleanup });
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) {
        abort();
        return;
      }
      this.child.stdin.write(line, error => {
        if (error) {
          finishError(error);
          this.fail(error);
        }
      });
    });
  }

  private receive(chunk: Buffer): void {
    if (this.failure) return;
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
    let end: number;
    while ((end = this.stdoutBuffer.indexOf(10)) !== -1) {
      if (end > this.maxLineBytes) {
        this.fail(new RuntimeProtocolError('Runtime JSON-RPC line exceeds maxLineBytes'));
        return;
      }
      const line = this.stdoutBuffer.subarray(0, end).toString('utf8').replace(/\r$/, '');
      this.stdoutBuffer = this.stdoutBuffer.subarray(end + 1);
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        this.fail(new RuntimeProtocolError('Runtime stdout must contain JSON-RPC lines only'));
        return;
      }
      try {
        this.dispatch(message);
      } catch (error) {
        this.fail(asError(error));
        return;
      }
    }
    if (this.stdoutBuffer.length > this.maxLineBytes) {
      this.fail(new RuntimeProtocolError('Runtime JSON-RPC line exceeds maxLineBytes'));
    }
  }

  private dispatch(message: unknown): void {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      throw new RuntimeProtocolError('Runtime sent an invalid JSON-RPC message');
    }
    const record = message as Record<string, unknown>;
    if (record.jsonrpc !== '2.0') throw new RuntimeProtocolError('Runtime JSON-RPC version must be 2.0');
    if (typeof record.method === 'string') {
      if ('id' in record || 'result' in record || 'error' in record) {
        throw new RuntimeProtocolError('Runtime may send notifications, not inbound requests');
      }
      const notification: RuntimeNotification = {
        method: record.method,
        ...('params' in record ? { params: record.params } : {}),
      };
      const listeners = [...this.listeners];
      for (const listener of listeners) {
        try {
          listener(notification);
        } catch (error) {
          try { this.onNotificationError?.(asError(error)); } catch {}
        }
      }
      return;
    }
    if (typeof record.id !== 'number' || !Number.isSafeInteger(record.id)) {
      throw new RuntimeProtocolError('Runtime response must contain a numeric request ID');
    }
    if (('result' in record) === ('error' in record)) {
      throw new RuntimeProtocolError('Runtime response requires exactly one result or error');
    }
    let error: RuntimeRpcError | undefined;
    if ('error' in record) {
      const value = record.error;
      if (!value || typeof value !== 'object'
        || typeof (value as Record<string, unknown>).code !== 'number'
        || !Number.isSafeInteger((value as Record<string, unknown>).code)
        || typeof (value as Record<string, unknown>).message !== 'string') {
        throw new RuntimeProtocolError('Runtime sent an invalid JSON-RPC error');
      }
      const rpc = value as { code: number; message: string; data?: unknown };
      error = new RuntimeRpcError(rpc.code, rpc.message, rpc.data);
    }
    const pending = this.pending.get(record.id);
    if (!pending) return;
    this.pending.delete(record.id);
    pending.cleanup();
    if (error) pending.reject(error);
    else pending.resolve(record.result);
  }

  private fail(error: Error): void {
    if (this.failure || this.exit) return;
    this.failure = error;
    this.rejectPending(error);
    this.child.kill('SIGTERM');
    void this.close({ shutdownMethod: null, graceMs: 0, terminateMs: 500 });
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.pending.clear();
  }

  private async waitForExit(timeoutMs: number): Promise<RuntimeExit | undefined> {
    if (this.exit) return this.exit;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.closed,
        new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), timeoutMs); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async closeChild(
    shutdownMethod: string | null | undefined,
    graceMs: number,
    terminateMs: number,
  ): Promise<RuntimeExit> {
    if (this.exit) return this.exit;
    if (shutdownMethod !== null && !this.failure) {
      void this.send(shutdownMethod ?? 'personbot.v1.shutdown', {}, { timeoutMs: graceMs }, true).catch(() => {});
    }
    if (await this.waitForExit(graceMs)) return this.closed;
    this.child.kill('SIGTERM');
    if (await this.waitForExit(terminateMs)) return this.closed;
    this.child.kill('SIGKILL');
    return this.closed;
  }
}

export function spawnRuntime(options: RuntimeOptions): RuntimeHost {
  return new RuntimeHost(options);
}
