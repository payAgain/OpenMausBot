import type { CommandAllowlistCandidate } from "./command-allowlist.ts";
import type { TeamSetupRequest } from "./team-setup.ts";
import type { AccessRequestCardField } from "./bot-access.ts";
import type { RoutineRequestCardData } from "./routine-request.ts";
import type { WebhookRequestCardData } from "./webhook-request.ts";
import type { WaitCardField } from "./wait-request.ts";
import type { ComputerAskField } from "./computer-ask.ts";
import type { AppTriggerRequestCardData } from "./app-triggers.ts";
import type { ProfileRequestCardData } from "./profile-request.ts";
import type { ModelRequestCardData } from "./model-request.ts";
import type { McpChangeRequest } from "./mcp-request.ts";
import type { SkillRequestCardData } from "./skill-request.ts";
import type { OutsideWriteCardField } from "./outside-write.ts";
import type { QuestionRequestCardData } from "./ask-question.ts";

/** Who answered a card: a signed-in person (named as their messages are), the owner on this machine, a session-less
 * local caller on a shared server (`worker`: the Slack worker, or any other process on that machine), or at Full access
 * the bot that decides a teammate's question (`bot`: no `answeredText` yet while it decides; "" when it picks itself). */
export type CardAnswerer = (
  /** `person`: the answering session's opaque person key, so the owner checks
   * can tell whose answer it was. */
  | { kind: "session"; name: string; person?: string }
  | { kind: "loopback" }
  | { kind: "worker" } | { kind: "bot"; name: string }
) & {
  /** "call": decided by voice on a Live call; "reaction": by a 👍 or 👎 on the
   * card. Absent: tapped. */
  via?: "call" | "reaction";
};

export interface OptionCardData extends WaitCardField, ComputerAskField, AccessRequestCardField, OutsideWriteCardField {
  /** The harness asks the owner to let this line of theirs use the lent computer (server/host/lending-lifts.ts). */ lendingLift?: { requestMessageId: string; memoryToken?: string; outside?: true; botOpened?: true; allowedAt?: number };
  /** calls: one per outbound call the card covers, in subtitle order. */
  outboundRequest?: { tool: string; app: string | null; calls?: Array<{ app: string | null; label: string }> };
  /** `revision`: the entry as it applied without a person, so Undo can tell it changed since. */
  teamMemoryRequest?: { section: string; entryId: string; kind: string; revision?: string };
  title: string;
  subtitle: string;
  options: string[];
  /** Distinguishes a provider question from an approval after its live run ends. */
  requestType?: "permission" | "question";
  answered?: string;
  /** What was actually answered, when the answer is words rather than a
   * verdict. */
  answeredText?: string;
  dismissed?: boolean;
  /** Who settled the card, when a person or service answered it. */
  answeredBy?: CardAnswerer;
  /** Present when this card is a live provider ask (approval/question). */
  requestId?: string;
  /** Native task identity survives the input turn; resolving this card cannot authorize a different call. */
  superagent?: {
    contextId: string;
    requestId: string;
    ticketId?: string;
    agentId?: string;
    callId?: string;
    authorizationVersion?: number;
  };
  /** permission cards: the tool being requested. */
  tool?: string;
  /** why this card is waiting: guard, mode, sandbox or delivery error. */
  held?: string;
  /** Terminal: no answer came in time, or this proposal went stale while open (revision mismatch or a superseding
   * request). Nothing can answer it; a fresh proposal is needed, and clients must not offer its options. */
  expired?: boolean;
  /** Stop ended the work that asked: nothing can answer it any more. */
  stopped?: boolean;
  /** Catalog key for held when it is one of the fixed notes. */
  heldCode?: string;
  /** the narrow grant "always allow" remembers for a harness-native card. */
  allowKey?: string;
  /** the provider can remember an allow for the rest of its session. */
  allowSession?: boolean;
  /** Exact native command offered for an owner/admin to remember. */
  commandAllowlist?: CommandAllowlistCandidate;
  /** Local actions never share remembered grants with cloud/tool approvals. */
  approvalScope?: "local-computer";
  /** The bot's change applied without a person (a change to the bot itself,
   * or Full access): clients show a one-line receipt with Undo instead of
   * the approval box. */
  autoApplied?: boolean;
  /** A person undid that change. */
  undone?: boolean;
  /** A durable chat-created routine proposal. */
  routineRequest?: RoutineRequestCardData;
  /** A webhook trigger a bot made or changed from chat. */
  webhookRequest?: WebhookRequestCardData;
  /** An app-event automation a bot made or changed from chat. */
  appTriggerRequest?: AppTriggerRequestCardData;
  /** A durable profile-change proposal (propose_profile). */
  profileRequest?: ProfileRequestCardData;
  /** A durable default-model proposal (propose_model). */
  modelRequest?: ModelRequestCardData;
  teamSetupRequest?: TeamSetupRequest;
  /** A bot's MCP server change waiting on the person (Ask, Edits or Auto). */
  mcpRequest?: McpChangeRequest;
  /** A durable learned-skill proposal. */
  skillRequest?: SkillRequestCardData;
  /** A provider's structured question set. */
  questionRequest?: QuestionRequestCardData;
  /** The options are the whole answer: clients offer no free-text reply. */
  fixedOptions?: boolean;
  quotaSwitch?: QuotaSwitchCardData;
  /** Asks before a bot uses the person's own computer; what its first call names, for the question in their language. */
  yourComputer?: { app?: string; site?: string };
}

/** Kept on the card so the offer survives a restart. `engines` follow the card's options; `messageId` is the
 * message to resend, `rootId` the failed request's job-runtime root. */
export interface QuotaSwitchCardData {
  engines: Array<{ instanceId: string; name: string }>;
  messageId?: string;
  rootId?: string;
}
