import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { PersonbotLegacy } from "../../../server/personbot-legacy.ts";
import type { BotRecord, Store } from "../../../server/store.ts";
import { prepareRuntime } from "../../personbot-runtime-plugin/src/launch.ts";
import { PersonbotGateway } from "../src/index.ts";

interface Snapshot {
  generation: string;
  sessions: { sessionId: string; status: string; roleId?: string; projectId?: string }[];
  logs: { events: { type: string; data: unknown }[] }[];
}

function ownerInputs(snapshot: Snapshot): number {
  return snapshot.logs[0]!.events.filter(event => event.type === "user/message"
    && (event.data as { source?: { kind: string } }).source?.kind === "user").length;
}

test("explicit legacy import preserves one native conversation and input across accepted-response loss and cold restart", { timeout: 90_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "personbot-native-import-"));
  const home = join(directory, "home");
  const workspace = join(directory, "workspace");
  await mkdir(workspace, { recursive: true });
  const gateways: PersonbotGateway[] = [];
  const services: PersonbotLegacy[] = [];
  t.after(async () => {
    await Promise.all(gateways.map(gateway => gateway.close()));
    await Promise.all(services.map(service => service.close()));
    await rm(directory, { recursive: true, force: true });
  });
  const bots = [{
    id: "archived-bot", threadId: "archived-thread", name: "Archived analyst", title: "Legacy notes",
    soul: "Check source evidence before reporting.", cwd: workspace,
    modelSelection: { instanceId: "private-legacy-engine", model: "legacy-model" },
    approvalMode: "full", alwaysAllow: ["never-transfer-this-grant"],
    resumeCursors: { "private-legacy-engine": { token: "never-transfer-this-cursor" } },
    tasks: [{ id: "archived-task", threadId: "archived-thread", title: "Research notes", createdAt: 1 }],
  }] as unknown as BotRecord[];
  const messages = [
    { id: "old-user", role: "user" as const, kind: "text" as const, text: "Inspect earlier material", at: 1 },
    { id: "old-assistant", role: "bot" as const, kind: "text" as const, text: "Unverified previous summary", at: 2 },
    { id: "old-secret", role: "user" as const, kind: "secret" as const, text: "never-transfer-this-secret", at: 3 },
  ];
  const store = {
    bots, groups: [], tasks: () => bots[0]!.tasks ?? [],
    groupTasks: () => [], messagesFor: () => messages,
  } as unknown as Pick<Store, "bots" | "groups" | "tasks" | "groupTasks" | "messagesFor">;
  const original = JSON.stringify([bots, messages]);
  let loseResponse = true;
  const launch = () => {
    const gateway = new PersonbotGateway({
      enabled: true, home, workspace, provider: "personbot-fixture", model: "fixture",
      prepare: async () => {
        const launch = await prepareRuntime({ home, workspace, provider: "personbot-fixture", model: "fixture", fixture: true });
        return {
          ...launch,
          env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, TMPDIR: directory,
            DSH_HOME: launch.env.DSH_HOME, DSH_PRIMARY_RUNTIME: "", DSH_TELEMETRY_DISABLED: "1" },
        };
      },
    });
    const legacy = new PersonbotLegacy({
      home, store,
      gateway: {
        async request(method, params, admitted) {
          const result = await gateway.request(method, params, admitted);
          if (method === "personbot.v1.messages.submit" && loseResponse) {
            loseResponse = false;
            throw new Error("Native acceptance response lost");
          }
          return result;
        },
      },
    });
    gateways.push(gateway);
    services.push(legacy);
    return { gateway, legacy };
  };
  const input = {
    commandId: "confirmed-import", goal: "Check the existing outline before continuing.",
    progress: "The outline exists; no external operation was verified.", importConfiguration: true,
  };
  let { gateway, legacy } = launch();
  await assert.rejects(legacy.import("archived-thread", input), /acceptance response lost/);
  const until = async (read: () => Promise<Snapshot>, predicate: (snapshot: Snapshot) => boolean): Promise<Snapshot> => {
    for (let attempt = 0; attempt < 250; attempt += 1) {
      const snapshot = await read();
      if (predicate(snapshot)) return snapshot;
      await delay(40);
    }
    throw new Error("Native legacy import did not settle");
  };
  let sessions = await gateway.request("personbot.v1.sessions.list", {}) as Snapshot;
  const sessionId = sessions.sessions.find(session => session.sessionId.startsWith("import-"))!.sessionId;
  const snapshot = () => gateway.request("personbot.v1.snapshots.get", { sessionId, fromSeq: 0, limit: 1000 }) as Promise<Snapshot>;
  const before = await until(snapshot, value => value.logs[0]!.events.some(event => event.type === "assistant/message"));
  const generation = before.generation;
  assert.equal(ownerInputs(before), 1);
  const serialized = JSON.stringify(before.logs);
  assert.match(serialized, /Owner-confirmed goal/);
  assert.match(serialized, /Unverified previous summary/);
  assert.doesNotMatch(serialized, /never-transfer-this-/);
  assert.equal(JSON.stringify([bots, messages]), original);
  await gateway.close();
  await legacy.close();
  services.splice(services.indexOf(legacy), 1);
  bots[0]!.soul = "Edited after import reservation";
  messages.push({ id: "later", role: "bot", kind: "text", text: "Unrelated new legacy result", at: 4 });
  ({ gateway, legacy } = launch());
  const result = await legacy.import("archived-thread", input);
  assert.equal(result.sessionId, sessionId);
  assert.equal(result.configurationImported, true);
  sessions = await gateway.request("personbot.v1.sessions.list", {}) as Snapshot;
  assert.equal(sessions.sessions.filter(session => session.sessionId.startsWith("import-")).length, 1);
  let restored = await snapshot();
  assert.notEqual(restored.generation, generation);
  assert.equal(ownerInputs(restored), 1);
  assert.doesNotMatch(JSON.stringify(restored.logs), /Edited after import reservation|Unrelated new legacy result/);
  await gateway.request("personbot.v1.messages.submit", {
    commandId: "continue-after-import", messageId: "continue-after-import-input",
    sessionId, mode: "followup", text: "echo native-import-continued",
  });
  restored = await until(snapshot, value => value.logs[0]!.events.filter(event => event.type === "assistant/message").length >= 2);
  assert.equal(ownerInputs(restored), 2);
  assert.match(JSON.stringify(restored.logs), /native-import-continued/);
  const personal = await gateway.request("personbot.v1.personal.snapshot", {}) as { roles: { id: string; instructions: string }[] };
  assert.equal(personal.roles.find(role => role.id === result.roleId)?.instructions, "Check source evidence before reporting.");
});
