import type { ApprovalMode } from "./approval-mode.ts";

export interface SuperagentBinding {
  botId: string;
  threadId: string;
  /** Native context identity; a branch reset must use a fresh value rather than continue removed messages. */
  contextId?: string;
}

/** The native adapter supplies this identity; tool arguments cannot select or upgrade its authority. */
export interface SuperagentCaller {
  requestId: string;
  sourceMessageId?: string;
  authorizationVersion: number;
  agentId: string;
  role: "master" | "worker" | "upkeep";
  ticketId?: string;
}

export interface SuperagentMemoryRequest extends SuperagentBinding {
  operation: "search" | "read" | "remember" | "forget";
  query?: string;
  path?: string;
  text?: string;
  /** A durable fact must cite the latest direct owner message; model output cannot supply its own evidence. */
  evidence?: { messageId: string; quote: string };
  caller?: SuperagentCaller;
}

export interface SuperagentInput extends SuperagentBinding {
  requestId: string;
  /** Original product user message that authorized this input. */
  sourceMessageId?: string;
  text: string;
  cwd?: string;
  instructions?: string;
  model?: string;
  approvalMode?: ApprovalMode;
  /** A directory change preserves work in the preceding context; a branch change retires that branch. */
  contextTransition?: "branch" | "workspace";
  previousContextId?: string;
  authorizationVersion?: number;
}

export interface SuperagentDelivery extends SuperagentBinding {
  requestId: string;
  sourceMessageId?: string;
  messageId: string;
  text: string;
  purpose: string;
  ticketId?: string;
}

export interface SuperagentDecisionState extends SuperagentBinding {
  decisionId: string;
  requestId: string;
  sourceMessageId?: string;
  ticketId?: string;
  agentId?: string;
  callId?: string;
  authorizationVersion?: number;
  kind: "approval" | "question";
  prompt: string;
  status: "pending" | "resolved" | "expired";
}

export interface SuperagentTaskState extends SuperagentBinding {
  ticketId: string;
  requestId: string;
  sourceMessageId?: string;
  title?: string;
  state: string;
  workspace?: string;
  sessionId?: string;
  ended?: boolean;
}

export interface SuperagentUsage {
  usageId: string;
  requestId: string;
  agentId: string;
  role: "master" | "worker" | "upkeep";
  ticketId?: string;
  provider?: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
}

export interface SuperagentUsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  knownCostUsd: number;
  unpricedCalls: number;
  costUsd: number | null;
}

/** Shared context overhead is informational: it is not assigned exclusively to this ticket or additive across ticket queries. */
export interface SuperagentTaskUsage extends SuperagentUsageTotals {
  attribution: "ticket-exclusive";
  shared: SuperagentUsageTotals & SuperagentBinding & {
    attribution: "context-unallocated";
    exclusive: false;
    includedInTaskTotal: false;
  };
}

export interface SuperagentSnapshot {
  bindings: Array<SuperagentBinding & { workspace: string; active: boolean }>;
  tasks: SuperagentTaskState[];
  decisions: SuperagentDecisionState[];
  resources: {
    activeCalls: number;
    queuedCalls: number;
    maxConcurrentCalls: number;
    inputTokens: number;
    outputTokens: number;
    tokenLimit?: number;
    costUsd?: number;
    costLimitUsd?: number;
    admittedCalls?: number;
    requestLimit?: number;
    /** A reported dollar sum is incomplete whenever calls lack a trustworthy price. */
    unpricedCalls?: number;
    unreportedCalls?: number;
    quarantinedWorkspaces?: Array<{ id: string; workspace: string; reason: string; at: string }>;
  };
}

export interface SuperagentInterrupt {
  scope: "request" | "task" | "conversation";
  requestId?: string;
  ticketId?: string;
}

export type SuperagentEvent =
  | (SuperagentBinding & { type: "started"; requestId: string; sessionId?: string })
  | (SuperagentDelivery & { type: "reply"; persisted?: boolean })
  | (SuperagentBinding & { type: "text"; requestId: string; text: string; sessionId: string })
  | (SuperagentBinding & { type: "tool"; requestId: string; callId: string; name: string; phase: "start" | "end"; input?: unknown; output?: unknown })
  | (SuperagentBinding & { type: "completed"; requestId: string; sessionId?: string })
  | (SuperagentBinding & { type: "failed"; requestId: string; error: string })
  | (SuperagentBinding & { type: "approval" | "question"; requestId: string; decisionId: string; prompt: string; sourceMessageId?: string; ticketId?: string; agentId?: string; callId?: string; authorizationVersion?: number })
  | (SuperagentBinding & { type: "decision.resolved"; requestId: string; decisionId: string; behavior?: "allow" | "deny" | "answer"; reason?: string })
  | (SuperagentTaskState & { type: "task" })
  | (SuperagentBinding & { type: "activity"; requestId: string; tasks: number; pendingDeliveries: number; pendingDecisions: number })
  | (SuperagentBinding & SuperagentUsage & { type: "usage" });

/** The original product consumes this port; execution and task state belong to the upstream runtime. */
export interface SuperagentGateway {
  start(): Promise<void>;
  submit(input: SuperagentInput): Promise<void>;
  interrupt(binding: SuperagentBinding, target?: SuperagentInterrupt): Promise<void>;
  respond(binding: SuperagentBinding, decisionId: string, answer: { behavior: "allow" | "deny" | "answer"; message?: string }): Promise<boolean>;
  generateText(prompt: string, options?: { signal?: AbortSignal }): Promise<string>;
  subscribe(listener: (event: SuperagentEvent) => void): () => void;
  close(): Promise<void>;
  status(): { enabled: boolean; state: string; pid?: number; error?: string };
  inspect?(binding?: SuperagentBinding): Promise<SuperagentSnapshot>;
  isActiveBinding?(binding: SuperagentBinding): boolean;
  /** Permanently revokes the selected native context, or every context of the thread when omitted. */
  revoke?(binding: SuperagentBinding): Promise<void>;
  authorizeMemory?(request: SuperagentMemoryRequest): boolean;
  releaseWorkspace?(id: string): Promise<boolean>;
}
