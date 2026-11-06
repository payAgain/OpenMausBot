import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeSnapshot } from "../../packages/personbot-projection/src/index.ts";
import type { ArtifactSnapshot, ChannelDeliveryRecord, IntegrationSnapshot, PersonalSnapshot, TaskRecord, TaskSnapshot } from "../../packages/personbot-protocol/src/index.ts";

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@/state/api", () => ({ api: request }));
import { PersonbotClient } from "./personbot-client";

class FixtureEventSource {
  static instances: FixtureEventSource[] = [];
  onopen?: () => void;
  onerror?: () => void;
  onmessage?: (event: { data: string }) => void;
  closed = false;
  constructor() { FixtureEventSource.instances.push(this); }
  close() { this.closed = true; }
}

const session = { sessionId: "conversation", conversationId: "conversation", cwd: "/fixture/workspace", status: "idle" as const, pendingStops: [] };
let snapshot: RuntimeSnapshot;
let tasks: TaskSnapshot;
let personal: PersonalSnapshot;
let artifacts: ArtifactSnapshot;
let integrations: IntegrationSnapshot;
let client: PersonbotClient;
let rpc: (method: string, params: Record<string, unknown>) => unknown | Promise<unknown>;
const mutations: { method: string; params: Record<string, unknown> }[] = [];

async function connect() {
  client.start();
  await vi.waitFor(() => expect(FixtureEventSource.instances).toHaveLength(1));
  FixtureEventSource.instances[0].onopen?.();
  await vi.waitFor(() => expect(client.getSnapshot().connection).toBe("connected"));
}

beforeEach(() => {
  FixtureEventSource.instances = [];
  mutations.length = 0;
  snapshot = { generation: "first", eventSeq: 0, sessions: [session], logs: [], pending: [] };
  tasks = { tasks: [], executions: [], updates: [] };
  personal = { projects: [], roles: [], memories: [] };
  artifacts = { artifacts: [] };
  integrations = { sources: [], subscriptions: [], schedules: [], triggers: [], deliveries: [] };
  rpc = (method, params) => method === "personbot.v1.snapshots.get"
    ? params.sessionId ? { ...snapshot, logs: [{ sessionId: "conversation", events: [], nextSeq: 0, hasMore: false }] } : snapshot
    : method === "personbot.v1.tasks.list" ? tasks
      : method === "personbot.v1.personal.snapshot" ? personal
        : method === "personbot.v1.artifacts.list" ? artifacts
          : method === "personbot.v1.integrations.snapshot" ? integrations : {};
  request.mockReset();
  request.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path.endsWith("/status")) return { enabled: true, state: "stopped", workspace: "/fixture/workspace", provider: "fixture", model: "fixture" };
    if (path === "/.well-known/openmausbot/environment") return { environmentId: "fixture" };
    const { method, params } = JSON.parse(String(init?.body)) as { method: string; params: Record<string, unknown> };
    if (method !== "personbot.v1.snapshots.get") mutations.push({ method, params });
    return rpc(method, params);
  });
  vi.stubGlobal("EventSource", FixtureEventSource);
  vi.stubGlobal("document", { visibilityState: "visible" });
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
  });
  client = new PersonbotClient();
});

afterEach(async () => {
  client.dispose();
  await new Promise((resolve) => setTimeout(resolve, 5));
  vi.unstubAllGlobals();
});

describe("PersonbotClient", () => {
  const task: TaskRecord = {
    id: "task", originSessionId: "conversation", workerSessionId: "worker-task",
    goal: "Write a report", criteria: ["Cite the fixture"], context: "", revision: 3,
    lifecycle: "open", stage: "awaiting_review", createdAt: "2026-11-05T00:00:00.000Z",
    updatedAt: "2026-11-05T00:00:00.000Z",
  };
  it("keeps a single live connection across React's immediate effect cleanup/setup", async () => {
    client.start();
    client.dispose();
    client.start();
    await vi.waitFor(() => expect(FixtureEventSource.instances).toHaveLength(1));
    const source = FixtureEventSource.instances[0];
    source.onopen?.();
    await vi.waitFor(() => expect(client.getSnapshot().connection).toBe("connected"));
    expect(source.closed).toBe(false);
  });

  it("loads personal settings and artifact snapshots alongside native history", async () => {
    personal = {
      projects: [{ id: "default", name: "Fixture", path: "/fixture/workspace", kind: "directory", revision: 1, createdAt: task.createdAt, updatedAt: task.updatedAt }],
      roles: [{ id: "assistant", name: "Assistant", instructions: "Use fixture only", revision: 1, createdAt: task.createdAt, updatedAt: task.updatedAt }],
      memories: [],
    };
    artifacts = { artifacts: [{ id: "report", name: "report.md", mediaType: "text/markdown", size: 8, sha256: "0".repeat(64), sessionId: "conversation", originSessionId: "conversation", createdAt: task.createdAt }] };
    await connect();
    expect(client.getSnapshot().personal).toEqual(personal);
    expect(client.getSnapshot().artifacts).toEqual(artifacts);
    await client.create();
    expect(mutations.find((entry) => entry.method === "personbot.v1.sessions.create")?.params).toMatchObject({ projectId: "default", roleId: "assistant" });
  });

  it("refreshes native memory proposals and artifacts immediately after personal.changed", async () => {
    await connect();
    personal = { ...personal, memories: [{
      id: "suggested", scope: "personal", key: "style", value: "Use Markdown", status: "proposed", source: "agent",
      sourceSessionId: "conversation", revision: 1, createdAt: task.createdAt, updatedAt: task.updatedAt,
    }] };
    FixtureEventSource.instances[0].onmessage?.({ data: JSON.stringify({
      kind: "runtime", event: { generation: "first", eventSeq: 1, type: "personal.changed", payload: {} },
    }) });
    await vi.waitFor(() => expect(client.getSnapshot().personal?.memories[0]?.status).toBe("proposed"));
  });

  it("loads integration configuration and refreshes durable event receipts after integrations.changed", async () => {
    const source = {
      id: "inbound", name: "Fixture inbound", originSessionId: "conversation", enabled: false, goal: "Review event",
      criteria: ["Ask for acceptance"], callbackMode: "at-most-once" as const, revision: 1, createdAt: task.createdAt, updatedAt: task.updatedAt,
    };
    integrations.sources.push(source);
    await connect();
    expect(client.getSnapshot().integrations?.sources).toEqual([source]);
    integrations = { ...integrations, triggers: [{
      id: "event", sourceId: source.id, eventId: "remote-1", threadId: "thread", text: "Fixture event",
      receivedAt: task.createdAt, status: "delivered", taskIds: ["task"],
    }] };
    FixtureEventSource.instances[0].onmessage?.({ data: JSON.stringify({
      kind: "runtime", event: { generation: "first", eventSeq: 1, type: "integrations.changed", payload: {} },
    }) });
    await vi.waitFor(() => expect(client.getSnapshot().integrations?.triggers[0]?.status).toBe("delivered"));
  });

  it("reuses source identity and original revision on an ambiguous write without exposing the token to state or storage", async () => {
    await connect();
    const normalRpc = rpc;
    let lost = false;
    rpc = (method, params) => {
      if (method === "personbot.v1.sources.put" && !lost) { lost = true; throw new Error("source response lost"); }
      return normalRpc(method, params);
    };
    const token = "private-fixture-token-".repeat(3);
    const source = {
      name: "Fixture", originSessionId: "conversation", goal: "Review fixture", criteria: ["Human acceptance"],
      enabled: false, callbackMode: "at-most-once" as const, token,
    };
    const storageWrite = vi.spyOn(localStorage, "setItem");
    expect(await client.saveSource({ ...source, revision: 2 })).toBe(false);
    expect(JSON.stringify(client.getSnapshot())).not.toContain(token);
    const commands = (client as unknown as { personalCommands: Map<string, unknown> }).personalCommands;
    expect([...commands.keys()].join("")).not.toContain(token);
    expect(storageWrite.mock.calls.flat().join("")).not.toContain(token);
    expect(await client.saveSource({ ...source, revision: 3 })).toBe(true);
    const saves = mutations.filter((entry) => entry.method === "personbot.v1.sources.put");
    expect(saves).toHaveLength(2);
    expect(saves[1].params).toEqual(saves[0].params);
    expect(saves[0].params).toMatchObject({ enabled: false, token, expectedRevision: 2 });
    expect(commands.size).toBe(0);
  });

  it("omits an existing source token unless rotating and releases a conflicting command before a fresh revision", async () => {
    await connect();
    const normalRpc = rpc;
    let conflict = true;
    rpc = (method, params) => {
      if (method === "personbot.v1.sources.put" && conflict) { conflict = false; throw Object.assign(new Error("revision conflict"), { status: 409 }); }
      return normalRpc(method, params);
    };
    const source = { id: "inbound", name: "Fixture", originSessionId: "conversation", goal: "Review", criteria: ["Accept"], enabled: true, callbackMode: "at-most-once" as const };
    expect(await client.saveSource({ ...source, revision: 2 })).toBe(false);
    expect(await client.saveSource({ ...source, revision: 3 })).toBe(true);
    const saves = mutations.filter((entry) => entry.method === "personbot.v1.sources.put");
    expect(saves[0].params).not.toHaveProperty("token");
    expect(saves[1].params).not.toHaveProperty("token");
    expect(saves[1].params.commandId).not.toBe(saves[0].params.commandId);
    expect(saves[1].params.expectedRevision).toBe(3);
  });

  it.each(["schedule", "subscription"] as const)("keeps a %s's command and generated id stable when its accepted response is lost", async (kind) => {
    await connect();
    const normalRpc = rpc;
    const methodName = kind === "schedule" ? "personbot.v1.schedules.put" : "personbot.v1.subscriptions.put";
    let lost = false;
    rpc = (method, params) => {
      if (method === methodName && !lost) { lost = true; throw new Error("accepted response lost"); }
      return normalRpc(method, params);
    };
    const save = () => kind === "schedule"
      ? client.saveSchedule({ name: "Every minute", sourceId: "inbound", threadId: "thread", text: "Wake", runAt: task.createdAt, intervalSeconds: 60, enabled: false })
      : client.saveSubscription({ sourceId: "inbound", threadId: "thread", taskId: "task", enabled: true });
    expect(await save()).toBe(false);
    expect(await save()).toBe(true);
    const writes = mutations.filter((entry) => entry.method === methodName);
    expect(writes).toHaveLength(2);
    expect(writes[1].params).toEqual(writes[0].params);
  });

  it("allows manual callback control only for uncertain or failed receipts and treats accepted control as success", async () => {
    await connect();
    const delivery: ChannelDeliveryRecord = {
      id: "delivery", sourceId: "inbound", threadId: "thread", taskId: "task", updateId: "update",
      url: "http://127.0.0.1:54321/callback", mode: "at-most-once", state: "delivered", attempts: 1,
      createdAt: task.createdAt, updatedAt: task.updatedAt, payload: { text: "Result" },
    };
    expect(await client.controlDelivery(delivery, "retry")).toBe(false);
    expect(mutations.filter((entry) => entry.method === "personbot.v1.deliveries.control")).toHaveLength(0);
    const normalRpc = rpc;
    let accepted = false;
    rpc = (method, params) => {
      if (method === "personbot.v1.deliveries.control") { accepted = true; return {}; }
      if (method === "personbot.v1.integrations.snapshot" && accepted) throw new Error("receipts unavailable");
      return normalRpc(method, params);
    };
    expect(await client.controlDelivery({ ...delivery, state: "uncertain" }, "retry")).toBe(true);
    expect(client.getSnapshot().actionError).toBeUndefined();
    expect(client.getSnapshot().error).toBe("receipts unavailable");
    expect(mutations.find((entry) => entry.method === "personbot.v1.deliveries.control")?.params).toMatchObject({ deliveryId: "delivery", expectedState: "uncertain", action: "retry" });
  });

  it("keeps an ambiguous new session bound to its selected project and role on retry", async () => {
    await connect();
    const normalRpc = rpc;
    let lost = false;
    rpc = (method, params) => {
      if (method === "personbot.v1.sessions.create" && !lost) { lost = true; throw new Error("creation response lost"); }
      return normalRpc(method, params);
    };
    expect(await client.create({ projectId: "project", roleId: "reviewer" })).toBeUndefined();
    expect(await client.create({ projectId: "project", roleId: "reviewer" })).toBeTypeOf("string");
    const creates = mutations.filter((entry) => entry.method === "personbot.v1.sessions.create");
    expect(creates).toHaveLength(2);
    expect(creates[1].params).toEqual(creates[0].params);
    expect(creates[0].params).toMatchObject({ projectId: "project", roleId: "reviewer" });
  });

  it("replays the same memory command and expected revision after an ambiguous save", async () => {
    await connect();
    const normalRpc = rpc;
    let lost = false;
    rpc = (method, params) => {
      if (method === "personbot.v1.memory.put" && !lost) { lost = true; throw new Error("memory response lost"); }
      return normalRpc(method, params);
    };
    const memory = { id: "format", scope: "personal" as const, key: "format", value: "Markdown" };
    expect(await client.saveMemory({ ...memory, revision: 2 })).toBe(false);
    expect(await client.saveMemory({ ...memory, revision: 3 })).toBe(true);
    const saves = mutations.filter((entry) => entry.method === "personbot.v1.memory.put");
    expect(saves).toHaveLength(2);
    expect(saves[1].params).toEqual(saves[0].params);
    expect(saves[1].params.expectedRevision).toBe(2);
  });

  it("accepts an artifact publication independently of a later personal refresh failure", async () => {
    await connect();
    const normalRpc = rpc;
    let accepted = false;
    rpc = (method, params) => {
      if (method === "personbot.v1.artifacts.publish") { accepted = true; return {}; }
      if (method === "personbot.v1.personal.snapshot" && accepted) throw new Error("settings unavailable");
      return normalRpc(method, params);
    };
    expect(await client.publishArtifact("conversation", "report.md", "Fixture report")).toBe(true);
    expect(client.getSnapshot().actionError).toBeUndefined();
    expect(client.getSnapshot().error).toBe("settings unavailable");
  });

  it("retries an ambiguous send with exactly the same command and message identities", async () => {
    await connect();
    const normalRpc = rpc;
    let fail = true;
    rpc = (method, params) => {
      if (method === "personbot.v1.messages.submit" && fail) {
        fail = false;
        throw new Error("response lost");
      }
      return normalRpc(method, params);
    };
    expect(await client.submit("conversation", "same message", "followup")).toBe(false);
    expect(client.getSnapshot().actionError).toBe("response lost");
    expect(await client.submit("conversation", "same message", "followup")).toBe(true);
    const sends = mutations.filter((entry) => entry.method === "personbot.v1.messages.submit");
    expect(sends).toHaveLength(2);
    expect(sends[1].params).toEqual(sends[0].params);
  });

  it("acknowledges an accepted send even when the following history read fails", async () => {
    await connect();
    const normalRpc = rpc;
    let failRead = false;
    rpc = (method, params) => {
      if (method === "personbot.v1.messages.submit") {
        failRead = true;
        return { status: "queued" };
      }
      if (failRead && method === "personbot.v1.snapshots.get") throw new Error("history unavailable");
      return normalRpc(method, params);
    };
    expect(await client.submit("conversation", "accepted", "followup")).toBe(true);
    expect(client.getSnapshot().error).toBe("history unavailable");
    expect(client.getSnapshot().actionError).toBeUndefined();
    expect(await client.submit("conversation", "accepted", "followup")).toBe(true);
    const sends = mutations.filter((entry) => entry.method === "personbot.v1.messages.submit");
    expect(sends[1].params.commandId).not.toBe(sends[0].params.commandId);
    expect(sends[1].params.messageId).not.toBe(sends[0].params.messageId);
  });

  it("drains native history pages from their contiguous per-session cursor", async () => {
    const cursors: number[] = [];
    const events = Array.from({ length: 130 }, (_, seq) => ({ seq, time: seq, type: "future/event", data: {} }));
    rpc = (method, params) => {
      if (method !== "personbot.v1.snapshots.get") return method === "personbot.v1.tasks.list" ? tasks : {};
      if (!params.sessionId) return snapshot;
      const fromSeq = Number(params.fromSeq);
      cursors.push(fromSeq);
      const page = events.slice(fromSeq, fromSeq + 128);
      return { ...snapshot, logs: [{ sessionId: "conversation", events: page, nextSeq: fromSeq + page.length, hasMore: fromSeq + page.length < events.length }] };
    };
    await connect();
    expect(cursors).toEqual([0, 128]);
    expect(client.getSnapshot().transcript.sessions.conversation.nextSeq).toBe(130);
    expect(client.getSnapshot().transcript.sessions.conversation.events).toHaveLength(130);
  });

  it("refuses decisions while disconnected and removes an old generation's requests after reconnect", async () => {
    const decision = { requestId: "approval", generation: "first", sessionId: "conversation", kind: "approval" as const, toolName: "write_file" };
    snapshot = { ...snapshot, pending: [decision] };
    await connect();
    expect(client.getSnapshot().transcript.pending).toHaveLength(1);
    const source = FixtureEventSource.instances[0];
    source.onerror?.();
    await client.decide(decision, "allowed-once");
    expect(mutations.some((entry) => entry.method === "personbot.v1.approvals.resolve")).toBe(false);
    snapshot = { ...snapshot, generation: "second", pending: [] };
    source.onopen?.();
    await vi.waitFor(() => expect(client.getSnapshot().connection).toBe("connected"));
    expect(client.getSnapshot().transcript.pending).toEqual([]);
    expect(client.getSnapshot().transcript.generation).toBe("second");
    expect(mutations.filter((entry) => entry.method === "personbot.v1.sessions.resume")).toHaveLength(2);
  });

  it("reuses a failed Stop receipt identity when the person retries", async () => {
    await connect();
    const normalRpc = rpc;
    let failed = false;
    rpc = (method, params) => {
      if (method === "personbot.v1.sessions.stop") {
        if (!failed) { failed = true; throw new Error("Stop response lost"); }
        return { confirmed: true, errors: [] };
      }
      return normalRpc(method, params);
    };
    await client.stop("conversation");
    await client.stop("conversation");
    const stops = mutations.filter((entry) => entry.method === "personbot.v1.sessions.stop");
    expect(stops).toHaveLength(2);
    expect(stops[1].params).toEqual(stops[0].params);
  });

  it("starts a fresh Stop command after receiving an explicit failed receipt", async () => {
    await connect();
    const normalRpc = rpc;
    let attempts = 0;
    rpc = (method, params) => {
      if (method === "personbot.v1.sessions.stop") {
        return ++attempts === 1 ? { confirmed: false, errors: ["Child did not drain"] } : { confirmed: true, errors: [] };
      }
      return normalRpc(method, params);
    };
    await client.stop("conversation");
    expect(client.getSnapshot().actionError).toBe("Child did not drain");
    await client.stop("conversation");
    const stops = mutations.filter((entry) => entry.method === "personbot.v1.sessions.stop");
    expect(stops).toHaveLength(2);
    expect(stops[1].params.commandId).not.toBe(stops[0].params.commandId);
    expect(client.getSnapshot().actionError).toBeUndefined();
  });

  it("does not mark a stream connected when it drops during snapshot recovery", async () => {
    const normalRpc = rpc;
    let resolveRead: ((value: RuntimeSnapshot) => void) | undefined;
    let delayed = false;
    rpc = (method, params) => {
      if (method === "personbot.v1.snapshots.get" && !delayed) {
        delayed = true;
        return new Promise<RuntimeSnapshot>((resolve) => { resolveRead = resolve; });
      }
      return normalRpc(method, params);
    };
    client.start();
    await vi.waitFor(() => expect(FixtureEventSource.instances).toHaveLength(1));
    const source = FixtureEventSource.instances[0];
    source.onopen?.();
    await vi.waitFor(() => expect(resolveRead).toBeDefined());
    source.onerror?.();
    resolveRead!(snapshot);
    await vi.waitFor(() => expect(client.getSnapshot().transcript.generation).toBe("first"));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(client.getSnapshot().connection).toBe("reconnecting");
  });

  it("restores the selected session from storage scoped to the server environment", async () => {
    const second = { ...session, sessionId: "second", conversationId: "second" };
    snapshot = { ...snapshot, sessions: [session, second] };
    localStorage.setItem("personbot:selected:fixture", "second");
    const normalRpc = rpc;
    rpc = (method, params) => {
      if (method === "personbot.v1.snapshots.get" && params.sessionId) {
        return { ...snapshot, logs: [{ sessionId: String(params.sessionId), events: [], nextSeq: 0, hasMore: false }] };
      }
      return normalRpc(method, params);
    };
    await connect();
    expect(client.getSnapshot().selectedId).toBe("second");
    const resumes = mutations.filter((entry) => entry.method === "personbot.v1.sessions.resume");
    expect(resumes).toEqual([{ method: "personbot.v1.sessions.resume", params: { sessionId: "second" } }]);
    await client.refresh();
    expect(mutations.filter((entry) => entry.method === "personbot.v1.sessions.resume")).toHaveLength(1);
  });

  it("loads worker history without resuming it or permitting native input and Stop", async () => {
    const worker = { ...session, sessionId: "worker-task", conversationId: undefined, taskId: "task" };
    snapshot = { ...snapshot, sessions: [session, worker] };
    tasks = { ...tasks, tasks: [task] };
    const normalRpc = rpc;
    rpc = (method, params) => method === "personbot.v1.snapshots.get" && params.sessionId
      ? { ...snapshot, logs: [{ sessionId: String(params.sessionId), events: [], nextSeq: 0, hasMore: false }] }
      : normalRpc(method, params);
    await connect();
    await client.select("worker-task");
    expect(client.getSnapshot().tasks.tasks).toEqual([task]);
    expect(client.getSnapshot().selectedId).toBe("worker-task");
    expect(mutations.filter((entry) => entry.method === "personbot.v1.sessions.resume").map((entry) => entry.params.sessionId)).toEqual(["conversation"]);
    expect(await client.submit("worker-task", "bypass", "followup")).toBe(false);
    await client.stop("worker-task");
    expect(mutations.filter((entry) => ["personbot.v1.messages.submit", "personbot.v1.sessions.stop"].includes(entry.method))).toEqual([]);
    await client.select("conversation");
    expect(await client.submit("conversation", "still responsive", "followup")).toBe(true);
  });

  it("retries an ambiguous task create with the same task and command identities", async () => {
    await connect();
    const normalRpc = rpc;
    let lost = false;
    rpc = (method, params) => {
      if (method === "personbot.v1.tasks.create" && !lost) { lost = true; throw new Error("task response lost"); }
      return normalRpc(method, params);
    };
    expect(await client.createTask("conversation", "Write a report", ["Cite the fixture"], "Explicit context")).toBe(false);
    expect(await client.createTask("conversation", "Write a report", ["Cite the fixture"], "Explicit context")).toBe(true);
    const creates = mutations.filter((entry) => entry.method === "personbot.v1.tasks.create");
    expect(creates).toHaveLength(2);
    expect(creates[1].params).toEqual(creates[0].params);
    expect(creates[0].params.criteria).toEqual(["Cite the fixture"]);
  });

  it("keeps an uncertain task action bound to its original revision during refreshes", async () => {
    tasks = { ...tasks, tasks: [task] };
    await connect();
    const normalRpc = rpc;
    let lost = false;
    rpc = (method, params) => {
      if (method === "personbot.v1.tasks.control" && !lost) { lost = true; throw new Error("control response lost"); }
      return normalRpc(method, params);
    };
    expect(await client.controlTask(task, "accept")).toBe(false);
    expect(await client.controlTask({ ...task, revision: 4 }, "accept")).toBe(true);
    const actions = mutations.filter((entry) => entry.method === "personbot.v1.tasks.control");
    expect(actions).toHaveLength(2);
    expect(actions[1].params).toEqual(actions[0].params);
    expect(actions[1].params.expectedRevision).toBe(3);
  });

  it("allocates a new command and revision after a definite task conflict", async () => {
    await connect();
    const normalRpc = rpc;
    let conflict = false;
    rpc = (method, params) => {
      if (method === "personbot.v1.tasks.control" && !conflict) {
        conflict = true;
        throw Object.assign(new Error("Task revision changed"), { status: 409 });
      }
      return normalRpc(method, params);
    };
    expect(await client.controlTask(task, "pause")).toBe(false);
    expect(await client.controlTask({ ...task, revision: 4 }, "pause")).toBe(true);
    const actions = mutations.filter((entry) => entry.method === "personbot.v1.tasks.control");
    expect(actions[1].params.commandId).not.toBe(actions[0].params.commandId);
    expect(actions[1].params.expectedRevision).toBe(4);
  });

  it("acknowledges a task action even if the accepted result's refresh fails", async () => {
    await connect();
    const normalRpc = rpc;
    let failRead = false;
    rpc = (method, params) => {
      if (method === "personbot.v1.tasks.control") { failRead = true; return task; }
      if (method === "personbot.v1.tasks.list" && failRead) throw new Error("task list unavailable");
      return normalRpc(method, params);
    };
    expect(await client.controlTask(task, "accept")).toBe(true);
    expect(client.getSnapshot().actionError).toBeUndefined();
    expect(client.getSnapshot().error).toBe("task list unavailable");
  });
});
