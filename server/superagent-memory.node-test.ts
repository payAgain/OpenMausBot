import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import type { SuperagentMemoryRequest } from "../shared/superagent.ts";
import type { SuperagentMemorySearchHit } from "./superagent-memory.ts";

const directory = mkdtempSync(join(tmpdir(), "personbot-superagent-memory-"));
const previousDirectory = process.env.OMB_DATA_DIR;
process.env.OMB_DATA_DIR = directory;
const [
  { createSuperagentMemory: createMemoryPort }, { Store }, workspace, journal, memory, profile, { createAboutMe }, messageDb,
] = await Promise.all([
  import("./superagent-memory.ts"), import("./store.ts"), import("./workspace.ts"), import("./memory-journal.ts"),
  import("./memory-store.ts"), import("./profile-learned.ts"), import("./about-me.ts"), import("./message-db.ts"),
]);

interface Result {
  ok: boolean;
  code?: string;
  text?: string;
  path?: string;
  namespace?: string;
  authority?: string;
  exists?: boolean;
  hash?: string;
  totalChars?: number;
  provenance?: { source?: string; messageId?: string; requestId?: string; authorizationVersion?: number; quote?: string };
  hits?: SuperagentMemorySearchHit[];
  truncated?: boolean;
  forgotten?: number;
  aboutMe?: number;
  tombstone?: boolean;
}

let store: InstanceType<typeof Store>;
beforeEach(async () => {
  await journal.flushAllMemoryJournals();
  journal.resetMemoryJournalState();
  messageDb.closeMessageDb();
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  store = new Store(() => ({ instanceId: "fixture", model: "fixture-model" }));
});
after(async () => {
  await journal.flushAllMemoryJournals();
  messageDb.closeMessageDb();
  rmSync(directory, { recursive: true, force: true });
  if (previousDirectory === undefined) delete process.env.OMB_DATA_DIR;
  else process.env.OMB_DATA_DIR = previousDirectory;
});

function bot(name = "Scout") {
  const created = store.createBot({ name }, { seedMessages: false });
  store.appendMessage(created.threadId, { role: "user", kind: "text", text: "Remember the facts I give you." });
  return created;
}

function request(binding: { id: string; threadId: string }, operation: SuperagentMemoryRequest["operation"], fields: Partial<SuperagentMemoryRequest> = {}): SuperagentMemoryRequest {
  const source = store.activePath(binding.threadId).findLast(message => message.role === "user" && message.kind === "text");
  return {
    botId: binding.id, threadId: binding.threadId, operation,
    ...(["remember", "forget"].includes(operation) ? {
      caller: {
        role: "master" as const, agentId: "master:fixture", requestId: `request-${source?.id ?? "missing"}`,
        sourceMessageId: source?.id, authorizationVersion: 1,
      },
    } : {}),
    ...fields,
  };
}

function createSuperagentMemory(options: Parameters<typeof createMemoryPort>[0]) {
  return createMemoryPort({
    canWrite: (_binding, current) => {
      const caller = current.caller;
      return caller?.authorizationVersion === 1
        && caller.requestId === `request-${caller.sourceMessageId}`
        && caller.agentId === "master:fixture";
    },
    ...options,
  });
}

function result(value: unknown): Result {
  return value as Result;
}

test("writes original notes, reads them through both ports, indexes FTS and records source identity", async () => {
  const scout = bot();
  const bridge = createSuperagentMemory({ store });
  store.appendMessage(scout.threadId, { role: "user", kind: "text", text: "Remember: The cobalt launch belongs to Friday." });
  assert.equal(result(await bridge.handle(request(scout, "remember", { text: "The cobalt launch belongs to Friday." }))).ok, true);
  const doc = memory.readMemoryDoc(scout.id, "MEMORY.md");
  assert.match(doc.text, /The cobalt launch belongs to Friday/);
  assert.match(doc.text, /from chat/);
  const read = result(await bridge.handle(request(scout, "read")));
  assert.equal(read.text, doc.text);
  assert.equal(read.namespace, "omb.memory");
  assert.equal(workspace.searchMemoryFiles(scout.id, "cobalt").length, 1);
  const search = result(await bridge.handle(request(scout, "search", { query: "cobalt" })));
  assert.ok(search.hits?.some((hit) => hit.namespace === "omb.memory" && hit.path === "MEMORY.md"));
  await journal.flushMemoryJournal(scout.id);
  const entries = journal.readMemoryJournal(scout.id);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.threadId, scout.threadId);
  assert.equal(entries[0]!.botId, scout.id);
  assert.equal(entries[0]!.actor, "bot");
  assert.equal(entries[0]!.via, "superagent-memory.remember");
});

test("appends original topic notes and journals main-note archival", async () => {
  const scout = bot();
  const bridge = createSuperagentMemory({ store });
  store.appendMessage(scout.threadId, { role: "user", kind: "text", text: "The juniper release uses staging." });
  assert.equal(result(await bridge.handle(request(scout, "remember", { path: "memory/launch.md", text: "The juniper release uses staging." }))).ok, true);
  assert.match(workspace.readMemoryTopic(scout.id, "launch.md")!, /juniper/);
  assert.equal(workspace.searchMemoryFiles(scout.id, "juniper")[0]?.file, "memory/launch.md");
  const lines = Array.from({ length: 200 }, (_, index) => `- 2026-01-01 · Ordinary historical note ${index}`);
  workspace.writeMemoryFile(scout.id, `${lines.join("\n")}\n`);
  store.appendMessage(scout.threadId, { role: "user", kind: "text", text: "This archival boundary fact is new." });
  assert.equal(result(await bridge.handle(request(scout, "remember", { text: "This archival boundary fact is new." }))).ok, true);
  await journal.flushMemoryJournal(scout.id);
  assert.match(workspace.readMemoryTopic(scout.id, "archive.md")!, /Ordinary historical note/);
  assert.ok(journal.readMemoryJournal(scout.id).some((entry) => entry.path === "memory/archive.md"));
  assert.ok(journal.readMemoryJournal(scout.id).some((entry) => entry.path === "MEMORY.md"));
});

test("searches only this bot and eligible conversations, with agent reports labeled as context", async () => {
  const scout = bot();
  const other = bot("Other");
  const task = store.createTask(scout.id, "Shipping", false)!;
  store.appendMessage(task.threadId, { role: "user", kind: "text", text: "The zephyr launch is Friday." });
  store.appendMessage(task.threadId, { role: "bot", kind: "text", text: "Zephyr worker report: deployment succeeded." });
  store.appendMessage(other.threadId, { role: "user", kind: "text", text: "The zephyr password is private." });
  workspace.writeMemoryFile(other.id, "Zephyr private memory must stay private.");
  const room = store.createGroup("Private", [scout.id]);
  store.appendMessage(room.threadId, { role: "user", kind: "text", text: "Zephyr private room information." });
  const retired = store.appendMessage(task.threadId, { role: "user", kind: "text", text: "Zephyr retired branch information." });
  store.branchMessage(task.threadId, retired.id, "Active alternative branch.");
  assert.ok(store.activePath(task.threadId).every((message) => message.id !== retired.id));
  const bridge = createSuperagentMemory({ store });
  const found = result(await bridge.handle(request(scout, "search", { query: "zephyr" })));
  assert.ok(found.hits?.some((hit) => hit.namespace === "omb.conversation" && hit.threadId === task.threadId));
  assert.ok(found.hits?.some((hit) => hit.namespace === "omb.conversation" && hit.role === "bot" && hit.authority === "historical-context"));
  assert.ok(found.hits?.every((hit) => hit.botId === scout.id && (hit.namespace !== "omb.conversation" || hit.threadId !== room.threadId)));
  assert.doesNotMatch(JSON.stringify(found), /password|private room|private memory|retired branch/);
  assert.equal(memory.readMemoryDoc(scout.id, "MEMORY.md").exists, false);
  const restricted = createSuperagentMemory({ store, canRead: ({ threadId }) => threadId !== task.threadId });
  assert.equal(result(await restricted.handle(request(scout, "search", { query: "zephyr" }))).hits?.length, 0);
});

test("room memory requires an audience opt-in and never grants a room a personal-fact write", async () => {
  const scout = bot();
  const room = store.createGroup("Shared", [scout.id]);
  store.appendMessage(room.threadId, { role: "user", kind: "text", text: "The azimuth room result is ready." });
  store.appendMessage(scout.threadId, { role: "user", kind: "text", text: "Azimuth owner-only conversation." });
  workspace.writeMemoryFile(scout.id, "Azimuth shared project note.");
  const roomBinding = { id: scout.id, threadId: room.threadId };
  assert.equal(result(await createSuperagentMemory({ store }).handle(request(roomBinding, "read"))).code, "forbidden");
  const bridge = createSuperagentMemory({ store, roomFeeds: () => true });
  const found = result(await bridge.handle(request(roomBinding, "search", { query: "azimuth" })));
  assert.ok(found.hits?.some((hit) => hit.namespace === "omb.conversation" && hit.threadId === room.threadId));
  assert.doesNotMatch(JSON.stringify(found), /owner-only/);
  assert.equal(result(await bridge.handle(request(roomBinding, "remember", { text: "A room report is a personal fact." }))).code, "forbidden");
});

test("reads and searches the original owner profile live without copying it into bot facts", async () => {
  const scout = bot();
  let aboutMe: string | null = "I prefer marjoram tea.\nMy city is Kyoto.";
  const seen: Array<{ botId: string; threadId: string; contextId?: string }> = [];
  const bridge = createSuperagentMemory({
    store, readAboutMe: binding => { seen.push(binding); return aboutMe; },
  });
  const first = result(await bridge.handle(request(scout, "read", { path: "about-me", contextId: "profile-context" })));
  assert.equal(first.ok, true);
  assert.equal(first.namespace, "omb.profile");
  assert.equal(first.authority, "owner-profile");
  assert.equal(first.provenance?.source, "About me");
  assert.equal(first.text, aboutMe);
  assert.equal(first.hash, memory.hashMemoryText(aboutMe));
  assert.deepEqual(seen[0], { botId: scout.id, threadId: scout.threadId, contextId: "profile-context" });
  aboutMe = "I prefer bergamot tea.\nMy city is Sapporo.";
  const second = result(await bridge.handle(request(scout, "read", { path: "about-me" })));
  assert.equal(second.text, aboutMe);
  assert.notEqual(second.hash, first.hash);
  const found = result(await bridge.handle(request(scout, "search", { query: "bergamot" })));
  assert.ok(found.hits?.some(hit => hit.namespace === "omb.profile" && hit.snippet.includes("bergamot")
    && hit.authority === "owner-profile" && hit.provenance.source === "About me" && hit.provenance.line === 1));
  assert.ok(result(await bridge.handle(request(scout, "search", { query: "marjoram" }))).hits?.every(hit => hit.namespace !== "omb.profile"));
  assert.equal(memory.readMemoryDoc(scout.id, "MEMORY.md").exists, false);
  assert.equal(journal.readMemoryJournal(scout.id).length, 0);
  aboutMe = null;
  assert.deepEqual(result(await bridge.handle(request(scout, "read", { path: "about-me" }))).exists, false);
});

test("never reads the personal profile for rooms, delegated sources, retired contexts or disabled memory", async () => {
  const scout = bot();
  const room = store.createGroup("Shared", [scout.id]);
  store.appendMessage(room.threadId, { role: "user", kind: "text", text: "The juniper room request is ready." });
  let visible = true;
  let profileReads = 0;
  const bridge = createSuperagentMemory({
    store, roomFeeds: () => true, canRead: ({ contextId }, purpose) => visible && (purpose === "recall" || contextId !== "retired"),
    readAboutMe: () => { profileReads++; return "The owner lives in Juniper City."; },
  });
  const roomBinding = { id: scout.id, threadId: room.threadId };
  assert.equal(result(await bridge.handle(request(roomBinding, "read", { path: "about-me" }))).code, "forbidden");
  assert.ok(result(await bridge.handle(request(roomBinding, "search", { query: "juniper" }))).hits?.every(hit => hit.namespace !== "omb.profile"));
  for (const origin of [
    { peerAsk: { botId: "worker", name: "Worker", threadId: "worker-thread" } },
    { sender: { name: "Other person" } }, { relayed: true }, { webhookPost: true }, { aside: true },
    { from: { botId: "worker", name: "Worker", color: "blue" } }, { requestCancelled: true },
  ]) {
    store.appendMessage(scout.threadId, { role: "user", kind: "text", text: "Find the juniper profile.", ...origin });
    assert.equal(result(await bridge.handle(request(scout, "read", { path: "about-me" }))).code, "forbidden");
    assert.ok(result(await bridge.handle(request(scout, "search", { query: "juniper" }))).hits?.every(hit => hit.namespace !== "omb.profile"));
  }
  store.appendMessage(scout.threadId, { role: "user", kind: "text", text: "Show me my profile." });
  assert.equal(result(await bridge.handle(request(scout, "read", { path: "about-me", contextId: "retired" }))).code, "forbidden");
  scout.memoryEnabled = false;
  assert.equal(result(await bridge.handle(request(scout, "read", { path: "about-me" }))).code, "forbidden");
  scout.memoryEnabled = true;
  visible = false;
  assert.equal(result(await bridge.handle(request(scout, "read", { path: "about-me" }))).code, "forbidden");
  assert.equal(profileReads, 0);
});

test("bounds and redacts live profile output and suppresses forgotten profile lines", async () => {
  const scout = bot();
  const credential = `sk-${"a".repeat(40)}`;
  let aboutMe = `OPENAI_API_KEY=${credential}\n${Array.from({ length: 15 }, (_, index) => `Saffron preference ${index}: ${"orchid ".repeat(200)}`).join("\n")}`;
  const bridge = createSuperagentMemory({ store, readAboutMe: () => aboutMe });
  const read = result(await bridge.handle(request(scout, "read", { path: "about-me" })));
  assert.equal(read.truncated, true);
  assert.ok(read.text!.length <= 12_000);
  assert.ok(read.totalChars! > 12_000);
  assert.doesNotMatch(read.text!, new RegExp(credential));
  assert.match(read.text!, /redacted/);
  const found = result(await bridge.handle(request(scout, "search", { query: "saffron" })));
  assert.equal(found.hits?.filter(hit => hit.namespace === "omb.profile").length, 2);
  assert.ok(found.hits!.length <= 8);
  assert.ok(found.hits!.every(hit => hit.snippet.length <= 900));
  assert.ok(found.hits!.reduce((count, hit) => count + hit.snippet.length, 0) <= 6_000);
  aboutMe = "The cobalt garden is ready.\nThe cobalt plan is ready.";
  const broad = result(await bridge.handle(request(scout, "search", { query: "cobalt garden launch archive delta" })));
  assert.equal(broad.hits?.filter(hit => hit.namespace === "omb.profile").length, 1);
  assert.match(broad.hits!.find(hit => hit.namespace === "omb.profile")!.snippet, /garden/);
  aboutMe = "The owner prefers saffron.\nThe owner lives in Kyoto.";
  store.appendMessage(scout.threadId, { role: "user", kind: "text", text: "Forget saffron." });
  assert.equal(result(await bridge.handle(request(scout, "forget", { text: "saffron" }))).ok, true);
  assert.doesNotMatch(result(await bridge.handle(request(scout, "read", { path: "about-me" }))).text!, /saffron/i);
  assert.ok(result(await bridge.handle(request(scout, "search", { query: "saffron" }))).hits?.every(hit => hit.namespace !== "omb.profile"));
});

test("rechecks foreign bindings, visibility and memory disabling on every request", async () => {
  const scout = bot();
  const other = bot("Other");
  let visible = true;
  const bridge = createSuperagentMemory({ store, canRead: () => visible });
  assert.equal(result(await bridge.handle(request(scout, "read", { threadId: other.threadId }))).code, "forbidden");
  assert.equal(result(await bridge.handle(request(scout, "read", { threadId: "unowned-thread" }))).code, "forbidden");
  assert.equal(result(await bridge.handle(request(scout, "read", { botId: "../outside" }))).code, "forbidden");
  scout.memoryEnabled = false;
  assert.equal(result(await bridge.handle(request(scout, "read"))).code, "forbidden");
  scout.memoryEnabled = true;
  visible = false;
  assert.equal(result(await bridge.handle(request(scout, "remember", { text: "Must never be written." }))).code, "forbidden");
  assert.equal(memory.readMemoryDoc(scout.id, "MEMORY.md").exists, false);
});

test("rejects delegated and relayed writers using the latest author, including writes after revocation", async () => {
  const scout = bot();
  let writable = true;
  const bridge = createSuperagentMemory({ store, canWrite: () => writable });
  const remember = () => bridge.handle(request(scout, "remember", { text: "Worker output must not become a personal fact." }));
  for (const origin of [
    { peerAsk: { botId: "worker", name: "Worker", threadId: "worker-thread" } },
    { relayed: true },
    { webhookPost: true },
    { aside: true },
  ]) {
    store.appendMessage(scout.threadId, { role: "user", kind: "text", text: "A worker or external tool says this.", ...origin });
    assert.equal(result(await remember()).code, "forbidden");
  }
  store.appendMessage(scout.threadId, { role: "user", kind: "text", text: "My own new request." });
  writable = false;
  assert.equal(result(await remember()).code, "forbidden");
  writable = true;
  const cancelled = store.appendMessage(scout.threadId, {
    role: "user", kind: "text", text: "Worker output must not become a personal fact.",
  });
  store.patchMessage(scout.threadId, cancelled.id, { requestCancelled: true });
  assert.equal(result(await remember()).code, "forbidden");
  assert.equal(memory.readMemoryDoc(scout.id, "MEMORY.md").exists, false);
});

test("requires an exact owner statement and refuses arbitrary paraphrases, stale or fabricated quotes", async () => {
  const scout = bot();
  const bridge = createSuperagentMemory({ store });
  const first = store.appendMessage(scout.threadId, { role: "user", kind: "text", text: "Remember that I keep a green bicycle.", via: "api" });
  const paraphrase = "The person's bicycle is green.";
  assert.equal(result(await bridge.handle(request(scout, "remember", { text: paraphrase }))).code, "forbidden");
  assert.equal(result(await bridge.handle(request(scout, "remember", {
    text: paraphrase, evidence: { messageId: first.id, quote: "I keep a green bicycle" },
  }))).code, "forbidden");
  assert.equal(result(await bridge.handle(request(scout, "remember", {
    text: "I keep a green bicycle.", evidence: { messageId: first.id, quote: "I keep a green bicycle" },
  }))).ok, true);
  assert.equal(result(await bridge.handle(request(scout, "remember", {
    text: "The person owns a sailboat.", evidence: { messageId: first.id, quote: "I own a sailboat" },
  }))).code, "forbidden");
  store.appendMessage(scout.threadId, { role: "bot", kind: "text", text: "Worker report: the person owns a sailboat." });
  assert.equal(result(await bridge.handle(request(scout, "remember", { text: "The person owns a sailboat." }))).code, "forbidden");
  const second = store.appendMessage(scout.threadId, { role: "user", kind: "text", text: "Please investigate the project." });
  assert.equal(result(await bridge.handle(request(scout, "remember", {
    text: paraphrase, evidence: { messageId: first.id, quote: "I keep a green bicycle" },
  }))).code, "forbidden");
  assert.equal(result(await bridge.handle(request(scout, "remember", {
    text: paraphrase, evidence: { messageId: second.id, quote: "I keep a green bicycle" },
  }))).code, "forbidden");
  assert.doesNotMatch(memory.readMemoryDoc(scout.id, "MEMORY.md").text, /sailboat/);
});

test("requires an explicit host grant and a current master caller before either memory mutation", async () => {
  const scout = bot();
  const source = store.appendMessage(scout.threadId, { role: "user", kind: "text", text: "Forget jasmine tea." });
  workspace.writeMemoryFile(scout.id, "- The person prefers jasmine tea.\n");
  const original = memory.readMemoryDoc(scout.id, "MEMORY.md").text;
  const untrusted = createMemoryPort({ store });
  assert.equal(result(await untrusted.handle(request(scout, "forget", { text: "jasmine tea" }))).code, "forbidden");
  store.appendMessage(scout.threadId, { role: "user", kind: "text", text: "Remember: The person prefers black tea." });
  assert.equal(result(await untrusted.handle(request(scout, "remember", { text: "The person prefers black tea." }))).code, "forbidden");
  const bridge = createSuperagentMemory({ store });
  store.appendMessage(scout.threadId, { role: "user", kind: "text", text: "Forget jasmine tea." });
  const valid = request(scout, "forget", { text: "jasmine tea" });
  for (const caller of [
    undefined,
    { ...valid.caller!, role: "worker" as const, ticketId: "worker-ticket" },
    { ...valid.caller!, role: "upkeep" as const },
    { ...valid.caller!, requestId: "another-request" },
    { ...valid.caller!, sourceMessageId: source.id },
    { ...valid.caller!, agentId: "" },
    { ...valid.caller!, authorizationVersion: 0 },
    { ...valid.caller!, authorizationVersion: 2 },
  ]) {
    assert.equal(result(await bridge.handle({ ...valid, caller })).code, "forbidden");
    assert.equal(memory.readMemoryDoc(scout.id, "MEMORY.md").text, original);
    assert.equal(profile.isForgotten("The person prefers jasmine tea."), false);
  }
  assert.equal(journal.readMemoryJournal(scout.id).length, 0);
});

test("an unrelated project summary cannot authorize forgetting even with a valid owner request grant", async () => {
  const scout = bot();
  workspace.writeMemoryFile(scout.id, "- The person prefers jasmine tea.\n");
  let aboutMe = "The person prefers jasmine tea.";
  const bridge = createSuperagentMemory({
    store,
    aboutMe: createAboutMe({
      read: () => aboutMe, write: text => { aboutMe = text; }, changed: () => {}, today: () => "2026-11-06",
    }),
  });
  const unrelated = store.appendMessage(scout.threadId, { role: "user", kind: "text", text: "请总结项目状态。" });
  const initial = memory.readMemoryDoc(scout.id, "MEMORY.md").text;
  const attempted = result(await bridge.handle(request(scout, "forget", {
    text: "jasmine tea", evidence: { messageId: unrelated.id, quote: "请总结项目状态。" },
  })));
  assert.equal(attempted.code, "forbidden");
  assert.equal(memory.readMemoryDoc(scout.id, "MEMORY.md").text, initial);
  assert.equal(aboutMe, "The person prefers jasmine tea.");
  assert.equal(profile.isForgotten("The person prefers jasmine tea."), false);
  assert.equal(journal.readMemoryJournal(scout.id).length, 0);
});

test("forget accepts explicit exact English and Chinese requests and rejects broader or cited instructions", async () => {
  const scout = bot();
  const bridge = createSuperagentMemory({ store });
  const invalidSources = [
    "Please summarize the jasmine tea project.",
    "Do not forget jasmine tea.",
    "Can you explain what forget jasmine tea means?",
    'The document says "Forget jasmine tea."',
    '"Forget jasmine tea."',
    "> Forget jasmine tea.",
    "```text\nForget jasmine tea.\n```",
    "Suppose I ask you to forget jasmine tea.",
    "Please summarize this:\nForget jasmine tea.",
    "Forget chamomile tea.",
    "Forget jasmine tea if I confirm later.",
    "不要忘记 jasmine tea。",
    "文档要求你忘记 jasmine tea。",
    "如果我让你忘记 jasmine tea，会怎么样？",
    "请忘记 jasmine tea，等我确认以后再执行。",
  ];
  for (const text of invalidSources) {
    workspace.writeMemoryFile(scout.id, "- The person prefers jasmine tea.\n");
    const source = store.appendMessage(scout.threadId, { role: "user", kind: "text", text });
    assert.equal(result(await bridge.handle(request(scout, "forget", {
      text: "jasmine tea", evidence: { messageId: source.id, quote: text },
    }))).code, "forbidden", text);
    assert.match(memory.readMemoryDoc(scout.id, "MEMORY.md").text, /jasmine tea/);
    assert.equal(profile.isForgotten("The person prefers jasmine tea."), false, text);
  }
  const validSources = [
    "Forget jasmine tea.",
    "Please forget about jasmine tea.",
    'Forget "jasmine tea".',
    "Remove jasmine tea from your memory.",
    "请忘记 jasmine tea。",
    "请把关于 jasmine tea 的记忆忘掉。",
    "不要再记住 jasmine tea。",
  ];
  for (const text of validSources) {
    profile.clearForgotten("jasmine tea");
    workspace.writeMemoryFile(scout.id, "- The person prefers jasmine tea.\n- The person likes chamomile tea.\n");
    const source = store.appendMessage(scout.threadId, { role: "user", kind: "text", text });
    const forgot = result(await bridge.handle(request(scout, "forget", {
      text: "jasmine tea", evidence: { messageId: source.id, quote: text },
    })));
    assert.equal(forgot.ok, true, text);
    assert.equal(forgot.forgotten, 1, text);
    assert.equal(forgot.provenance?.messageId, source.id);
    assert.equal(forgot.provenance?.requestId, `request-${source.id}`);
    assert.equal(forgot.provenance?.authorizationVersion, 1);
    assert.equal(forgot.provenance?.quote, text);
    assert.doesNotMatch(memory.readMemoryDoc(scout.id, "MEMORY.md").text, /jasmine tea/);
    assert.match(memory.readMemoryDoc(scout.id, "MEMORY.md").text, /chamomile tea/);
  }
  profile.clearForgotten("jasmine tea");
  workspace.writeMemoryFile(scout.id, "- The person prefers jasmine tea.\n- The person likes chamomile tea.\n");
  store.appendMessage(scout.threadId, { role: "user", kind: "text", text: "Forget jasmine tea." });
  assert.equal(result(await bridge.handle(request(scout, "forget", { text: "tea" }))).code, "forbidden");
  assert.match(memory.readMemoryDoc(scout.id, "MEMORY.md").text, /jasmine tea/);
  assert.match(memory.readMemoryDoc(scout.id, "MEMORY.md").text, /chamomile tea/);
});

test("revocation and source-message changes invalidate previously authorized writer requests", async () => {
  const scout = bot();
  let version = 1;
  let active = true;
  const bridge = createSuperagentMemory({
    store, canWrite: (_binding, current) => active && current.caller?.authorizationVersion === version,
  });
  store.appendMessage(scout.threadId, { role: "user", kind: "text", text: "Remember: I do not own a sailboat." });
  const old = request(scout, "remember", {
    text: "I do not own a sailboat.", evidence: {
      messageId: store.activePath(scout.threadId).at(-1)!.id, quote: "I do not own a sailboat.",
    },
  });
  const arbitrary = { ...old, text: "I own a sailboat." };
  assert.equal(result(await bridge.handle(arbitrary)).code, "forbidden");
  assert.equal(result(await bridge.handle(old)).ok, true);
  const initial = memory.readMemoryDoc(scout.id, "MEMORY.md").text;
  version++;
  assert.equal(result(await bridge.handle(old)).code, "forbidden");
  active = false;
  const updated = { ...old, caller: { ...old.caller!, authorizationVersion: version } };
  assert.equal(result(await bridge.handle(updated)).code, "forbidden");
  active = true;
  store.appendMessage(scout.threadId, { role: "user", kind: "text", text: "Please summarize project progress." });
  assert.equal(result(await bridge.handle(updated)).code, "forbidden");
  assert.equal(memory.readMemoryDoc(scout.id, "MEMORY.md").text, initial);
  assert.doesNotMatch(initial, /· I own a sailboat/);
});

test("preserves native context identity so product callbacks can retire a branch", async () => {
  const scout = bot();
  let active = "current-context";
  const bridge = createSuperagentMemory({
    store, canRead: ({ contextId }, purpose) => purpose === "recall" || contextId === active,
    canWrite: ({ contextId }) => contextId === active,
  });
  store.appendMessage(scout.threadId, { role: "user", kind: "text", text: "The amber project launches on Tuesday." });
  assert.equal(result(await bridge.handle(request(scout, "remember", {
    contextId: active, text: "The amber project launches on Tuesday.",
  }))).ok, true);
  active = "replacement-context";
  assert.equal(result(await bridge.handle(request(scout, "remember", {
    contextId: "current-context", text: "The amber project launches on Tuesday.",
  }))).code, "forbidden");
  assert.equal(result(await bridge.handle(request(scout, "read", { contextId: "current-context" }))).code, "forbidden");
  assert.equal(result(await bridge.handle(request(scout, "read"))).code, "forbidden");
});

test("checks multiword forget tombstones against raw SQLite sources rather than FTS highlight markup", async () => {
  const scout = bot();
  const bridge = createSuperagentMemory({ store });
  const fact = "The person prefers concise architecture reviews.";
  const source = store.appendMessage(scout.threadId, { role: "user", kind: "text", text: `Remember: ${fact}` });
  const reported = store.appendMessage(scout.threadId, { role: "bot", kind: "text", text: `Worker report: ${fact}` });
  assert.equal(result(await bridge.handle(request(scout, "remember", { text: fact }))).ok, true);
  store.appendMessage(scout.threadId, { role: "user", kind: "text", text: "Forget concise architecture reviews." });
  assert.equal(result(await bridge.handle(request(scout, "forget", { text: "concise architecture reviews" }))).ok, true);
  const originalHits = messageDb.recallMessages("concise architecture reviews", [scout.threadId], 20, undefined, "any");
  const highlightedSource = originalHits.find(hit => hit.messageId === source.id)!;
  assert.match(highlightedSource.snippet, /\[concise\] \[architecture\] \[reviews\]/);
  assert.equal(profile.isForgotten(highlightedSource.snippet), false);
  assert.equal(profile.isForgotten(source.text!), true);
  workspace.writeMemoryTopic(scout.id, "stale.md", fact);
  const highlightedNote = workspace.searchMemoryFiles(scout.id, "concise architecture reviews")
    .find(hit => hit.file === "memory/stale.md")!;
  assert.match(highlightedNote.snippet, /\[concise\] \[architecture\] \[reviews\]/);
  const forgotten = result(await bridge.handle(request(scout, "search", { query: "concise architecture reviews" })));
  assert.ok(forgotten.hits?.every(hit => hit.namespace !== "omb.conversation"
    || (hit.messageId !== source.id && hit.messageId !== reported.id)));
  assert.ok(forgotten.hits?.every(hit => hit.namespace !== "omb.memory" || hit.path !== "memory/stale.md"));
  assert.doesNotMatch(JSON.stringify(forgotten).replace(/\[|\]/g, ""), /The person prefers concise architecture reviews/);

  const literal = "The person prefers [concise] [architecture] [reviews].";
  const literalSource = store.appendMessage(scout.threadId, { role: "user", kind: "text", text: literal });
  workspace.writeMemoryTopic(scout.id, "literal.md", literal);
  assert.equal(profile.isForgotten(literal), false);
  const retained = result(await bridge.handle(request(scout, "search", { query: "concise architecture reviews" })));
  assert.ok(retained.hits?.some(hit => hit.namespace === "omb.conversation" && hit.messageId === literalSource.id));
  assert.ok(retained.hits?.some(hit => hit.namespace === "omb.memory" && hit.path === "memory/literal.md"));
});

test("never labels indexed daily logs as durable personal facts", async () => {
  const scout = bot();
  const bridge = createSuperagentMemory({ store });
  assert.equal(workspace.appendMemoryLog(scout.id, "Quasar daily worker event.").ok, true);
  assert.ok(workspace.searchMemoryFiles(scout.id, "quasar").some(hit => hit.file.startsWith("memory/log/")));
  const found = result(await bridge.handle(request(scout, "search", { query: "quasar" })));
  assert.deepEqual(found.hits, []);
});

test("forgets original main, topic and archive notes, About me and stale learned candidates", async () => {
  const scout = bot();
  let aboutMeText = "The person likes cardamom.\nThe person lives in Kyoto.";
  const aboutMe = createAboutMe({
    read: () => aboutMeText, write: (text) => { aboutMeText = text; }, changed: () => {}, today: () => "2026-11-06",
  });
  const bridge = createSuperagentMemory({ store, aboutMe });
  store.appendMessage(scout.threadId, { role: "user", kind: "text", text: "Remember: The person likes cardamom." });
  for (const path of ["MEMORY.md", "memory/food.md", "memory/archive.md"]) {
    assert.equal(result(await bridge.handle(request(scout, "remember", { path, text: "The person likes cardamom." }))).ok, true);
  }
  store.appendMessage(scout.threadId, { role: "user", kind: "text", text: "Forget cardamom." });
  const forgot = result(await bridge.handle(request(scout, "forget", { text: "cardamom" })));
  assert.equal(forgot.forgotten, 3);
  assert.equal(forgot.aboutMe, 1);
  assert.equal(forgot.tombstone, true);
  for (const path of ["MEMORY.md", "memory/food.md", "memory/archive.md"]) {
    assert.doesNotMatch(memory.readMemoryDoc(scout.id, path).text, /cardamom/);
  }
  assert.equal(aboutMeText, "The person lives in Kyoto.");
  assert.equal(profile.isForgotten("The person likes cardamom."), true);
  assert.deepEqual(profile.planLearned({ botId: scout.id, botName: scout.name }, ["The person likes cardamom."], aboutMeText, "2026-11-06"), []);
  assert.equal(result(await bridge.handle(request(scout, "search", { query: "cardamom" }))).hits?.length, 0);
  await journal.flushMemoryJournal(scout.id);
  assert.equal(journal.readMemoryJournal(scout.id).filter((entry) => entry.via === "superagent-memory.forget").length, 3);
});

test("keeps forget tombstones without About me and clears them only after a valid explicit remember", async () => {
  const scout = bot();
  const bridge = createSuperagentMemory({ store });
  store.appendMessage(scout.threadId, { role: "user", kind: "text", text: "Forget turmeric." });
  assert.equal(result(await bridge.handle(request(scout, "forget", { text: "turmeric" }))).ok, true);
  assert.equal(profile.isForgotten("The person likes turmeric."), true);
  store.appendMessage(scout.threadId, { role: "user", kind: "text", text: "Remember: The person likes turmeric." });
  assert.equal(result(await bridge.handle(request(scout, "remember", { text: `${"turmeric ".repeat(150)}` }))).ok, false);
  assert.equal(profile.isForgotten("The person likes turmeric."), true);
  assert.equal(result(await bridge.handle(request(scout, "remember", { text: "The person likes turmeric." }))).ok, true);
  assert.equal(profile.isForgotten("The person likes turmeric."), false);
});

test("constrains file paths and refuses symlinks without touching their target", async () => {
  const scout = bot();
  workspace.ensureWorkspace(scout.id);
  const bridge = createSuperagentMemory({ store });
  for (const path of ["../outside.md", "/etc/passwd", "memory/../../outside.md", "memory/log/2026-11-06.md"]) {
    assert.equal(result(await bridge.handle(request(scout, "read", { path }))).ok, false);
    assert.equal(result(await bridge.handle(request(scout, "remember", { path, text: "A fact." }))).ok, false);
  }
  const outside = join(directory, "private.md");
  writeFileSync(outside, "private outside content");
  symlinkSync(outside, join(workspace.workspaceDir(scout.id), "memory", "unsafe.md"));
  assert.equal(result(await bridge.handle(request(scout, "read", { path: "memory/unsafe.md" }))).ok, false);
  assert.equal(result(await bridge.handle(request(scout, "forget", { text: "private" }))).ok, false);
  assert.equal(readFileSync(outside, "utf8"), "private outside content");
});

test("bounds retrieved files, search snippets and queries", async () => {
  const scout = bot();
  const bridge = createSuperagentMemory({ store });
  workspace.ensureWorkspace(scout.id);
  memory.writeMemoryDoc(scout.id, "memory/large.md", "orchid ".repeat(8_000));
  const read = result(await bridge.handle(request(scout, "read", { path: "memory/large.md" })));
  assert.equal(read.truncated, true);
  assert.ok(read.text!.length <= 12_000);
  for (let index = 0; index < 12; index++) {
    store.appendMessage(scout.threadId, { role: "bot", kind: "text", text: `Orchid historical report ${index}: ${"orchid ".repeat(250)}` });
  }
  const search = result(await bridge.handle(request(scout, "search", { query: "orchid" })));
  assert.ok(search.hits!.length <= 8);
  assert.ok(search.hits!.reduce((length, hit) => length + hit.snippet.length, 0) <= 6_000);
  assert.equal(result(await bridge.handle(request(scout, "search", { query: "x".repeat(501) }))).code, "invalid");
});
