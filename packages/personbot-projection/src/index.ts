import type { RuntimeEvent } from '../../personbot-protocol/src/index.ts';
import { number, object, projectSessionEvents, projectStream } from './transcript.ts';
import type {
  AssistantStreamProjection,
  NativeSessionEvent,
  PendingDecision,
  RuntimeSnapshot,
  SessionProjection,
  TranscriptState,
  UserQuestion,
} from './types.ts';

export type * from './types.ts';
export { projectSessionEvents } from './transcript.ts';

function copySessions(sessions: Readonly<Record<string, SessionProjection>> = {}): Record<string, SessionProjection> {
  return Object.assign(Object.create(null) as Record<string, SessionProjection>, sessions);
}

export function createTranscriptState(): TranscriptState {
  return { eventSeq: 0, sessions: copySessions(), pending: [], retiredGenerations: [] };
}

function replaceSession(state: TranscriptState, session: SessionProjection): TranscriptState {
  const sessions = copySessions(state.sessions);
  sessions[session.sessionId] = session;
  return { ...state, sessions };
}

function emptySession(sessionId: string): SessionProjection {
  return {
    sessionId, status: 'unknown', events: [], durableRows: [], rows: [],
    nextSeq: 0, hasMore: false, lastStreamRevision: 0,
  };
}

function renderSession(session: SessionProjection): SessionProjection {
  let stream = session.stream;
  if (stream && session.events.some(event => {
    if (event.seq === stream?.settlementSeq) return true;
    const data = object(event.data);
    return event.type === 'assistant/message' && data.turn === stream?.turn && data.step === stream?.step;
  })) stream = undefined;
  const closed = session.status === 'closed';
  const durableRows = closed
    ? session.durableRows.map(row => row.kind === 'tool' && (row.status === 'running' || row.status === 'requested')
      ? { ...row, status: 'interrupted' as const }
      : row)
    : session.durableRows;
  const provisionalRows = stream ? projectStream(stream, (session.events.at(-1)?.seq ?? -1) + 1) : [];
  const ids = new Set(durableRows.map(row => row.id));
  return {
    ...session,
    stream,
    rows: [...durableRows, ...provisionalRows.filter(row => !ids.has(row.id))],
  };
}

function mergeEvents(session: SessionProjection, incoming: readonly NativeSessionEvent[]): SessionProjection {
  const events = new Map(session.events.map(event => [event.seq, event]));
  let changed = false;
  for (const event of incoming) {
    if (number(event.seq) === undefined || typeof event.type !== 'string' || events.has(event.seq)) continue;
    events.set(event.seq, event);
    changed = true;
  }
  if (!changed) return session;
  const sorted = [...events.values()].sort((left, right) => left.seq - right.seq);
  let nextSeq = 0;
  while (events.has(nextSeq)) nextSeq++;
  return renderSession({
    ...session,
    events: sorted,
    nextSeq,
    hasMore: session.snapshotEndSeq === undefined ? session.hasMore : nextSeq < session.snapshotEndSeq,
    durableRows: projectSessionEvents(sorted),
  });
}

function inGeneration(state: TranscriptState, generation: string): TranscriptState | undefined {
  if (state.generation === generation) return state;
  if (!generation || state.retiredGenerations.includes(generation)) return undefined;
  return {
    ...state,
    generation,
    eventSeq: 0,
    pending: [],
    retiredGenerations: state.generation ? [...state.retiredGenerations, state.generation] : state.retiredGenerations,
    sessions: copySessions(Object.fromEntries(Object.entries(state.sessions).map(([id, session]) => [id, renderSession({
      ...session, status: 'closed', stream: undefined, lastStreamRevision: 0, error: undefined,
      snapshotCursor: undefined, snapshotEndSeq: undefined,
    })]))),
  };
}

function pendingDecision(event: RuntimeEvent): PendingDecision | undefined {
  const payload = object(event.payload);
  if (!event.sessionId || typeof payload.requestId !== 'string') return undefined;
  const identity = {
    requestId: payload.requestId,
    generation: event.generation,
    sessionId: event.sessionId,
    ...(typeof payload.rootSessionId === 'string' ? { rootSessionId: payload.rootSessionId } : {}),
  };
  if (event.type === 'approval.requested' && typeof payload.toolName === 'string') {
    return {
      ...identity, kind: 'approval', toolName: payload.toolName,
      ...(typeof payload.callId === 'string' ? { callId: payload.callId } : {}),
      ...(typeof payload.reason === 'string' ? { reason: payload.reason } : {}),
    };
  }
  if (event.type === 'question.requested' && Array.isArray(payload.questions)) {
    const questions = payload.questions.filter(value => {
      const question = object(value);
      return typeof question.id === 'string' && typeof question.question === 'string';
    }) as UserQuestion[];
    return { ...identity, kind: 'question', questions };
  }
  return undefined;
}

function streamFrame(session: SessionProjection, payload: unknown): SessionProjection {
  const frame = object(payload);
  const revision = number(frame.revision);
  if (typeof frame.attemptId !== 'string' || revision === undefined) return session;
  if (frame.type === 'start') {
    const turn = number(frame.turn);
    const step = number(frame.step);
    if (revision <= session.lastStreamRevision || turn === undefined || step === undefined) return session;
    return renderSession({
      ...session, lastStreamRevision: revision, status: 'running', error: undefined,
      stream: { attemptId: frame.attemptId, revision, startRevision: revision, turn, step, chunks: [], status: 'streaming' },
    });
  }
  const stream = session.stream;
  if (!stream || stream.attemptId !== frame.attemptId || revision <= stream.startRevision) return session;
  if (frame.type === 'chunk') {
    const index = number(frame.index);
    if (index === undefined || stream.chunks.some(chunk => chunk.index === index)) return session;
    const chunks = [...stream.chunks, {
      index,
      time: number(frame.time) ?? 0,
      chunk: frame.chunk,
    }].sort((left, right) => left.index - right.index);
    return renderSession({
      ...session,
      lastStreamRevision: Math.max(revision, session.lastStreamRevision),
      stream: { ...stream, revision: Math.max(revision, stream.revision), chunks },
    });
  }
  if (frame.type === 'end') {
    if (revision < stream.revision) return session;
    const outcome = object(frame.outcome);
    let next: AssistantStreamProjection | undefined;
    if (outcome.kind === 'committed' && outcome.eventType === 'assistant/message' && number(outcome.seq) !== undefined) {
      next = { ...stream, revision, status: 'settling', settlementSeq: number(outcome.seq) };
    }
    return renderSession({ ...session, stream: next, lastStreamRevision: revision });
  }
  return session;
}

/** Apply live notifications. Native seq deduplication is independent of the transient event cursor. */
export function reduceRuntimeEvent(previous: TranscriptState, event: RuntimeEvent): TranscriptState {
  if (number(event.eventSeq) === undefined) return previous;
  const current = inGeneration(previous, event.generation);
  if (!current) return previous;
  const fresh = event.eventSeq > current.eventSeq;
  let state: TranscriptState = fresh ? { ...current, eventSeq: event.eventSeq } : current;
  if (event.type === 'session.event' && event.sessionId) {
    const value = object(object(event.payload).event);
    if (number(value.seq) === undefined || typeof value.type !== 'string') return state;
    const session = state.sessions[event.sessionId] ?? emptySession(event.sessionId);
    const updated = mergeEvents(session, [value as unknown as NativeSessionEvent]);
    return updated === session ? state : replaceSession(state, updated);
  }
  if (!fresh) return state;
  if (event.type === 'approval.requested' || event.type === 'question.requested') {
    const decision = pendingDecision(event);
    if (decision) state = { ...state, pending: [...state.pending.filter(item => item.requestId !== decision.requestId), decision] };
  } else if (event.type === 'approval.closed' || event.type === 'question.closed') {
    const id = object(event.payload).requestId;
    state = { ...state, pending: state.pending.filter(item => item.requestId !== id) };
  }
  if (!event.sessionId) return state;
  const session = state.sessions[event.sessionId] ?? emptySession(event.sessionId);
  const payload = object(event.payload);
  let updated = session;
  switch (event.type) {
    case 'session.stream':
      updated = streamFrame(session, payload);
      break;
    case 'session.status':
      if (payload.status === 'running' || payload.status === 'idle' || payload.status === 'closed') {
        updated = renderSession({
          ...session, status: payload.status,
          stream: payload.status === 'running' ? session.stream : undefined,
          error: payload.status === 'running' ? undefined : session.error,
        });
      }
      break;
    case 'session.error':
      if (typeof payload.message === 'string') updated = renderSession({ ...session, error: payload.message, stream: undefined });
      break;
    case 'session.stopped':
      updated = renderSession({
        ...session,
        status: payload.confirmed === true ? 'closed' : session.status,
        stream: undefined,
        error: Array.isArray(payload.errors) && payload.errors.length > 0 ? payload.errors.map(String).join('\n') : session.error,
      });
      break;
  }
  return updated === session ? state : replaceSession(state, updated);
}

/** Merge overlap and reordered pages while preserving live updates newer than the snapshot cursor. */
export function reconcileSnapshot(previous: TranscriptState, snapshot: RuntimeSnapshot): TranscriptState {
  const current = inGeneration(previous, snapshot.generation);
  if (!current || number(snapshot.eventSeq) === undefined) return previous;
  const fresh = snapshot.eventSeq >= current.eventSeq;
  const sessions = copySessions(current.sessions);
  if (fresh) {
    for (const summary of snapshot.sessions) {
      const session = sessions[summary.sessionId] ?? emptySession(summary.sessionId);
      sessions[summary.sessionId] = renderSession({
        ...session,
        summary,
        status: summary.status,
        stream: summary.status === 'running' ? session.stream : undefined,
      });
    }
  }
  for (const page of snapshot.logs) {
    const session = sessions[page.sessionId] ?? emptySession(page.sessionId);
    const merged = mergeEvents(session, page.events);
    if (snapshot.eventSeq >= (session.snapshotCursor ?? -1)) {
      const extendsKnownEnd = page.nextSeq >= (session.snapshotEndSeq ?? Infinity);
      const end = page.hasMore
        ? extendsKnownEnd ? undefined : session.snapshotEndSeq
        : page.nextSeq;
      sessions[page.sessionId] = {
        ...merged,
        snapshotCursor: snapshot.eventSeq,
        snapshotEndSeq: end,
        hasMore: end === undefined ? page.hasMore : merged.nextSeq < end,
      };
    } else sessions[page.sessionId] = merged;
  }
  const scope = new Set(snapshot.logs.map(page => page.sessionId));
  const pending = fresh ? [
    ...current.pending.filter(decision =>
      scope.size > 0 && !scope.has(decision.sessionId) && !(decision.rootSessionId && scope.has(decision.rootSessionId))),
    ...snapshot.pending.filter(decision => decision.generation === snapshot.generation),
  ] : current.pending;
  return {
    ...current, sessions, pending,
    eventSeq: Math.max(current.eventSeq, snapshot.eventSeq),
  };
}
