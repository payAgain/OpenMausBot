import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import type { SuperagentDelivery } from "../shared/superagent.ts";

const directory = mkdtempSync(join(tmpdir(), "personbot-superagent-delivery-"));
const previousDirectory = process.env.OMB_DATA_DIR;
process.env.OMB_DATA_DIR = directory;
const [{ createSuperagentDelivery }, { Store }, messageDb] = await Promise.all([
  import("./superagent-delivery.ts"), import("./store.ts"), import("./message-db.ts"),
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
  if (previousDirectory === undefined) delete process.env.OMB_DATA_DIR;
  else process.env.OMB_DATA_DIR = previousDirectory;
});

function fixture() {
  const bot = store.createBot({ name: "Native delivery" }, { seedMessages: false });
  const source = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "Complete the requested work." });
  store.setResumeCursor(bot.id, "dsh-superagent", "omb-superagent:context-a", bot.threadId);
  const delivery: SuperagentDelivery = {
    botId: bot.id, threadId: bot.threadId, contextId: "context-a", requestId: "request-a",
    sourceMessageId: source.id, messageId: "outbox-a", text: "Requested work completed.", purpose: "result",
  };
  const bridge = (onPersist?: () => void) => createSuperagentDelivery({
    store,
    onPersist,
    currentContext: binding => !store.taskByThread(binding.botId, binding.threadId)?.rewound
      && store.taskByThread(binding.botId, binding.threadId)?.resumeCursors["dsh-superagent"] === `omb-superagent:${binding.contextId}`,
  });
  return { bot, source, delivery, bridge };
}

test("persists a source result with its original authority and acknowledges outbox retry only once", () => {
  const f = fixture();
  let published = 0;
  const bridge = f.bridge(() => { published += 1; });
  const first = bridge(f.delivery);
  assert.equal(first.requestMessageId, f.source.id);
  assert.equal(first.turnId, "request-a");
  assert.equal(first.turnTerminal, true);
  assert.equal(bridge(f.delivery).id, first.id);
  assert.equal(published, 1);
  assert.equal(store.activePath(f.bot.threadId).filter(message => message.role === "bot" && message.kind === "text").length, 1);
});

test("recovers a terminal ordinary answer and its receipt without a driver completion across SQLite restart", () => {
  const f = fixture();
  const delivery = { ...f.delivery, purpose: "answer" };
  const first = f.bridge()(delivery);
  assert.equal(first.turnTerminal, true);
  assert.equal(first.turnSucceeded, true);
  messageDb.closeMessageDb();
  store = new Store(() => ({ instanceId: "dsh-superagent", model: "fixture" }));
  const replayed = f.bridge()(delivery);
  assert.equal(replayed.id, first.id);
  assert.equal(replayed.turnTerminal, true);
  assert.equal(store.activePath(f.bot.threadId).filter(message => message.role === "bot" && message.kind === "text").length, 1);
});

test("accepts a late task-origin result after attention and a newer input without settling that newer turn", () => {
  const f = fixture();
  const bridge = f.bridge();
  bridge({ ...f.delivery, messageId: "attention", purpose: "attention", text: "Please clarify the destination." });
  const next = store.appendMessage(f.bot.threadId, { role: "user", kind: "text", text: "Use the project workspace." });
  store.setTaskActivity(f.bot.id, f.bot.threadId, "working");
  const result = f.bridge()(f.delivery);
  assert.equal(result.requestMessageId, f.source.id);
  assert.notEqual(result.requestMessageId, next.id);
  assert.equal(store.taskByThread(f.bot.id, f.bot.threadId)?.activity, "working");
  assert.equal(store.activePath(f.bot.threadId).filter(message => message.role === "bot" && message.kind === "text").length, 2);
});

test("fences stopped, foreign and removed-branch results before writing any original message", () => {
  const f = fixture();
  const bridge = f.bridge();
  assert.throws(() => bridge({ ...f.delivery, sourceMessageId: undefined }), /request is no longer available/);
  assert.throws(() => bridge({ ...f.delivery, botId: "foreign" }), /conversation is no longer active/);
  assert.throws(() => bridge({ ...f.delivery, contextId: "retired" }), /conversation is no longer active/);
  store.patchMessage(f.bot.threadId, f.source.id, { requestCancelled: true });
  assert.throws(() => bridge(f.delivery), /request is no longer available/);
  store.patchMessage(f.bot.threadId, f.source.id, { requestCancelled: undefined });
  store.branchMessage(f.bot.threadId, f.source.id, "Replace the earlier request.");
  store.setResumeCursor(f.bot.id, "dsh-superagent", "omb-superagent:context-b", f.bot.threadId);
  store.patchTask(f.bot.id, f.bot.threadId, { rewound: false });
  assert.throws(() => bridge({ ...f.delivery, contextId: "context-b" }), /request is no longer available/);
  assert.equal(store.activePath(f.bot.threadId).filter(message => message.role === "bot" && message.kind === "text").length, 0);
});
