import { mkdir } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { EVENT_METHOD, parseRequest, ProtocolError, type RuntimeEvent } from '../../personbot-protocol/src/index.ts';
import { spawnRuntime, type RuntimeHost, type RuntimeOptions } from '../../personbot-runtime-host/src/index.ts';
import { prepareRuntime } from '../../personbot-runtime-plugin/src/launch.ts';

export interface GatewayOptions {
  enabled: boolean;
  home: string;
  workspace: string;
  provider: string;
  model: string;
  fixture?: boolean;
  env?: NodeJS.ProcessEnv;
  prepare?: () => Promise<RuntimeOptions>;
  resolveLaunch?: () => { provider: string; model: string; env?: NodeJS.ProcessEnv };
  onLaunch?: () => void;
}

export type GatewayState = 'stopped' | 'starting' | 'ready' | 'failed' | 'closing';
export interface GatewayStatus {
  enabled: boolean;
  state: GatewayState;
  workspace: string;
  provider: string;
  model: string;
  error?: string;
}
export type GatewayFrame =
  | { kind: 'runtime'; event: RuntimeEvent }
  | ({ kind: 'gateway' } & GatewayStatus);

const ALLOWED_METHODS = new Set([
  'personbot.v1.sessions.create', 'personbot.v1.sessions.resume', 'personbot.v1.sessions.list',
  'personbot.v1.sessions.stop', 'personbot.v1.messages.submit', 'personbot.v1.approvals.resolve',
  'personbot.v1.questions.answer', 'personbot.v1.snapshots.get',
  'personbot.v1.tasks.create', 'personbot.v1.tasks.list', 'personbot.v1.tasks.control',
  'personbot.v1.personal.snapshot', 'personbot.v1.projects.put', 'personbot.v1.roles.put',
  'personbot.v1.memory.put', 'personbot.v1.memory.control',
  'personbot.v1.artifacts.list', 'personbot.v1.artifacts.publish', 'personbot.v1.artifacts.read',
  'personbot.v1.integrations.snapshot', 'personbot.v1.sources.put', 'personbot.v1.subscriptions.put',
  'personbot.v1.schedules.put', 'personbot.v1.deliveries.control',
]);

/** One lazy runtime owner shared by authenticated App connections. Reconnect reads native snapshots. */
export class PersonbotGateway {
  private readonly options: GatewayOptions;
  private host: RuntimeHost | undefined;
  private starting: Promise<RuntimeHost> | undefined;
  private closing: Promise<void> | undefined;
  private state: GatewayState = 'stopped';
  private error: string | undefined;
  private launched: { provider: string; model: string } | undefined;
  private readonly launchSecrets = new Set<string>();
  private readonly listeners = new Set<(frame: GatewayFrame) => void>();

  constructor(options: GatewayOptions) {
    if (!isAbsolute(options.home) || !isAbsolute(options.workspace)) {
      throw new TypeError('Personbot home and workspace must be absolute paths');
    }
    this.options = options;
  }

  status(): GatewayStatus {
    const configuration = this.launched && ['starting', 'ready'].includes(this.state)
      ? this.launched : this.options.resolveLaunch?.() ?? this.options;
    return {
      enabled: this.options.enabled, state: this.state,
      workspace: this.options.workspace, provider: configuration.provider, model: configuration.model,
      ...(this.error ? { error: this.error } : {}),
    };
  }

  subscribe(listener: (frame: GatewayFrame) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async request(method: unknown, params: unknown, admitted: () => boolean = () => true): Promise<unknown> {
    if (typeof method !== 'string' || !ALLOWED_METHODS.has(method)) {
      throw new ProtocolError(-32601, 'Unsupported App runtime method');
    }
    const request = parseRequest({ jsonrpc: '2.0', id: 0, method, params });
    const host = await this.start();
    if (!admitted()) throw new ProtocolError(-32001, 'Your session ended');
    return host.request(request.method, request.params, { timeoutMs: 60_000 });
  }

  async ingest(sourceId: unknown, token: unknown, payload: unknown): Promise<unknown> {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || Object.keys(payload).some(key => !['eventId', 'threadId', 'text'].includes(key))) {
      throw new ProtocolError(-32602, 'Expected an event with eventId, threadId and text');
    }
    const request = parseRequest({
      jsonrpc: '2.0', id: 0, method: 'personbot.v1.sources.ingest',
      params: { ...payload, sourceId, token },
    });
    const host = await this.start();
    return host.request(request.method, request.params, { timeoutMs: 60_000 });
  }

  start(): Promise<RuntimeHost> {
    if (!this.options.enabled) return Promise.reject(new Error('Personbot is disabled. Set PERSONBOT_ENABLED=1 on a source installation.'));
    if (this.state === 'closing') return Promise.reject(new Error('Personbot is closing'));
    if (this.state === 'ready' && this.host) return Promise.resolve(this.host);
    if (this.starting) return this.starting;
    this.setState('starting');
    const operation = this.launch();
    this.starting = operation;
    void operation.finally(() => {
      if (this.starting === operation) this.starting = undefined;
    }).catch(() => {});
    return operation;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.setState('closing');
    this.closing = (async () => {
      const host = this.host;
      await host?.close({ graceMs: 3_000, terminateMs: 1_000 });
      await this.starting?.catch(() => {});
      if (this.host && this.host !== host) await this.host.close({ graceMs: 3_000, terminateMs: 1_000 });
      this.host = undefined;
      this.listeners.clear();
    })();
    return this.closing;
  }

  private async launch(): Promise<RuntimeHost> {
    let host: RuntimeHost | undefined;
    try {
      const resolved = this.options.resolveLaunch?.();
      const config = {
        ...this.options,
        ...resolved,
        env: this.options.env || resolved?.env ? { ...this.options.env, ...resolved?.env } : undefined,
      };
      this.launched = { provider: config.provider, model: config.model };
      for (const [key, value] of Object.entries(config.env ?? {})) {
        if (value && value.length >= 8 && /(?:KEY|TOKEN|SECRET|PASSWORD)/i.test(key)) this.launchSecrets.add(value);
      }
      config.onLaunch?.();
      await mkdir(config.workspace, { recursive: true });
      const launch = await (config.prepare?.() ?? prepareRuntime(config));
      if (this.status().state === 'closing') throw new Error('Personbot is closing');
      host = spawnRuntime({
        ...launch,
        ...(config.env ? { env: { ...launch.env, ...config.env } } : {}),
      });
      this.host = host;
      const owned = host;
      owned.onNotification(notification => {
        if (notification.method === EVENT_METHOD) {
          this.emit({ kind: 'runtime', event: notification.params as RuntimeEvent });
        }
      });
      void owned.closed.then(exit => {
        if (this.host !== owned) return;
        this.host = undefined;
        if (this.state !== 'closing') {
          this.setState('failed', exit.error?.message ?? `Runtime exited (${exit.signal ?? exit.code ?? 'unknown'})`);
        }
      });
      await owned.request('personbot.v1.initialize', { protocolVersion: 1 }, { timeoutMs: 45_000 });
      if (this.status().state === 'closing') throw new Error('Personbot is closing');
      this.setState('ready');
      return owned;
    } catch (error) {
      await host?.close({ graceMs: 500, terminateMs: 500 });
      if (this.host === host) this.host = undefined;
      const message = this.redact(error instanceof Error ? error.message : String(error));
      if (this.state !== 'closing') this.setState('failed', message);
      throw new Error(message);
    }
  }

  private setState(state: GatewayState, error?: string): void {
    this.state = state;
    this.error = error === undefined ? undefined : this.redact(error);
    this.emit({ kind: 'gateway', ...this.status() });
  }

  private redact(value: string): string {
    for (const secret of this.launchSecrets) value = value.split(secret).join('[redacted]');
    return value;
  }

  private emit(frame: GatewayFrame): void {
    for (const listener of this.listeners) {
      try { listener(frame); } catch { this.listeners.delete(listener); }
    }
  }
}
