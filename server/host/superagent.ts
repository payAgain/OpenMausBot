import { homedir } from "node:os";
import { join } from "node:path";
import type { SuperagentGateway } from "../../shared/superagent.ts";
import { approvalModeFor } from "../../shared/approval-mode.ts";
import { createSuperagentGateway } from "../../packages/personbot-superagent/src/index.ts";
import { PersonbotSettings } from "../personbot-settings.ts";
import { createSuperagentDriver, SUPERAGENT_INSTANCE_ID } from "../superagent-driver.ts";
import { createSuperagentDelivery } from "../superagent-delivery.ts";
import { createSuperagentMemory } from "../superagent-memory.ts";
import { createSuperagentProjection } from "../superagent-projection.ts";
import { createSuperagentUsage } from "../superagent-usage.ts";
import { assertWithinBudget, noteSpend } from "../spend.ts";
import { buildNotification, type Notification } from "../notify.ts";
import type { AppConfig } from "../config.ts";
import type { Store } from "../store.ts";
import type { AboutMe } from "../about-me.ts";

type DirectRequest = { messageId?: string; turnId: string | null };
interface NativeContextDeps {
  gateway(): SuperagentGateway | undefined;
  store(): Store;
}
interface SuperagentDriverHostDeps extends NativeContextDeps {
  settings: PersonbotSettings;
  fixture: boolean;
  request(threadId: string): DirectRequest | undefined;
}
interface SuperagentHostDeps {
  store: Store;
  aboutMeFacts: AboutMe;
  CLOUD_TEAM: boolean;
  cfg: AppConfig;
  SUPERAGENT_PRIMARY: boolean;
  personbotHome: string;
  personbotWorkspace: string;
  personbotFixture: boolean;
  personbotSettings: PersonbotSettings;
  isInternalTurn(threadId: string): boolean;
  isUnattended(botId: string, threadId: string): boolean;
  threadBusy(botId: string, threadId: string): boolean;
  request(threadId: string): DirectRequest | undefined;
  setLastReply(threadId: string, text: string): void;
  notify(notification: Notification | null): void;
  DATA_DIR: string;
}

export function createPersonbotSettingsHost() {
const personbotHome = process.env.PERSONBOT_HOME || join(homedir(), ".personbot");
const personbotFixture = process.env.PERSONBOT_FIXTURE === "1" && process.env.OMB_TEST_SEALED_PATH === "1";
const personbotWorkspace = process.env.PERSONBOT_WORKSPACE || join(personbotHome, "workspace");
const personbotSettings = new PersonbotSettings({
  home: personbotHome, workspace: personbotWorkspace,
  provider: personbotFixture ? "personbot-fixture" : process.env.PERSONBOT_PROVIDER || "deepseek-official",
  model: personbotFixture ? "fixture" : process.env.PERSONBOT_MODEL || "deepseek-flash",
  fixture: personbotFixture,
});
  return { personbotHome, personbotFixture, personbotWorkspace, personbotSettings };
}

export function createSuperagentDriverHost(deps: SuperagentDriverHostDeps) {
  const { settings: personbotSettings, fixture: personbotFixture } = deps;
const superagentDriver = createSuperagentDriver({
  gateway: () => {
    const officialSuperagentGateway = deps.gateway();
    if (!officialSuperagentGateway) throw new Error("Super Agent is still starting");
    return officialSuperagentGateway;
  },
  model: () => personbotSettings.launch().model,
  configured: () => personbotFixture || Boolean(personbotSettings.launch().env.DEEPSEEK_API_KEY),
  currentBinding: threadId => {
    const store = deps.store();
    const bot = store.botByThread(threadId);
    const task = bot && store.taskByThread(bot.id, threadId);
    const cursor = task?.resumeCursors[SUPERAGENT_INSTANCE_ID];
    if (!bot || !task || task.rewound || typeof cursor !== "string" || !/^omb-superagent:[A-Za-z0-9_-]{1,128}$/.test(cursor)) return undefined;
    const path = store.activePath(threadId);
    const owner = deps.request(threadId);
    const source = path.findLast(message => message.role === "user" && message.kind === "text");
    const requestId = owner?.messageId && path.some(message => message.id === owner.messageId) && owner.turnId
      ? owner.turnId : source ? path.findLast(message => message.role === "bot" && message.requestMessageId === source.id && message.turnId)?.turnId : undefined;
    return { botId: bot.id, threadId, contextId: cursor.slice("omb-superagent:".length), ...(requestId ? { requestId } : {}) };
  },
});
  return superagentDriver;
}

export function createNativeContextLifecycle(deps: NativeContextDeps) {
  const nativeLifecycleThreads = new Map<string, number>();
async function teardownNativeContexts(botId?: string, threadId?: string, retire = false): Promise<void> {
  const gateway = deps.gateway();
  if (!gateway?.inspect) return;
  const store = deps.store();
  const threads = threadId ? [threadId] : botId ? store.tasks(botId).map(task => task.threadId) : [];
  for (const id of threads) nativeLifecycleThreads.set(id, (nativeLifecycleThreads.get(id) ?? 0) + 1);
  try {
    const snapshot = await gateway.inspect();
    const bindings = snapshot.bindings.filter(binding => binding.active
      && (botId === undefined || binding.botId === botId) && (threadId === undefined || binding.threadId === threadId));
    const targets = new Map(bindings.map(binding => [JSON.stringify([binding.botId, binding.threadId]),
      { botId: binding.botId, threadId: binding.threadId }]));
    if (botId) for (const id of threads) targets.set(JSON.stringify([botId, id]), { botId, threadId: id });
    await Promise.all([...targets.values()].map(binding => retire
      ? gateway.revoke!(binding)
      : gateway.interrupt(binding, { scope: "conversation" })));
    if (retire) for (const binding of targets.values()) {
      if (store.taskByThread(binding.botId, binding.threadId)) store.patchTask(binding.botId, binding.threadId, { rewound: true });
    }
  } finally {
    for (const id of threads) {
      const remaining = (nativeLifecycleThreads.get(id) ?? 1) - 1;
      if (remaining) nativeLifecycleThreads.set(id, remaining);
      else nativeLifecycleThreads.delete(id);
    }
  }
}

function stopNativeTasks(botId: string, threadId?: string): Promise<void> {
  return teardownNativeContexts(botId, threadId);
}

function revokeNativeContext(botId: string, threadId?: string): Promise<void> {
  return teardownNativeContexts(botId, threadId, true);
}
  return { stopNativeTasks, revokeNativeContext, teardownNativeContexts, pending: (threadId: string) => nativeLifecycleThreads.has(threadId) };
}

export function createSuperagentHost(deps: SuperagentHostDeps) {
  const { store, aboutMeFacts, CLOUD_TEAM, cfg, SUPERAGENT_PRIMARY, personbotHome, personbotWorkspace,
    personbotFixture, personbotSettings, isInternalTurn, isUnattended, threadBusy, request, setLastReply, notify, DATA_DIR } = deps;
  let officialSuperagentGateway: SuperagentGateway | undefined;
const currentNativeMemoryBinding = (binding: { botId: string; threadId: string; contextId?: string }) =>
  Boolean(binding.contextId && !store.taskByThread(binding.botId, binding.threadId)?.rewound
    && (store.taskByThread(binding.botId, binding.threadId)?.resumeCursors[SUPERAGENT_INSTANCE_ID] === `omb-superagent:${binding.contextId}`
      || officialSuperagentGateway?.isActiveBinding?.(binding)));
const originalSuperagentMemory = createSuperagentMemory({
  store, aboutMe: aboutMeFacts,
  readAboutMe: () => CLOUD_TEAM ? null : cfg.profile?.aboutMe ?? "",
  canRead: (binding, purpose) => purpose === "recall" || currentNativeMemoryBinding(binding),
  canWrite: (binding, request) => currentNativeMemoryBinding(binding) && request.caller?.role === "master"
    && officialSuperagentGateway?.authorizeMemory?.(request) === true
    && !isInternalTurn(binding.threadId) && !isUnattended(binding.botId, binding.threadId),
});
const originalSuperagentProjection = createSuperagentProjection({
  store, currentContext: currentNativeMemoryBinding,
  attention: (binding, kind, summary) => {
    const bot = store.bot(binding.botId);
    if (bot) {
      store.patchTask(bot.id, binding.threadId, { unread: true });
      notify(buildNotification(kind, bot, binding.threadId, summary, { avatarUrl: bot.avatarUrl }));
    }
  },
});
const originalSuperagentDelivery = createSuperagentDelivery({
  store, currentContext: currentNativeMemoryBinding,
  onPersist: (delivery, message) => {
    if (threadBusy(delivery.botId, delivery.threadId) && request(delivery.threadId)?.turnId === delivery.requestId) {
      setLastReply(delivery.threadId, message.text ?? "");
    } else if (delivery.purpose === "result") {
      const bot = store.bot(delivery.botId);
      if (bot) {
        store.patchTask(bot.id, delivery.threadId, { unread: true });
        notify(buildNotification("done", bot, delivery.threadId, message.text ?? "", { avatarUrl: bot.avatarUrl }));
      }
    }
  },
});
const originalSuperagentUsage = createSuperagentUsage({
  dataDir: DATA_DIR,
  bot: id => store.bot(id),
  onBooked: row => {
    if (store.botByThread(row.threadId)?.id === row.botId) store.addTaskUsage(row.botId, row.threadId, {
      input: row.input, output: row.output, cachedInput: row.cachedInput, costUsd: row.costUsd,
    });
    noteSpend(DATA_DIR, row, Promise.resolve(true));
  },
});
if (SUPERAGENT_PRIMARY) officialSuperagentGateway = createSuperagentGateway({
  home: personbotHome, workspace: personbotWorkspace,
  provider: personbotSettings.launch().provider, model: personbotSettings.launch().model, fixture: personbotFixture,
  memory: request => originalSuperagentMemory.handle(request),
  deliver: async delivery => { originalSuperagentDelivery(delivery); },
  usage: async event => { await originalSuperagentUsage.handle(event); },
  canRecover: (binding, input) => {
    const task = store.taskByThread(binding.botId, binding.threadId);
    const bot = store.projectBotForTask(binding.botId, binding.threadId);
    return Boolean(task && bot && !task.rewound
      && (input.approvalMode !== "full" || approvalModeFor(bot) === "full"));
  },
  resolveLaunch: async () => personbotSettings.launch(),
  onLaunch: configuration => personbotSettings.applied(configuration),
  maxModelCalls: Number(process.env.PERSONBOT_MAX_MODEL_CALLS ?? 4),
  ...(process.env.PERSONBOT_MAX_MODEL_REQUESTS ? { maxModelRequests: Number(process.env.PERSONBOT_MAX_MODEL_REQUESTS) } : {}),
  ...(process.env.PERSONBOT_MAX_TOKENS ? { tokenLimit: Number(process.env.PERSONBOT_MAX_TOKENS) } : {}),
  ...(process.env.PERSONBOT_MAX_COST_USD ? { costLimitUsd: Number(process.env.PERSONBOT_MAX_COST_USD) } : {}),
  onModelAdmission: () => assertWithinBudget(cfg, DATA_DIR, new Date(), () => true),
});
  return { currentNativeMemoryBinding, originalSuperagentProjection, gateway: officialSuperagentGateway };
}
