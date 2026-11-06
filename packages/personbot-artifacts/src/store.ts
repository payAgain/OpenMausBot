import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, constants, mkdirSync } from 'node:fs';
import { link, open, realpath, stat, unlink } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ArtifactChunk, ArtifactRecord, ArtifactSnapshot } from '../../personbot-protocol/src/index.ts';

export const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;
export const MAX_ARTIFACT_CHUNK_BYTES = 512 * 1024;

/** Owner metadata is supplied by the runtime after resolving the native Session binding. */
export interface PublishArtifactParams {
  commandId: string;
  artifactId: string;
  sessionId: string;
  originSessionId: string;
  taskId?: string;
  executionId?: string;
  projectId?: string;
  cwd: string;
  path: string;
  name?: string;
}

interface CommandRow {
  fingerprint: string;
  result: string;
}

export class ArtifactConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArtifactConflictError';
  }
}

const MEDIA_TYPES: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.json': 'application/json',
  '.jsonl': 'application/x-ndjson',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

function text(value: unknown, label: string, limit = 256): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit
    || Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    throw new TypeError(`${label} must be non-empty text without control characters, at most ${limit} characters`);
  }
}

function inside(directory: string, path: string): boolean {
  const entry = relative(directory, path);
  return entry !== '' && entry !== '..' && !entry.startsWith(`..${sep}`) && !isAbsolute(entry);
}

function fingerprint(params: PublishArtifactParams): string {
  return JSON.stringify(Object.fromEntries(Object.entries(params).sort(([a], [b]) => a.localeCompare(b))));
}

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function artifactName(params: PublishArtifactParams): string {
  const name = params.name ?? basename(params.path);
  text(name, 'name');
  if (name === '.' || name === '..' || /[/\\]/.test(name)) throw new TypeError('name must be a filename without path separators');
  return name;
}

export class ArtifactStore {
  private readonly db: DatabaseSync;
  private readonly blobs: string;
  private serial: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(home: string) {
    this.blobs = join(home, 'artifacts', 'blobs');
    const path = join(home, 'runtime', 'artifacts.sqlite');
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    mkdirSync(this.blobs, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    try {
      const version = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
      if (version.user_version > 1) throw new Error(`Unsupported artifact store version: ${version.user_version}`);
      chmodSync(path, 0o600);
      this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;');
      this.db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS artifacts (
          id TEXT PRIMARY KEY NOT NULL,
          session_id TEXT NOT NULL,
          origin_session_id TEXT NOT NULL,
          task_id TEXT,
          data TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS artifacts_session ON artifacts(session_id);
        CREATE INDEX IF NOT EXISTS artifacts_origin ON artifacts(origin_session_id);
        CREATE INDEX IF NOT EXISTS artifacts_task ON artifacts(task_id);
        CREATE TABLE IF NOT EXISTS commands (
          id TEXT PRIMARY KEY NOT NULL,
          fingerprint TEXT NOT NULL,
          result TEXT NOT NULL
        );
        PRAGMA user_version = 1;
        COMMIT;
      `);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  publish(params: PublishArtifactParams, admitted: () => void = () => {}): Promise<ArtifactRecord> {
    const request = { ...params };
    const result = this.serial.catch(() => {}).then(() => this.publishOne(request, admitted));
    this.serial = result;
    return result;
  }

  /** A source conversation includes its own artifacts and results from its task workers. */
  list(filters: { sessionId?: string; taskId?: string } = {}): ArtifactSnapshot {
    this.requireOpen();
    if (filters.sessionId !== undefined) text(filters.sessionId, 'sessionId');
    if (filters.taskId !== undefined) text(filters.taskId, 'taskId');
    const rows = this.db.prepare('SELECT data FROM artifacts ORDER BY rowid').all() as { data: string }[];
    return {
      artifacts: rows.map(row => JSON.parse(row.data) as ArtifactRecord).filter(record =>
        (filters.sessionId === undefined || record.sessionId === filters.sessionId || record.originSessionId === filters.sessionId)
        && (filters.taskId === undefined || record.taskId === filters.taskId)),
    };
  }

  get(id: string): ArtifactRecord | undefined {
    this.requireOpen();
    text(id, 'artifactId');
    const row = this.db.prepare('SELECT data FROM artifacts WHERE id = ?').get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) as ArtifactRecord : undefined;
  }

  async read(params: { artifactId: string; offset?: number; limit?: number }): Promise<ArtifactChunk> {
    const record = this.get(params.artifactId);
    if (!record) throw new Error('Unknown artifact');
    const offset = params.offset ?? 0;
    const limit = params.limit ?? MAX_ARTIFACT_CHUNK_BYTES;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > record.size) throw new RangeError('Invalid artifact offset');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ARTIFACT_CHUNK_BYTES) throw new RangeError('Invalid artifact chunk limit');
    const bytes = await this.readBlob(record);
    const chunk = bytes.subarray(offset, Math.min(offset + limit, bytes.length));
    return {
      artifact: record,
      offset,
      nextOffset: offset + chunk.length,
      eof: offset + chunk.length === record.size,
      dataBase64: chunk.toString('base64'),
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private requireOpen(): void {
    if (this.closed) throw new Error('Artifact store is closed');
  }

  private async publishOne(params: PublishArtifactParams, admitted: () => void): Promise<ArtifactRecord> {
    this.requireOpen();
    for (const key of ['commandId', 'artifactId', 'sessionId', 'originSessionId'] as const) text(params[key], key);
    for (const key of ['taskId', 'executionId', 'projectId'] as const) {
      if (params[key] !== undefined) text(params[key], key);
    }
    text(params.cwd, 'cwd', 16_384);
    text(params.path, 'path', 16_384);
    if (!isAbsolute(params.cwd)) throw new TypeError('Artifact cwd must be an absolute directory');
    const name = artifactName(params);
    const key = fingerprint(params);
    const replay = this.command(params.commandId, key);
    if (replay) return replay;
    admitted();
    if (this.get(params.artifactId)) throw new ArtifactConflictError('Artifact identity already exists');
    const bytes = await this.sourceBytes(params);
    const record: ArtifactRecord = {
      id: params.artifactId,
      name,
      mediaType: MEDIA_TYPES[extname(params.path).toLowerCase()] ?? 'application/octet-stream',
      size: bytes.length,
      sha256: hash(bytes),
      sessionId: params.sessionId,
      originSessionId: params.originSessionId,
      ...(params.taskId === undefined ? {} : { taskId: params.taskId }),
      ...(params.executionId === undefined ? {} : { executionId: params.executionId }),
      ...(params.projectId === undefined ? {} : { projectId: params.projectId }),
      createdAt: new Date().toISOString(),
    };
    await this.persistBlob(record, bytes);
    this.requireOpen();
    admitted();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const concurrent = this.command(params.commandId, key);
      if (concurrent) {
        this.db.exec('COMMIT');
        return concurrent;
      }
      if (this.get(params.artifactId)) throw new ArtifactConflictError('Artifact identity already exists');
      const data = JSON.stringify(record);
      this.db.prepare('INSERT INTO artifacts(id, session_id, origin_session_id, task_id, data) VALUES (?, ?, ?, ?, ?)')
        .run(record.id, record.sessionId, record.originSessionId, record.taskId ?? null, data);
      this.db.prepare('INSERT INTO commands(id, fingerprint, result) VALUES (?, ?, ?)').run(params.commandId, key, data);
      this.db.exec('COMMIT');
      return record;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private command(id: string, key: string): ArtifactRecord | undefined {
    const row = this.db.prepare('SELECT fingerprint, result FROM commands WHERE id = ?').get(id) as CommandRow | undefined;
    if (!row) return undefined;
    if (row.fingerprint !== key) throw new ArtifactConflictError('Command identity was reused with a different artifact request');
    return JSON.parse(row.result) as ArtifactRecord;
  }

  private async sourceBytes(params: PublishArtifactParams): Promise<Buffer> {
    const directory = await realpath(params.cwd);
    if (!(await stat(directory)).isDirectory()) throw new TypeError('Artifact cwd must be a directory');
    const requested = resolve(params.cwd, params.path);
    if (!inside(resolve(params.cwd), requested)) throw new Error('Artifact path must stay inside the Session workspace');
    const path = await realpath(requested);
    if (!inside(directory, path)) throw new Error('Artifact symlink escapes the Session workspace');
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await file.stat();
      if (!before.isFile()) throw new TypeError('Artifact source must be a regular file');
      if (before.size > MAX_ARTIFACT_BYTES) throw new RangeError('Artifact exceeds the 20 MiB limit');
      const bytes = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < bytes.length) {
        const read = await file.read(bytes, offset, bytes.length - offset, offset);
        if (read.bytesRead === 0) throw new Error('Artifact source changed while publishing');
        offset += read.bytesRead;
      }
      const extra = await file.read(Buffer.alloc(1), 0, 1, offset);
      const after = await file.stat();
      const current = await stat(path);
      if (extra.bytesRead > 0 || before.size !== after.size || before.mtimeMs !== after.mtimeMs
        || current.dev !== after.dev || current.ino !== after.ino || !inside(directory, await realpath(path))) {
        throw new Error('Artifact source changed while publishing');
      }
      return bytes;
    } finally {
      await file.close();
    }
  }

  private blobPath(record: ArtifactRecord): string {
    if (!/^[a-f0-9]{64}$/.test(record.sha256)) throw new Error('Artifact metadata contains an invalid content hash');
    return join(this.blobs, record.sha256);
  }

  private async readBlob(record: ArtifactRecord): Promise<Buffer> {
    let bytes: Buffer;
    try {
      const path = this.blobPath(record);
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size !== record.size || info.size > MAX_ARTIFACT_BYTES) {
          throw new Error('Artifact blob has an invalid file type or size');
        }
        bytes = Buffer.alloc(record.size);
        let offset = 0;
        while (offset < bytes.length) {
          const read = await file.read(bytes, offset, bytes.length - offset, offset);
          if (read.bytesRead === 0) throw new Error('Artifact blob changed while reading');
          offset += read.bytesRead;
        }
        const extra = await file.read(Buffer.alloc(1), 0, 1, offset);
        if (extra.bytesRead > 0) throw new Error('Artifact blob changed while reading');
      } finally {
        await file.close();
      }
    } catch (error) {
      throw new Error('Artifact blob is missing, inaccessible or invalid', { cause: error });
    }
    if (bytes.length !== record.size || hash(bytes) !== record.sha256) throw new Error('Artifact blob failed integrity verification');
    return bytes;
  }

  private async persistBlob(record: ArtifactRecord, bytes: Buffer): Promise<void> {
    const temporary = join(this.blobs, `.pending-${randomUUID()}`);
    try {
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      try {
        await link(temporary, this.blobPath(record));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        await this.readBlob(record);
      }
      if (process.platform !== 'win32') {
        const directory = await open(this.blobs, constants.O_RDONLY);
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
    } finally {
      await unlink(temporary).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
    }
  }
}
