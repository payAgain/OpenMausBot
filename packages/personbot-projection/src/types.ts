export type { RuntimeEvent } from '../../personbot-protocol/src/index.ts';

/** Browser-safe native event envelope; unknown event data remains in the ledger. */
export interface NativeSessionEvent {
  readonly seq: number;
  readonly time: number;
  readonly type: string;
  readonly data: unknown;
  readonly surfaceOp?: unknown;
  readonly sourceEventSeqs?: readonly number[];
  readonly ignorable?: true;
}

export interface SessionSummary {
  readonly sessionId: string;
  readonly cwd: string;
  readonly conversationId?: string;
  readonly taskId?: string;
  readonly rootSessionId?: string;
  readonly status: 'running' | 'idle' | 'closed';
  readonly pendingStops: readonly string[];
  readonly projectId?: string;
  readonly roleId?: string;
  readonly roleRevision?: number;
}

export interface UserQuestion {
  readonly id: string;
  readonly question: string;
  readonly detail?: string;
  readonly header?: string;
  readonly multiSelect?: boolean;
  readonly options?: readonly { readonly label: string; readonly description?: string }[];
  readonly intent?: unknown;
}

interface DecisionIdentity {
  readonly requestId: string;
  readonly generation: string;
  readonly sessionId: string;
  readonly rootSessionId?: string;
}

export type PendingDecision =
  | (DecisionIdentity & {
      readonly kind: 'approval';
      readonly toolName: string;
      readonly callId?: string;
      readonly reason?: string;
    })
  | (DecisionIdentity & {
      readonly kind: 'question';
      readonly questions: readonly UserQuestion[];
    });

export interface NativeLogPage {
  readonly sessionId: string;
  readonly events: readonly NativeSessionEvent[];
  readonly nextSeq: number;
  readonly hasMore: boolean;
}

/** A snapshot with logs scopes its pending list to those sessions; an empty logs list covers all sessions. */
export interface RuntimeSnapshot {
  readonly generation: string;
  readonly eventSeq: number;
  readonly sessions: readonly SessionSummary[];
  readonly logs: readonly NativeLogPage[];
  readonly pending: readonly PendingDecision[];
}

export type TranscriptBlock =
  | { readonly type: 'text' | 'reasoning'; readonly text: string }
  | {
      readonly type: 'attachment';
      readonly kind: 'image' | 'file';
      readonly attachment: unknown;
      readonly offloaded?: boolean;
    }
  | { readonly type: 'unsupported'; readonly nativeType: string; readonly data: unknown };

interface RowIdentity {
  readonly id: string;
  readonly seq: number;
  readonly time: number;
  readonly turn?: number;
  readonly step?: number;
}

export interface MessageRow extends RowIdentity {
  readonly kind: 'message';
  readonly role: 'user' | 'assistant';
  readonly messageId: string;
  readonly blocks: readonly TranscriptBlock[];
  readonly text: string;
  readonly reasoning: string;
  readonly status: 'complete' | 'streaming' | 'settling' | 'interrupted';
}

export interface ToolRow extends RowIdentity {
  readonly kind: 'tool';
  readonly callId: string;
  readonly name: string;
  readonly arguments: string;
  readonly status: 'requested' | 'running' | 'succeeded' | 'failed' | 'interrupted';
  readonly result?: readonly TranscriptBlock[];
  readonly resultText?: string;
  readonly error?: { readonly name?: string; readonly code?: string; readonly reason?: string };
  readonly meta?: unknown;
}

export interface NoticeRow extends RowIdentity {
  readonly kind: 'notice';
  readonly level: 'info' | 'warning' | 'error';
  readonly code: string;
  readonly message: string;
}

export type TranscriptRow = MessageRow | ToolRow | NoticeRow;

export interface StreamChunkRecord {
  readonly index: number;
  readonly time: number;
  readonly chunk: unknown;
}

export interface AssistantStreamProjection {
  readonly attemptId: string;
  readonly revision: number;
  readonly startRevision: number;
  readonly turn: number;
  readonly step: number;
  readonly chunks: readonly StreamChunkRecord[];
  readonly status: 'streaming' | 'settling';
  readonly settlementSeq?: number;
}

export interface SessionProjection {
  readonly sessionId: string;
  readonly summary?: SessionSummary;
  readonly status: SessionSummary['status'] | 'unknown';
  readonly events: readonly NativeSessionEvent[];
  readonly durableRows: readonly TranscriptRow[];
  readonly rows: readonly TranscriptRow[];
  /** The first missing native sequence from zero, suitable for snapshots.get.fromSeq. */
  readonly nextSeq: number;
  readonly hasMore: boolean;
  readonly snapshotCursor?: number;
  readonly snapshotEndSeq?: number;
  readonly stream?: AssistantStreamProjection;
  readonly lastStreamRevision: number;
  readonly error?: string;
}

/** All reducers preserve previous state and accept deeply frozen inputs. */
export interface TranscriptState {
  readonly generation?: string;
  readonly eventSeq: number;
  readonly sessions: Readonly<Record<string, SessionProjection>>;
  readonly pending: readonly PendingDecision[];
  readonly retiredGenerations: readonly string[];
}
