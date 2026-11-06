import type { PersonbotGateway } from '../../packages/personbot-gateway/src/index.ts';
import { parseRequest, ProtocolError, type ArtifactChunk, type ArtifactRecord } from '../../packages/personbot-protocol/src/index.ts';
import { RuntimeRpcError } from '../../packages/personbot-runtime-host/src/index.ts';
import { ownerOrAdmin, type RequestAuth } from '../request-auth.ts';
import { PASS, type RouteContext, type RouteHandler } from './table.ts';

export interface PersonbotRouteOptions {
  gateway: Pick<PersonbotGateway, 'status' | 'request' | 'start' | 'subscribe'>;
  live(auth: RequestAuth): boolean;
  onRevoked(listener: (sessionId: string) => void): () => void;
}

export interface PersonbotIngressOptions {
  gateway: Pick<PersonbotGateway, 'status' | 'ingest'>;
  claimRequest?(): () => void;
}

const MAX_SOURCE_BODY_BYTES = 40 * 1024;
const INVALID_SOURCE_TOKEN = 'Invalid source credentials';

export function createPersonbotIngress(options: PersonbotIngressOptions) {
  return async ({ req, res, method, path, json, readBody }: Pick<RouteContext, 'req' | 'res' | 'method' | 'path' | 'json' | 'readBody'>): Promise<boolean> => {
    const match = /^\/api\/personbot\/sources\/([^/]+)\/events$/.exec(path);
    if (method !== 'POST' || !match) return false;
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    const authorization = req.headers.authorization;
    const token = typeof authorization === 'string' ? /^Bearer[ \t]+([^\s,]{32,256})$/i.exec(authorization)?.[1] : undefined;
    if (!token) {
      json(res, 401, { error: INVALID_SOURCE_TOKEN });
      return true;
    }
    if (!options.gateway.status().enabled) {
      json(res, 503, { error: 'Personbot is disabled' });
      return true;
    }
    if (!/^application\/json(?:[ \t]*;|$)/i.test(String(req.headers['content-type'] ?? ''))) {
      json(res, 415, { error: 'Source events require application/json' });
      return true;
    }
    let release: (() => void) | undefined;
    try {
      release = options.claimRequest?.();
      const sourceId = decodeURIComponent(match[1]!);
      const body: unknown = await readBody(req, MAX_SOURCE_BODY_BYTES);
      if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).some(key => !['eventId', 'threadId', 'text'].includes(key))) {
        json(res, 400, { error: 'Expected {eventId, threadId, text}' });
        return true;
      }
      parseRequest({
        jsonrpc: '2.0', id: 0, method: 'personbot.v1.sources.ingest',
        params: { ...body, sourceId, token },
      });
      const result = await options.gateway.ingest(sourceId, token, body);
      json(res, 202, result);
    } catch (error) {
      const code = error instanceof ProtocolError || error instanceof RuntimeRpcError ? error.code : undefined;
      const readStatus = (error as { status?: unknown } | null)?.status;
      const status = code === -32001 ? 401 : error instanceof URIError || code === -32602 || readStatus === 400 ? 400
        : readStatus === 413 ? 413 : code === -32000 ? 409 : 503;
      const message = status === 401 ? INVALID_SOURCE_TOKEN
        : status === 413 ? 'Source event body exceeds 40 KiB'
          : status === 400 ? 'Invalid source event'
            : status === 409 ? 'Source event could not be accepted'
              : 'Source event service is unavailable';
      json(res, status, { error: message });
    } finally {
      release?.();
    }
    return true;
  };
}

export function createPersonbotRoutes(options: PersonbotRouteOptions): RouteHandler {
  return async ({ req, res, method, path, url, auth, json, readBody }) => {
    if (!path.startsWith('/api/personbot/')) return PASS;
    if (!ownerOrAdmin(auth) || !options.live(auth)) return json(res, 403, { error: 'Personbot requires owner access' });
    const gateway = options.gateway;
    if (path === '/api/personbot/status' && method === 'GET') return json(res, 200, gateway.status());
    const artifactPath = /^\/api\/personbot\/artifacts\/([^/]+)\/content$/.exec(path);
    if (artifactPath && method === 'GET') {
      try {
        const artifactId = decodeURIComponent(artifactPath[1]!);
        let offset = 0;
        let artifact: ArtifactRecord | undefined;
        const parts: Buffer[] = [];
        for (;;) {
          const chunk = await gateway.request('personbot.v1.artifacts.read', { artifactId, offset, limit: 512 * 1024 }, () => options.live(auth)) as ArtifactChunk;
          if (!options.live(auth) || req.destroyed) return json(res, 401, { error: 'Your session ended' });
          const bytes = Buffer.from(chunk.dataBase64, 'base64');
          if (chunk.artifact?.id !== artifactId || !Number.isSafeInteger(chunk.artifact.size) || chunk.artifact.size < 0
            || chunk.artifact.size > 20 * 1024 * 1024 || chunk.offset !== offset || bytes.length > 512 * 1024
            || chunk.nextOffset !== offset + bytes.length || chunk.nextOffset > chunk.artifact.size
            || (chunk.eof ? chunk.nextOffset !== chunk.artifact.size : !bytes.length)
            || (artifact && JSON.stringify(chunk.artifact) !== JSON.stringify(artifact))) {
            throw new Error('Invalid artifact content response');
          }
          artifact ??= chunk.artifact;
          parts.push(bytes);
          offset = chunk.nextOffset;
          if (chunk.eof) break;
        }
        const mediaType = artifact.mediaType.toLowerCase().split(';', 1)[0]!.trim();
        const inline = url.searchParams.get('inline') === '1' && (
          ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'application/json', 'application/xml'].includes(mediaType)
          || mediaType.startsWith('text/') && mediaType !== 'text/html'
        );
        const filename = artifact.name.replace(/[^\x20-\x7E]|["\\]/g, '_').slice(0, 180) || 'artifact';
        const encodedName = encodeURIComponent(artifact.name).replace(/['()*]/g, (value) => `%${value.charCodeAt(0).toString(16).toUpperCase()}`);
        res.writeHead(200, {
          'content-type': inline && !mediaType.startsWith('image/') ? 'text/plain; charset=utf-8' : artifact.mediaType,
          'content-length': offset,
          'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${filename}"; filename*=UTF-8''${encodedName}`,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'none'; sandbox",
        });
        res.end(Buffer.concat(parts, offset));
        return;
      } catch (error) {
        const code = error instanceof ProtocolError || error instanceof RuntimeRpcError ? error.code : undefined;
        return json(res, code === -32001 ? 401 : code === -32602 || error instanceof URIError ? 400 : code === -32000 ? 404 : 503, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (path === '/api/personbot/rpc' && method === 'POST') {
      const body: unknown = await readBody(req);
      if (!options.live(auth)) return json(res, 401, { error: 'Your session ended' });
      if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).some(key => key !== 'method' && key !== 'params')) {
        return json(res, 400, { error: 'Expected {method, params}' });
      }
      try {
        const input = body as { method?: unknown; params?: unknown };
        const result = await gateway.request(input.method, input.params, () => options.live(auth));
        return json(res, 200, result);
      } catch (error) {
        const code = error instanceof ProtocolError || error instanceof RuntimeRpcError ? error.code : undefined;
        return json(res, code === -32001 ? 401 : code === -32602 || code === -32600 || code === -32601 ? 400 : code === -32000 ? 409 : 503, {
          error: error instanceof Error ? error.message : String(error), ...(code === undefined ? {} : { code }),
        });
      }
    }
    if (path !== '/api/personbot/events' || method !== 'GET') return json(res, 404, { error: 'Unknown Personbot endpoint' });
    try { await gateway.start(); }
    catch (error) { return json(res, 503, { error: error instanceof Error ? error.message : String(error) }); }
    if (!options.live(auth) || req.destroyed) return json(res, 401, { error: 'Your session ended' });
    res.writeHead(200, {
      'content-type': 'text/event-stream', 'cache-control': 'no-cache',
      connection: 'keep-alive', 'x-accel-buffering': 'no',
    });
    req.socket.setTimeout(0);
    let stopped = false;
    let unsubscribe = () => {};
    let revoke = () => {};
    const close = () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      unsubscribe();
      revoke();
      res.end();
    };
    const write = (frame: unknown) => {
      if (stopped) return;
      if (!options.live(auth) || res.writableLength > 4 * 1024 * 1024) return close();
      res.write(`data: ${JSON.stringify(frame)}\n\n`);
    };
    const timer = setInterval(() => {
      if (!options.live(auth) || gateway.status().state === 'closing') return close();
      res.write(': keepalive\n\n');
    }, 2_000);
    timer.unref();
    unsubscribe = gateway.subscribe(frame => {
      write(frame);
      if (frame.kind === 'gateway' && (frame.state === 'failed' || frame.state === 'closing')) close();
    });
    revoke = options.onRevoked(id => { if (auth.kind === 'session' && auth.session.id === id) close(); });
    req.on('close', close);
    res.on('error', close);
    write({ kind: 'gateway', ...gateway.status() });
  };
}
