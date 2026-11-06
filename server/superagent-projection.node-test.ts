import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import type { RuntimeEvent } from "../shared/runtime-events.ts";

const directory = mkdtempSync(join(tmpdir(), "personbot-background-projection-"));
const previous = process.env.OMB_DATA_DIR;
process.env.OMB_DATA_DIR = directory;
const [{ createSuperagentProjection }, { Store }, messageDb] = await Promise.all([
  import("./superagent-projection.ts"), import("./store.ts"), import("./message-db.ts"),
]);
let store: InstanceType<typeof Store>;
beforeEach(() => {
  messageDb.closeMessageDb();
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  store = new Store(() => ({ instanceId: "dsh-superagent", model: "fixture" }));
});
after(() => {
  messageDb.closeMessageDb();
  rmSync(directory, { recursive: true, force: true });
  if (previous === undefined) delete process.env.OMB_DATA_DIR;
  else process.env.OMB_DATA_DIR = previous;
});

function fixture() {
  const bot = store.createBot({ name: "Background tasks" }, { seedMessages: false });
  const source = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "Prepare a report and ask before publishing." });
  store.setResumeCursor(bot.id, "dsh-superagent", "omb-superagent:context", bot.threadId);
  store.setTaskActivity(bot.id, bot.threadId, "idle");
  const opened: RuntimeEvent = {
    eventId: "event-a", provider: "dsh-superagent", providerInstanceId: "dsh-superagent",
    threadId: bot.threadId, turnId: "input-a", createdAt: new Date().toISOString(),
    type: "request.opened", requestId: "decision-a", requestType: "permission", tool: "superagent", summary: "Publish the prepared report?",
    nativeTask: {
      botId: bot.id, contextId: "context", sourceMessageId: source.id,
      ticketId: "ticket-a", agentId: "worker-a", callId: "publish-a", authorizationVersion: 1,
    },
    background: true,
  };
  const project = () => createSuperagentProjection({
    store,
    currentContext: binding => !store.taskByThread(bot.id, bot.threadId)?.rewound && binding.contextId === "context",
  });
  return { bot, source, opened, project };
}

test("persists a background approval without reacquiring the composer and retains exact source/call identity", () => {
  const f = fixture();
  assert.equal(f.project()(f.opened), true);
  assert.equal(store.taskByThread(f.bot.id, f.bot.threadId)?.busy, false);
  const card = store.activePath(f.bot.threadId).find(message => message.card?.requestId === "decision-a")!;
  assert.equal(card.requestMessageId, f.source.id);
  assert.equal(card.turnId, "input-a");
  assert.deepEqual(card.card?.superagent, {
    contextId: "context", requestId: "input-a", ticketId: "ticket-a",
    agentId: "worker-a", callId: "publish-a", authorizationVersion: 1,
  });
  store.appendMessage(f.bot.threadId, { role: "user", kind: "text", text: "Meanwhile, answer another question." });
  store.setTaskActivity(f.bot.id, f.bot.threadId, "working");
  const resolved: RuntimeEvent = { ...f.opened, type: "request.resolved", behavior: "allow", source: "user" };
  f.project()(resolved);
  assert.equal(store.taskByThread(f.bot.id, f.bot.threadId)?.busy, true);
  assert.equal(store.messagesFor(f.bot.threadId).find(message => message.id === card.id)?.card?.answered, "allow");
});

test("replays the same native decision after SQLite restart without adding a second card", () => {
  const f = fixture();
  f.project()(f.opened);
  messageDb.closeMessageDb();
  store = new Store(() => ({ instanceId: "dsh-superagent", model: "fixture" }));
  f.project()(f.opened);
  assert.equal(store.messagesFor(f.bot.threadId).filter(message => message.card?.requestId === "decision-a").length, 1);
  const expired: RuntimeEvent = { ...f.opened, type: "request.resolved", behavior: "deny", source: "system" };
  f.project()(expired);
  const card = store.messagesFor(f.bot.threadId).find(message => message.card?.requestId === "decision-a")!.card!;
  assert.equal(card.expired, true);
  assert.equal(card.dismissed, true);
  assert.equal(store.taskByThread(f.bot.id, f.bot.threadId)?.busy, false);
});

test("rejects removed user sources and retired contexts before exposing a background permission", () => {
  const f = fixture();
  f.project()({ ...f.opened, nativeTask: { ...f.opened.nativeTask!, contextId: "retired" } });
  store.patchMessage(f.bot.threadId, f.source.id, { requestCancelled: true });
  f.project()(f.opened);
  assert.equal(store.activePath(f.bot.threadId).filter(message => message.card?.requestId).length, 0);
  const foreign = { ...f.opened, nativeTask: { ...f.opened.nativeTask!, botId: "foreign" } };
  f.project()(foreign);
  assert.equal(store.messagesFor(f.bot.threadId).filter(message => message.card?.requestId).length, 0);
});
