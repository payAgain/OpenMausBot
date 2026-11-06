import { createHash, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  ChannelDeliveryRecord, CommandParamsMap, IntegrationSnapshot, ScheduleRecord,
  SourceRecord, SubscriptionRecord, TaskUpdate, TriggerRecord,
} from '../../personbot-protocol/src/index.ts';
import { validateCallbackUrl, type CallbackResult } from './delivery.ts';

type SourceParams = CommandParamsMap['personbot.v1.sources.put'];
type SubscriptionParams = CommandParamsMap['personbot.v1.subscriptions.put'];
type ScheduleParams = CommandParamsMap['personbot.v1.schedules.put'];
type DeliveryControlParams = CommandParamsMap['personbot.v1.deliveries.control'];
type EventNamespace = 'webhook' | 'schedule';

export interface IncomingEvent {
  sourceId: string;
  eventId: string;
  threadId: string;
  text: string;
}

export interface EventDeliveryRecord {
  id: string;
  triggerId: string;
  taskId?: string;
  subscriptionId?: string;
  state: 'pending' | 'delivered' | 'ignored' | 'failed';
  lastError?: string;
}

export interface PendingEvent {
  delivery: EventDeliveryRecord;
  trigger: TriggerRecord;
  source: SourceRecord;
}

interface CommandRow { fingerprint: string; result: string }

export class IntegrationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntegrationConflictError';
  }
}

const MAX_TEXT_BYTES = 32 * 1024;
const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 7 * 1024 * 1024;
const MAX_PENDING_TRIGGERS = 2048;
const MAX_PENDING_CALLBACKS = 4096;
const ENABLED_EVENT = `
  e.state = 'pending' AND json_extract(s.data, '$.enabled') = 1
  AND EXISTS (
    SELECT 1 FROM subscriptions b WHERE json_extract(b.data, '$.enabled') = 1
    AND b.source_id = t.source_id AND b.thread_id = json_extract(t.data, '$.threadId')
    AND b.task_id = json_extract(e.data, '$.taskId')
    AND (json_extract(e.data, '$.subscriptionId') IS NULL OR b.id = json_extract(e.data, '$.subscriptionId'))
  )
`;

function serialized(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
    : item);
}

function hash(value: unknown): string {
  return createHash('sha256').update(serialized(value)).digest('hex');
}

function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}-${hash(parts).slice(0, 40)}`;
}

function text(value: unknown, label: string, limit = MAX_TEXT_BYTES): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || Buffer.byteLength(value) > limit) {
    throw new TypeError(`${label} must be non-empty text of at most ${limit} UTF-8 bytes without NUL`);
  }
}

function identity(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(value)) throw new TypeError(`Invalid ${label}`);
}

function externalId(value: unknown, label: string): asserts value is string {
  text(value, label, 256);
  if (Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    throw new TypeError(`${label} cannot contain control characters`);
  }
}

function bool(value: unknown, label: string): asserts value is boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be boolean`);
}

function revision(expected: number | undefined, previous?: { revision: number }): void {
  if (expected !== undefined && (!Number.isSafeInteger(expected) || expected < 1)) throw new TypeError('expectedRevision must be a positive integer');
  if (previous ? previous.revision !== expected : expected !== undefined) {
    throw new IntegrationConflictError(previous ? 'Record changed; refresh before saving' : 'Record does not exist');
  }
}

function timestamp(value: string, label: string): string {
  if (typeof value !== 'string' || !value.trim() || !Number.isFinite(Date.parse(value))) throw new TypeError(`${label} must be an ISO timestamp`);
  return new Date(value).toISOString();
}

function errorText(value: string | undefined): string | undefined {
  return value === undefined ? undefined : String(value).replace(/\0/g, '').slice(0, 2048);
}

function limitedText(value: string): string {
  const bytes = Buffer.from(value);
  if (bytes.length <= MAX_TEXT_BYTES) return value;
  return `${bytes.subarray(0, MAX_TEXT_BYTES - 100).toString('utf8').replace(/\uFFFD$/, '')}\n[Result text truncated; inspect the task in Personbot for the complete report.]`;
}

/** One durable event inbox and callback outbox; execution remains owned by the task supervisor. */
export class IntegrationStore {
  private readonly db: DatabaseSync;
  private closed = false;
  private eventCursor = 0;

  constructor(path: string) {
    if (path !== ':memory:' && !isAbsolute(path)) throw new TypeError('Integration database path must be absolute');
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    try {
      if (path !== ':memory:') chmodSync(path, 0o600);
      const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
      if (version > 1) throw new Error(`Unsupported integration store version: ${version}`);
      this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;');
      this.atomic(() => this.db.exec(`
        CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY NOT NULL, token_hash TEXT NOT NULL, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS subscriptions (
          id TEXT PRIMARY KEY NOT NULL, source_id TEXT NOT NULL REFERENCES sources(id),
          thread_id TEXT NOT NULL, task_id TEXT NOT NULL, data TEXT NOT NULL,
          UNIQUE(source_id, thread_id, task_id)
        );
        CREATE TABLE IF NOT EXISTS schedules (id TEXT PRIMARY KEY NOT NULL, source_id TEXT NOT NULL REFERENCES sources(id), data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS triggers (
          id TEXT PRIMARY KEY NOT NULL, source_id TEXT NOT NULL REFERENCES sources(id),
          namespace TEXT NOT NULL, event_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
          data TEXT NOT NULL, source TEXT NOT NULL, receipt TEXT NOT NULL,
          UNIQUE(source_id, namespace, event_id)
        );
        CREATE TABLE IF NOT EXISTS event_deliveries (
          id TEXT PRIMARY KEY NOT NULL, trigger_id TEXT NOT NULL REFERENCES triggers(id), state TEXT NOT NULL, data TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS pending_events ON event_deliveries(state);
        CREATE TABLE IF NOT EXISTS channel_deliveries (
          id TEXT PRIMARY KEY NOT NULL, state TEXT NOT NULL, source_id TEXT NOT NULL,
          thread_id TEXT NOT NULL, data TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS pending_channels ON channel_deliveries(state);
        CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY NOT NULL, fingerprint TEXT NOT NULL, result TEXT NOT NULL);
        PRAGMA user_version = 1;
      `));
    } catch (error) {
      this.db.close();
      this.closed = true;
      throw error;
    }
  }

  snapshot(): IntegrationSnapshot {
    this.requireOpen();
    type DeliveryRow = { position: number; data: string };
    const decisions = this.db.prepare("SELECT rowid AS position, data FROM channel_deliveries WHERE state IN ('uncertain', 'failed') ORDER BY rowid LIMIT 100").all() as DeliveryRow[];
    const recent = this.db.prepare('SELECT rowid AS position, data FROM channel_deliveries ORDER BY rowid DESC LIMIT 100').all() as DeliveryRow[];
    const deliveries = new Map<string, { position: number; record: ChannelDeliveryRecord }>();
    for (const row of [...decisions, ...recent]) {
      if (deliveries.size >= 100) break;
      const record = JSON.parse(row.data) as ChannelDeliveryRecord;
      deliveries.set(record.id, { position: row.position, record });
    }
    const snapshot: IntegrationSnapshot = {
      sources: this.rows('sources'),
      subscriptions: this.rows('subscriptions'),
      schedules: this.rows('schedules'),
      triggers: this.rows<TriggerRecord>('triggers', 100),
      deliveries: [...deliveries.values()].sort((left, right) => left.position - right.position).map(row => row.record),
    };
    let bytes = Buffer.byteLength(serialized(snapshot));
    while (bytes > MAX_SNAPSHOT_BYTES && (snapshot.triggers.length || snapshot.deliveries.length)) {
      let removed: TriggerRecord | ChannelDeliveryRecord | undefined;
      let remaining: number;
      if (snapshot.triggers.length) {
        removed = snapshot.triggers.shift();
        remaining = snapshot.triggers.length;
      } else {
        const ordinary = snapshot.deliveries.findIndex(row => row.state !== 'uncertain' && row.state !== 'failed');
        const index = ordinary < 0 ? snapshot.deliveries.length - 1 : ordinary;
        [removed] = snapshot.deliveries.splice(index, 1);
        remaining = snapshot.deliveries.length;
      }
      bytes -= Buffer.byteLength(serialized(removed)) + (remaining ? 1 : 0);
    }
    return snapshot;
  }

  getSource(id: string): SourceRecord | undefined { return this.record('sources', id); }
  getSubscription(id: string): SubscriptionRecord | undefined { return this.record('subscriptions', id); }

  authenticate(sourceId: string, token: string): boolean {
    this.requireOpen();
    if (typeof sourceId !== 'string' || typeof token !== 'string' || token.length < 32 || token.length > 256) return false;
    const row = this.db.prepare('SELECT token_hash FROM sources WHERE id = ?').get(sourceId) as { token_hash: string } | undefined;
    const received = createHash('sha256').update(token).digest();
    const expected = Buffer.from(row?.token_hash ?? '0'.repeat(64), 'hex');
    return timingSafeEqual(expected, received) && row !== undefined;
  }

  putSource(params: SourceParams): SourceRecord {
    externalId(params.commandId, 'commandId');
    identity(params.sourceId, 'sourceId');
    externalId(params.originSessionId, 'originSessionId');
    text(params.name, 'name', 256);
    text(params.goal, 'goal');
    if (!Array.isArray(params.criteria) || !params.criteria.length || params.criteria.length > 20) throw new TypeError('Source requires between 1 and 20 completion criteria');
    for (const criterion of params.criteria) text(criterion, 'criterion');
    bool(params.enabled, 'enabled');
    if (!['idempotent', 'at-most-once'].includes(params.callbackMode)) throw new TypeError('Unsupported callback mode');
    const callbackUrl = params.callbackUrl === undefined ? undefined : validateCallbackUrl(params.callbackUrl);
    if (params.token !== undefined && (typeof params.token !== 'string' || !/^[\x21-\x7e]{32,256}$/.test(params.token))) {
      throw new TypeError('Source token must contain 32–256 non-whitespace ASCII characters');
    }
    return this.command(params.commandId, hash({ method: 'sources.put', ...params }), () => {
      const previous = this.getSource(params.sourceId);
      revision(params.expectedRevision, previous);
      if (previous && previous.originSessionId !== params.originSessionId) throw new IntegrationConflictError('A Source cannot change its origin Session');
      if (!previous && !params.token) throw new TypeError('A new Source requires a write-only token');
      if (!previous && this.count('sources') >= 32) throw new IntegrationConflictError('Source limit reached (32)');
      const previousHash = this.db.prepare('SELECT token_hash FROM sources WHERE id = ?').get(params.sourceId) as { token_hash: string } | undefined;
      const tokenHash = params.token === undefined ? previousHash!.token_hash : createHash('sha256').update(params.token).digest('hex');
      const now = new Date().toISOString();
      const source: SourceRecord = {
        id: params.sourceId, name: params.name.trim(), originSessionId: params.originSessionId,
        enabled: params.enabled, goal: params.goal, criteria: [...params.criteria],
        ...(callbackUrl ? { callbackUrl } : {}), callbackMode: params.callbackMode,
        revision: (previous?.revision ?? 0) + 1, createdAt: previous?.createdAt ?? now, updatedAt: now,
      };
      this.db.prepare('INSERT INTO sources(id, token_hash, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET token_hash = excluded.token_hash, data = excluded.data')
        .run(source.id, tokenHash, serialized(source));
      this.checkConfigBudget();
      return source;
    });
  }

  putSubscription(params: SubscriptionParams): SubscriptionRecord {
    externalId(params.commandId, 'commandId');
    identity(params.subscriptionId, 'subscriptionId');
    identity(params.sourceId, 'sourceId');
    externalId(params.threadId, 'threadId');
    identity(params.taskId, 'taskId');
    bool(params.enabled, 'enabled');
    return this.command(params.commandId, hash({ method: 'subscriptions.put', ...params }), () => {
      if (!this.getSource(params.sourceId)) throw new IntegrationConflictError('Unknown Source');
      const previous = this.getSubscription(params.subscriptionId);
      revision(params.expectedRevision, previous);
      if (!previous && this.count('subscriptions') >= 256) throw new IntegrationConflictError('Subscription limit reached (256)');
      const threadId = params.threadId.trim().normalize('NFC');
      if (previous && (previous.sourceId !== params.sourceId || previous.threadId !== threadId || previous.taskId !== params.taskId)) {
        throw new IntegrationConflictError('A subscription cannot change its Source, thread or task binding');
      }
      const duplicate = this.subscriptionFor(params.sourceId, threadId, params.taskId);
      if (duplicate && duplicate.id !== params.subscriptionId) throw new IntegrationConflictError('This source/thread/task subscription already exists');
      const now = new Date().toISOString();
      const newBinding = previous && !previous.enabled && params.enabled;
      const subscription: SubscriptionRecord = {
        id: params.subscriptionId, sourceId: params.sourceId, threadId, taskId: params.taskId, enabled: params.enabled,
        revision: (previous?.revision ?? 0) + 1, createdAt: newBinding ? now : previous?.createdAt ?? now, updatedAt: now,
      };
      this.saveSubscription(subscription);
      this.checkConfigBudget();
      return subscription;
    });
  }

  putSchedule(params: ScheduleParams): ScheduleRecord {
    externalId(params.commandId, 'commandId');
    identity(params.scheduleId, 'scheduleId');
    identity(params.sourceId, 'sourceId');
    text(params.name, 'name', 256);
    externalId(params.threadId, 'threadId');
    text(params.text, 'text');
    bool(params.enabled, 'enabled');
    const runAt = timestamp(params.runAt, 'runAt');
    if (params.intervalSeconds !== undefined && (!Number.isSafeInteger(params.intervalSeconds) ||
      params.intervalSeconds < 60 || params.intervalSeconds > 31_536_000)) {
      throw new TypeError('intervalSeconds must be an integer between 60 and 31536000');
    }
    return this.command(params.commandId, hash({ method: 'schedules.put', ...params }), () => {
      if (!this.getSource(params.sourceId)) throw new IntegrationConflictError('Unknown Source');
      const previous = this.record<ScheduleRecord>('schedules', params.scheduleId);
      revision(params.expectedRevision, previous);
      if (!previous && this.count('schedules') >= 128) throw new IntegrationConflictError('Schedule limit reached (128)');
      const now = new Date().toISOString();
      const schedule: ScheduleRecord = {
        id: params.scheduleId, name: params.name.trim(), sourceId: params.sourceId,
        threadId: params.threadId.trim().normalize('NFC'), text: params.text, nextRunAt: runAt,
        ...(params.intervalSeconds === undefined ? {} : { intervalSeconds: params.intervalSeconds }),
        enabled: params.enabled, revision: (previous?.revision ?? 0) + 1,
        createdAt: previous?.createdAt ?? now, updatedAt: now,
      };
      this.saveSchedule(schedule);
      this.checkConfigBudget();
      return schedule;
    });
  }

  receive(params: IncomingEvent, namespace: EventNamespace = 'webhook'): { trigger: TriggerRecord; duplicate: boolean } {
    return this.atomic(() => this.receiveOne(params, namespace));
  }

  produceDue(nowIso: string): void {
    const now = timestamp(nowIso, 'now');
    const due = this.rows<ScheduleRecord>('schedules').filter(schedule =>
      schedule.enabled && schedule.nextRunAt && schedule.nextRunAt <= now && this.getSource(schedule.sourceId)?.enabled).slice(0, 32);
    for (const item of due) {
      try {
        this.atomic(() => {
          const schedule = this.record<ScheduleRecord>('schedules', item.id)!;
          if (!schedule.enabled || !schedule.nextRunAt || schedule.nextRunAt > now || !this.getSource(schedule.sourceId)?.enabled) return;
          const first = Date.parse(schedule.nextRunAt);
          const interval = schedule.intervalSeconds === undefined ? undefined : schedule.intervalSeconds * 1000;
          const occurrence = interval === undefined ? first : first + Math.floor((Date.parse(now) - first) / interval) * interval;
          const scheduledAt = new Date(occurrence).toISOString();
          this.receiveOne({
            sourceId: schedule.sourceId, eventId: stableId('schedule', schedule.id, String(schedule.revision), scheduledAt),
            threadId: schedule.threadId, text: schedule.text,
          }, 'schedule', now);
          if (interval === undefined) {
            schedule.enabled = false;
            delete schedule.nextRunAt;
          } else schedule.nextRunAt = new Date(occurrence + interval).toISOString();
          schedule.revision++;
          schedule.updatedAt = now;
          this.saveSchedule(schedule);
        });
      } catch (error) {
        if (!(error instanceof IntegrationConflictError)) throw error;
      }
    }
  }

  canDeliverEvent(deliveryId: string): boolean {
    this.requireOpen();
    return this.db.prepare(`
      SELECT e.id FROM event_deliveries e JOIN triggers t ON t.id = e.trigger_id JOIN sources s ON s.id = t.source_id
      WHERE e.id = ? AND ${ENABLED_EVENT}
    `).get(deliveryId) !== undefined;
  }

  pendingEvents(excludedTaskIds: readonly string[] = []): PendingEvent[] {
    this.requireOpen();
    const statement = this.db.prepare(`
      SELECT e.rowid AS position, e.data AS delivery, t.data AS trigger, t.source AS source
      FROM event_deliveries e JOIN triggers t ON t.id = e.trigger_id JOIN sources s ON s.id = t.source_id
      WHERE e.rowid > ? AND ${ENABLED_EVENT}
      AND COALESCE(json_extract(e.data, '$.taskId'), '') NOT IN (SELECT value FROM json_each(?))
      AND NOT EXISTS (
        SELECT 1 FROM event_deliveries older WHERE older.state = 'pending' AND older.rowid < e.rowid
        AND json_extract(older.data, '$.taskId') = json_extract(e.data, '$.taskId')
      )
      ORDER BY e.rowid LIMIT 64
    `);
    type PendingRow = { position: number; delivery: string; trigger: string; source: string };
    const excluded = serialized(excludedTaskIds);
    let rows = statement.all(this.eventCursor, excluded) as PendingRow[];
    if (!rows.length && this.eventCursor) rows = statement.all(0, excluded) as PendingRow[];
    this.eventCursor = rows.at(-1)?.position ?? 0;
    return rows.map(row => ({ delivery: JSON.parse(row.delivery), trigger: JSON.parse(row.trigger), source: JSON.parse(row.source) }) as PendingEvent);
  }

  finishEvent(deliveryId: string, result: { state: 'delivered' | 'ignored' | 'failed'; taskId?: string; error?: string }): void {
    this.atomic(() => this.finishEventOne(deliveryId, result));
  }

  failEvent(deliveryId: string, error: string): void {
    this.atomic(() => {
      const delivery = this.eventDelivery(deliveryId);
      if (delivery.state !== 'pending') return;
      delivery.lastError = errorText(error);
      this.saveEvent(delivery);
      const trigger = this.record<TriggerRecord>('triggers', delivery.triggerId)!;
      trigger.lastError = delivery.lastError;
      this.saveTrigger(trigger);
    });
  }

  trackCreatedTask(deliveryId: string, taskId: string): void {
    identity(taskId, 'taskId');
    this.atomic(() => {
      const delivery = this.eventDelivery(deliveryId);
      if (delivery.subscriptionId) throw new IntegrationConflictError('An existing-task delivery cannot create another task');
      if (delivery.taskId !== taskId) throw new IntegrationConflictError('Created task differs from the durable event intent');
      if (delivery.state !== 'pending') {
        if (delivery.state === 'delivered') return;
        throw new IntegrationConflictError('Event intent already settled');
      }
      const trigger = this.record<TriggerRecord>('triggers', delivery.triggerId)!;
      if (!this.subscriptionFor(trigger.sourceId, trigger.threadId, taskId)) {
        if (this.count('subscriptions') >= 256) throw new IntegrationConflictError('Subscription limit reached (256)');
        this.saveSubscription({
          id: stableId('auto', trigger.sourceId, trigger.threadId, taskId),
          sourceId: trigger.sourceId, threadId: trigger.threadId, taskId, enabled: true, revision: 1,
          createdAt: trigger.receivedAt, updatedAt: new Date().toISOString(),
        });
        this.checkConfigBudget();
      }
      this.finishEventOne(deliveryId, { state: 'delivered', taskId });
    });
  }

  queueUpdates(updates: TaskUpdate[]): void {
    this.atomic(() => {
      const sources = new Map(this.rows<SourceRecord>('sources').map(source => [source.id, source]));
      const subscriptions = this.rows<SubscriptionRecord>('subscriptions').filter(subscription =>
        subscription.enabled && sources.get(subscription.sourceId)?.enabled && sources.get(subscription.sourceId)?.callbackUrl);
      let pending = this.db.prepare("SELECT COUNT(*) AS count FROM channel_deliveries WHERE state != 'delivered'").get() as { count: number };
      for (const update of updates) {
        externalId(update.id, 'updateId');
        identity(update.taskId, 'taskId');
        externalId(update.sessionId, 'sessionId');
        const createdAt = timestamp(update.createdAt, 'update.createdAt');
        if (!Number.isSafeInteger(update.revision) || update.revision < 1 || typeof update.text !== 'string') throw new TypeError('Invalid task update');
        for (const subscription of subscriptions) {
          const source = sources.get(subscription.sourceId)!;
          if (subscription.taskId !== update.taskId || source.originSessionId !== update.sessionId || createdAt < subscription.createdAt) continue;
          const id = stableId('callback', update.id, subscription.id);
          if (this.record('channel_deliveries', id)) continue;
          if (pending.count >= MAX_PENDING_CALLBACKS) return;
          const now = new Date().toISOString();
          const record: ChannelDeliveryRecord = {
            id, sourceId: source.id, threadId: subscription.threadId, taskId: update.taskId, updateId: update.id,
            url: source.callbackUrl!, mode: source.callbackMode, state: 'pending', attempts: 0, createdAt: now, updatedAt: now,
            payload: {
              deliveryId: id, sourceId: source.id, threadId: subscription.threadId, taskId: update.taskId,
              updateId: update.id, revision: update.revision, text: limitedText(update.text), createdAt,
            },
          };
          this.saveChannel(record);
          pending = { count: pending.count + 1 };
        }
      }
    });
  }

  pendingDeliveries(nowIso: string): ChannelDeliveryRecord[] {
    const now = timestamp(nowIso, 'now');
    const rows = this.rows<ChannelDeliveryRecord>('channel_deliveries').filter(record => record.state !== 'delivered');
    const seen = new Set<string>();
    const result: ChannelDeliveryRecord[] = [];
    for (const delivery of rows) {
      const key = serialized([delivery.sourceId, delivery.threadId]);
      if (seen.has(key)) continue;
      seen.add(key);
      if (delivery.state === 'pending' && delivery.attempts < 5 && (!delivery.nextAttemptAt || delivery.nextAttemptAt <= now)) result.push(delivery);
      if (result.length >= 32) break;
    }
    return result;
  }

  beginDelivery(id: string): ChannelDeliveryRecord {
    return this.atomic(() => {
      const delivery = this.channelDelivery(id);
      if (delivery.state !== 'pending' || delivery.attempts >= 5) throw new IntegrationConflictError('Callback is not eligible for automatic delivery');
      const first = this.db.prepare("SELECT id FROM channel_deliveries WHERE source_id = ? AND thread_id = ? AND state != 'delivered' ORDER BY rowid LIMIT 1")
        .get(delivery.sourceId, delivery.threadId) as { id: string } | undefined;
      if (first?.id !== id) throw new IntegrationConflictError('An earlier callback in this thread must settle first');
      delivery.state = 'sending';
      delivery.attempts++;
      delivery.updatedAt = new Date().toISOString();
      delete delivery.nextAttemptAt;
      this.saveChannel(delivery);
      return delivery;
    });
  }

  finishDelivery(id: string, result: CallbackResult): void {
    this.atomic(() => {
      const delivery = this.channelDelivery(id);
      if (delivery.state === 'delivered') return;
      if (delivery.state !== 'sending') {
        if (delivery.state === result.state) return;
        throw new IntegrationConflictError('Callback does not have a sending receipt');
      }
      if (!['delivered', 'pending', 'uncertain', 'failed'].includes(result.state)) throw new TypeError('Invalid callback result');
      delivery.state = result.state === 'pending'
        ? delivery.mode === 'at-most-once' ? 'uncertain' : delivery.attempts >= 5 ? 'failed' : 'pending'
        : result.state;
      delivery.updatedAt = new Date().toISOString();
      if (result.error === undefined) delete delivery.lastError;
      else delivery.lastError = errorText(result.error);
      if (delivery.state === 'pending' && result.nextAttemptAt) delivery.nextAttemptAt = timestamp(result.nextAttemptAt, 'nextAttemptAt');
      else delete delivery.nextAttemptAt;
      this.saveChannel(delivery);
    });
  }

  controlDelivery(params: DeliveryControlParams): ChannelDeliveryRecord {
    externalId(params.commandId, 'commandId');
    identity(params.deliveryId, 'deliveryId');
    if (!['uncertain', 'failed'].includes(params.expectedState) || !['retry', 'mark_delivered'].includes(params.action)) throw new TypeError('Invalid manual callback action');
    return this.command(params.commandId, hash({ method: 'deliveries.control', ...params }), () => {
      const delivery = this.channelDelivery(params.deliveryId);
      if (delivery.state !== params.expectedState) throw new IntegrationConflictError('Callback state changed; refresh before deciding');
      delivery.state = params.action === 'retry' ? 'pending' : 'delivered';
      if (params.action === 'retry') delivery.attempts = 0;
      delivery.updatedAt = new Date().toISOString();
      delete delivery.nextAttemptAt;
      delete delivery.lastError;
      this.saveChannel(delivery);
      return delivery;
    });
  }

  recover(): void {
    this.atomic(() => {
      for (const delivery of this.rows<ChannelDeliveryRecord>('channel_deliveries')) {
        if (delivery.state !== 'sending') continue;
        delivery.state = delivery.mode === 'at-most-once' ? 'uncertain' : delivery.attempts >= 5 ? 'failed' : 'pending';
        delivery.lastError = 'Runtime stopped with an in-flight callback; remote delivery may have occurred';
        delivery.updatedAt = new Date().toISOString();
        delete delivery.nextAttemptAt;
        this.saveChannel(delivery);
      }
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private receiveOne(params: IncomingEvent, namespace: EventNamespace, receivedAt = new Date().toISOString()): { trigger: TriggerRecord; duplicate: boolean } {
    identity(params.sourceId, 'sourceId');
    externalId(params.eventId, 'eventId');
    externalId(params.threadId, 'threadId');
    text(params.text, 'text');
    if (!['webhook', 'schedule'].includes(namespace)) throw new TypeError('Unsupported event namespace');
    const normalized = {
      sourceId: params.sourceId, eventId: params.eventId.trim().normalize('NFC'),
      threadId: params.threadId.trim().normalize('NFC'), text: params.text,
    };
    const fingerprint = hash({ namespace, ...normalized });
    const previous = this.db.prepare('SELECT fingerprint, receipt FROM triggers WHERE source_id = ? AND namespace = ? AND event_id = ?')
      .get(normalized.sourceId, namespace, normalized.eventId) as { fingerprint: string; receipt: string } | undefined;
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new IntegrationConflictError('Event identity was reused with different content');
      return { trigger: JSON.parse(previous.receipt) as TriggerRecord, duplicate: true };
    }
    const source = this.getSource(normalized.sourceId);
    if (!source) throw new IntegrationConflictError('Unknown Source');
    if (!source.enabled) throw new IntegrationConflictError('Source is disabled');
    const pending = this.db.prepare("SELECT COUNT(DISTINCT trigger_id) AS count FROM event_deliveries WHERE state = 'pending'").get() as { count: number };
    if (pending.count >= MAX_PENDING_TRIGGERS) throw new IntegrationConflictError('Event backlog is full; resolve pending events');
    const id = stableId('trigger', normalized.sourceId, namespace, normalized.eventId);
    const trigger: TriggerRecord = {
      id, ...normalized, receivedAt, status: 'pending', taskIds: [],
    };
    const data = serialized(trigger);
    this.db.prepare('INSERT INTO triggers(id, source_id, namespace, event_id, fingerprint, data, source, receipt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, source.id, namespace, normalized.eventId, fingerprint, data, serialized(source), data);
    const subscriptions = this.rows<SubscriptionRecord>('subscriptions').filter(subscription =>
      subscription.sourceId === source.id && subscription.threadId === normalized.threadId);
    if (subscriptions.length) {
      const enabled = subscriptions.filter(subscription => subscription.enabled);
      for (const subscription of enabled.length ? enabled : subscriptions) this.saveEvent({
        id: stableId('event', id, subscription.id), triggerId: id, taskId: subscription.taskId,
        subscriptionId: subscription.id, state: 'pending',
      });
    } else {
      if (this.count('subscriptions') >= 256) throw new IntegrationConflictError('Subscription limit reached (256)');
      const taskId = stableId('evt', id);
      this.saveSubscription({
        id: stableId('auto', source.id, normalized.threadId, taskId),
        sourceId: source.id, threadId: normalized.threadId, taskId, enabled: true, revision: 1,
        createdAt: trigger.receivedAt, updatedAt: trigger.receivedAt,
      });
      this.checkConfigBudget();
      this.saveEvent({ id: stableId('event', id, 'create'), triggerId: id, taskId, state: 'pending' });
    }
    return { trigger, duplicate: false };
  }

  private finishEventOne(id: string, result: { state: 'delivered' | 'ignored' | 'failed'; taskId?: string; error?: string }): void {
    if (!['delivered', 'ignored', 'failed'].includes(result.state)) throw new TypeError('Invalid event result');
    const delivery = this.eventDelivery(id);
    if (delivery.state !== 'pending') {
      if (delivery.state === result.state && (result.taskId === undefined || result.taskId === delivery.taskId)) return;
      throw new IntegrationConflictError('Event intent already settled with a different result');
    }
    if (result.taskId !== undefined) {
      identity(result.taskId, 'taskId');
      if (delivery.taskId && delivery.taskId !== result.taskId) throw new IntegrationConflictError('Event intent cannot change its task');
      delivery.taskId = result.taskId;
    }
    delivery.state = result.state;
    if (result.error === undefined) delete delivery.lastError;
    else delivery.lastError = errorText(result.error);
    this.saveEvent(delivery);
    const trigger = this.record<TriggerRecord>('triggers', delivery.triggerId)!;
    const intents = (this.db.prepare('SELECT data FROM event_deliveries WHERE trigger_id = ? ORDER BY rowid').all(trigger.id) as { data: string }[])
      .map(row => JSON.parse(row.data) as EventDeliveryRecord);
    trigger.taskIds = [...new Set(intents.filter(item => item.state === 'delivered' && item.taskId).map(item => item.taskId!))];
    trigger.status = intents.some(item => item.state === 'pending') ? 'pending'
      : intents.some(item => item.state === 'failed') ? 'failed'
      : intents.some(item => item.state === 'delivered') ? 'delivered' : 'ignored';
    const lastError = intents.find(item => item.lastError)?.lastError;
    if (lastError) trigger.lastError = lastError;
    else delete trigger.lastError;
    this.saveTrigger(trigger);
  }

  private eventDelivery(id: string): EventDeliveryRecord {
    const record = this.record<EventDeliveryRecord>('event_deliveries', id);
    if (!record) throw new IntegrationConflictError('Unknown event delivery');
    return record;
  }

  private channelDelivery(id: string): ChannelDeliveryRecord {
    const record = this.record<ChannelDeliveryRecord>('channel_deliveries', id);
    if (!record) throw new IntegrationConflictError('Unknown callback delivery');
    return record;
  }

  private subscriptionFor(sourceId: string, threadId: string, taskId: string): SubscriptionRecord | undefined {
    this.requireOpen();
    const row = this.db.prepare('SELECT data FROM subscriptions WHERE source_id = ? AND thread_id = ? AND task_id = ?')
      .get(sourceId, threadId, taskId) as { data: string } | undefined;
    return row ? JSON.parse(row.data) as SubscriptionRecord : undefined;
  }

  private saveSubscription(record: SubscriptionRecord): void {
    this.db.prepare(`INSERT INTO subscriptions(id, source_id, thread_id, task_id, data) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET source_id = excluded.source_id, thread_id = excluded.thread_id, task_id = excluded.task_id, data = excluded.data`)
      .run(record.id, record.sourceId, record.threadId, record.taskId, serialized(record));
  }

  private saveSchedule(record: ScheduleRecord): void {
    this.db.prepare('INSERT INTO schedules(id, source_id, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET source_id = excluded.source_id, data = excluded.data')
      .run(record.id, record.sourceId, serialized(record));
  }

  private saveEvent(record: EventDeliveryRecord): void {
    this.db.prepare('INSERT INTO event_deliveries(id, trigger_id, state, data) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state, data = excluded.data')
      .run(record.id, record.triggerId, record.state, serialized(record));
  }

  private saveTrigger(record: TriggerRecord): void {
    this.db.prepare('UPDATE triggers SET data = ? WHERE id = ?').run(serialized(record), record.id);
  }

  private saveChannel(record: ChannelDeliveryRecord): void {
    this.db.prepare(`INSERT INTO channel_deliveries(id, state, source_id, thread_id, data) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET state = excluded.state, data = excluded.data`)
      .run(record.id, record.state, record.sourceId, record.threadId, serialized(record));
  }

  private rows<T>(table: string, recent?: number): T[] {
    this.requireOpen();
    const rows = this.db.prepare(`SELECT data FROM ${table} ORDER BY rowid ${recent === undefined ? '' : `DESC LIMIT ${recent}`}`).all() as { data: string }[];
    if (recent !== undefined) rows.reverse();
    return rows.map(row => JSON.parse(row.data) as T);
  }

  private record<T>(table: string, id: string): T | undefined {
    this.requireOpen();
    const row = this.db.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) as T : undefined;
  }

  private count(table: string): number {
    return (this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
  }

  private checkConfigBudget(): void {
    const config = { sources: this.rows('sources'), subscriptions: this.rows('subscriptions'), schedules: this.rows('schedules') };
    if (Buffer.byteLength(serialized(config)) > MAX_CONFIG_BYTES) throw new IntegrationConflictError('Integration configuration exceeds the 2 MiB budget');
  }

  private command<T>(id: string, fingerprint: string, operation: () => T): T {
    return this.atomic(() => {
      const previous = this.db.prepare('SELECT fingerprint, result FROM commands WHERE id = ?').get(id) as CommandRow | undefined;
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new IntegrationConflictError('Command identity was reused for a different operation');
        return JSON.parse(previous.result) as T;
      }
      const result = operation();
      this.db.prepare('INSERT INTO commands(id, fingerprint, result) VALUES (?, ?, ?)').run(id, fingerprint, serialized(result));
      return result;
    });
  }

  private atomic<T>(operation: () => T): T {
    this.requireOpen();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private requireOpen(): void {
    if (this.closed) throw new Error('Integration store is closed');
  }
}
