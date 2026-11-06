import { describe, expect, it, vi } from "vitest";
import type { SuperagentBinding, SuperagentEvent, SuperagentGateway, SuperagentInput } from "../shared/superagent.ts";
import type { RuntimeEvent } from "./contracts.ts";
import { createSuperagentDriver, SUPERAGENT_INSTANCE_ID } from "./superagent-driver.ts";

async function fixture(currentBinding?: (threadId: string) => (SuperagentBinding & { requestId?: string }) | undefined) {
  let listener: ((event: SuperagentEvent) => void) | undefined;
  const inputs: SuperagentInput[] = [];
  const gateway: SuperagentGateway = {
    start: async () => {},
    submit: async input => { inputs.push(input); },
    interrupt: vi.fn(async () => {}),
    respond: vi.fn(async () => true),
    generateText: async () => "memory output",
    subscribe: callback => { listener = callback; return () => { listener = undefined; }; },
    close: async () => {},
    status: () => ({ enabled: true, state: "ready" }),
  };
  const driver = createSuperagentDriver({ gateway: () => gateway, model: () => "deepseek-flash", configured: () => true, currentBinding });
  const instance = await driver.create({ instanceId: SUPERAGENT_INSTANCE_ID, displayName: undefined, environment: {}, enabled: true, config: {} });
  const events: RuntimeEvent[] = [];
  instance.adapter.onEvent(event => { events.push(event); });
  const start = () => instance.adapter.sendTurn({ botId: "bot", threadId: "thread", text: "new input", system: "initial persona", model: "deepseek-flash", approvalMode: "ask" });
  return { instance, events, gateway, inputs, start, connect: driver.connect, emit: (event: SuperagentEvent) => listener?.(event) };
}

describe("official Super Agent driver", () => {
  it("projects the source outbox once and correlates every event to its original binding and request", async () => {
    const f = await fixture();
    const { turnId } = await f.start();
    expect(f.inputs).toEqual([expect.objectContaining({ botId: "bot", threadId: "thread", requestId: turnId, text: "new input" })]);
    const binding = { botId: "bot", threadId: "thread", contextId: f.inputs[0]!.contextId, requestId: turnId };
    f.emit({ ...binding, type: "reply", botId: "other", messageId: "wrong", text: "wrong", purpose: "reply" });
    f.emit({ ...binding, type: "reply", requestId: "old", messageId: "stale", text: "stale", purpose: "reply" });
    f.emit({ ...binding, type: "text", sessionId: "worker", text: "worker scratch" });
    f.emit({ ...binding, type: "started", sessionId: "native" });
    f.emit({ ...binding, type: "tool", callId: "tool", phase: "start", name: "read", input: { path: "note" } });
    f.emit({ ...binding, type: "tool", callId: "tool", phase: "end", name: "read", output: "done" });
    for (let i = 0; i < 2; i++) f.emit({ ...binding, type: "reply", messageId: "outbox", text: "answer", purpose: "reply" });
    f.emit({ ...binding, type: "completed", sessionId: "native" });
    expect(f.events.filter(event => event.type === "item.completed" && event.itemType === "assistant_text")).toEqual([
      expect.objectContaining({ text: "answer", threadId: "thread", turnId, itemId: "outbox" }),
    ]);
    expect(f.events.some(event => event.type === "content.delta")).toBe(false);
    expect(f.events.filter(event => event.type === "turn.completed")).toEqual([expect.objectContaining({ ok: true, turnId })]);
    expect(f.instance.adapter.hasSession("thread")).toBe(true);
    expect(f.instance.adapter.capabilities.browserMcp).toBeUndefined();
    await f.instance.dispose();
  });

  it("answers only a currently owned native decision and retains denial semantics", async () => {
    const f = await fixture();
    const { turnId } = await f.start();
    const binding = { botId: "bot", threadId: "thread", contextId: f.inputs[0]!.contextId, requestId: turnId };
    f.emit({ ...binding, type: "approval", decisionId: "decision", prompt: "Run command?" });
    expect(await f.instance.adapter.respondToRequest("other", "decision", { behavior: "allow" })).toBe("unavailable");
    expect(await f.instance.adapter.respondToRequest("thread", "decision", { behavior: "deny" })).toBe("rejected");
    expect(f.gateway.respond).toHaveBeenCalledWith(expect.objectContaining(binding), "decision", { behavior: "deny", message: undefined });
    expect(await f.instance.adapter.respondToRequest("thread", "decision", { behavior: "allow" })).toBe("unavailable");
    expect(f.events.filter(event => event.type === "request.resolved")).toEqual([expect.objectContaining({ requestId: "decision", behavior: "deny", source: "user" })]);
    await f.instance.dispose();
  });

  it("stops only the exact active turn, closes pending decisions, and ignores late replies", async () => {
    const f = await fixture();
    const { turnId } = await f.start();
    const binding = { botId: "bot", threadId: "thread", contextId: f.inputs[0]!.contextId, requestId: turnId };
    f.emit({ ...binding, type: "question", decisionId: "question", prompt: "Which directory?" });
    await f.instance.adapter.interruptTurn("thread", "stale");
    expect(f.gateway.interrupt).not.toHaveBeenCalled();
    await f.instance.adapter.interruptTurn("thread", turnId);
    f.emit({ ...binding, type: "reply", messageId: "late", text: "late", purpose: "reply" });
    f.emit({ ...binding, type: "completed" });
    expect(f.gateway.interrupt).toHaveBeenCalledOnce();
    expect(f.events.filter(event => event.type === "turn.completed")).toEqual([expect.objectContaining({ ok: false, stopReason: "interrupted" })]);
    expect(f.events.filter(event => event.type === "item.completed" && event.itemType === "assistant_text")).toHaveLength(0);
    expect(await f.instance.adapter.respondToRequest("thread", "question", { behavior: "answer", message: "here" })).toBe("unavailable");
    await f.instance.dispose();
  });

  it("continues the persisted native context without replay and resets it after a branch change", async () => {
    const f = await fixture();
    const first = await f.start();
    const original = { botId: "bot", threadId: "thread", contextId: f.inputs[0]!.contextId, requestId: first.turnId };
    f.emit({ ...original, type: "started", sessionId: "private-worker-id" });
    const started = f.events.find(event => event.type === "session.started");
    expect(started?.type).toBe("session.started");
    const cursor = started?.type === "session.started" ? started.sessionId : "";
    expect(cursor).toBe(`omb-superagent:${original.contextId}`);
    expect(f.inputs[0]!.instructions).toBe("initial persona");
    f.emit({ ...original, type: "completed" });

    const continuation = await f.instance.adapter.sendTurn({
      botId: "bot", threadId: "thread", text: "only the next input", system: "must not be replayed",
      resumeCursor: cursor, model: "deepseek-flash", approvalMode: "ask",
    });
    expect(f.inputs[1]).toEqual(expect.objectContaining({ contextId: original.contextId, text: "only the next input" }));
    expect(f.inputs[1]).not.toHaveProperty("instructions");
    f.emit({ ...original, requestId: continuation.turnId, type: "completed" });

    const branch = await f.instance.adapter.sendTurn({
      botId: "bot", threadId: "thread", text: "new branch", system: "bounded branch reference",
      resumeCursor: cursor, sessionReset: true, model: "deepseek-flash", approvalMode: "ask",
    });
    expect(f.inputs[2]!.contextId).not.toBe(original.contextId);
    expect(f.inputs[2]!.instructions).toBe("bounded branch reference");
    f.emit({ ...original, requestId: branch.turnId, type: "reply", messageId: "retired", text: "retired branch", purpose: "reply" });
    f.emit({ ...original, contextId: f.inputs[2]!.contextId, requestId: branch.turnId, type: "reply", messageId: "current", text: "current branch", purpose: "reply" });
    expect(f.events.filter(event => event.type === "item.completed" && event.itemType === "assistant_text")).toEqual([
      expect.objectContaining({ text: "current branch" }),
    ]);
    await f.instance.dispose();
  });

  it("settles a rejected native submission through one canonical failure", async () => {
    const f = await fixture();
    f.gateway.submit = async () => { throw new Error("Native runtime could not start"); };
    const { turnId } = await f.start();
    expect(f.events.filter(event => event.type === "runtime.error")).toEqual([
      expect.objectContaining({ turnId, terminal: true, message: "Native runtime could not start" }),
    ]);
    expect(f.events.filter(event => event.type === "turn.completed")).toEqual([
      expect.objectContaining({ turnId, ok: false }),
    ]);
    await f.instance.dispose();
  });

  it("keeps durable source delivery separate from exact-turn lifecycle projection", async () => {
    const f = await fixture();
    const { turnId } = await f.instance.adapter.sendTurn({
      botId: "bot", threadId: "thread", sourceMessageId: "original-user-message", text: "source input",
    });
    const binding = { botId: "bot", threadId: "thread", contextId: f.inputs[0]!.contextId, requestId: turnId };
    expect(f.inputs[0]!.sourceMessageId).toBe("original-user-message");
    f.emit({ ...binding, type: "reply", persisted: true, messageId: "outbox", text: "already committed", purpose: "result" });
    f.emit({ ...binding, type: "completed" });
    expect(f.events.filter(event => event.type === "item.completed" && event.itemType === "assistant_text")).toHaveLength(0);
    expect(f.events.filter(event => event.type === "turn.completed")).toEqual([
      expect.objectContaining({ turnId, ok: true }),
    ]);
    await f.instance.dispose();
  });

  it("resumes a stored context after the product adapter restarts", async () => {
    const previous = await fixture();
    const { turnId } = await previous.start();
    const contextId = previous.inputs[0]!.contextId;
    previous.emit({ botId: "bot", threadId: "thread", contextId, requestId: turnId, type: "completed" });
    await previous.instance.dispose();
    const resumed = await fixture();
    await resumed.instance.adapter.sendTurn({
      botId: "bot", threadId: "thread", text: "after restart", system: "no replay",
      resumeCursor: `omb-superagent:${contextId}`, model: "deepseek-flash", approvalMode: "ask",
    });
    expect(resumed.inputs[0]!.contextId).toBe(contextId);
    expect(resumed.inputs[0]).not.toHaveProperty("instructions");
    await resumed.instance.dispose();
  });

  it("rechecks an interrupt when native submission was still opening", async () => {
    const f = await fixture();
    let admit = () => {};
    f.gateway.submit = async input => {
      f.inputs.push(input);
      await new Promise<void>(resolve => { admit = resolve; });
    };
    const sending = f.start();
    await f.instance.adapter.interruptTurn("thread");
    admit();
    await sending;
    expect(f.gateway.interrupt).toHaveBeenCalledTimes(2);
    expect(f.events.filter(event => event.type === "turn.completed")).toEqual([
      expect.objectContaining({ ok: false, stopReason: "interrupted" }),
    ]);
    await f.instance.dispose();
  });

  it("stops the original persisted context after a child crash without accepting a stale named turn", async () => {
    let binding: (SuperagentBinding & { requestId: string }) | undefined;
    const f = await fixture(threadId => threadId === "thread" ? binding : undefined);
    const { turnId } = await f.start();
    binding = { botId: "bot", threadId: "thread", contextId: f.inputs[0]!.contextId, requestId: turnId };
    f.emit({ ...binding, type: "failed", error: "Native process exited unexpectedly" });
    expect(f.events.filter(event => event.type === "turn.completed")).toHaveLength(1);
    await f.instance.adapter.interruptTurn("other");
    await f.instance.adapter.interruptTurn("thread", "old-turn");
    expect(f.gateway.interrupt).not.toHaveBeenCalled();
    await f.instance.adapter.interruptTurn("thread", turnId);
    expect(f.gateway.interrupt).toHaveBeenCalledExactlyOnceWith(binding, { scope: "request", requestId: turnId });
    expect(f.events.filter(event => event.type === "turn.completed")).toHaveLength(1);
    await f.instance.dispose();
  });

  it("restores an unnamed Stop after adapter restart but requires proof for a named Stop", async () => {
    const binding = { botId: "bot", threadId: "thread", contextId: "stored-context" };
    const f = await fixture(threadId => threadId === "thread" ? binding : undefined);
    await f.instance.adapter.interruptTurn("thread", "unproven-turn");
    expect(f.gateway.interrupt).not.toHaveBeenCalled();
    await f.instance.adapter.interruptTurn("thread");
    expect(f.gateway.interrupt).toHaveBeenCalledExactlyOnceWith(binding, { scope: "conversation" });
    expect(f.events).toHaveLength(0);
    await f.instance.dispose();
  });

  it("projects native structured questions into the existing question card options", async () => {
    const f = await fixture();
    const { turnId } = await f.start();
    const binding = { botId: "bot", threadId: "thread", contextId: f.inputs[0]!.contextId, requestId: turnId };
    f.emit({ ...binding, type: "question", decisionId: "format", prompt: JSON.stringify([
      { id: "format", question: "Which format?", options: [{ label: "Markdown" }, { label: "Text", description: "Plain text" }] },
      { id: "tone", question: "Which tone?", options: ["Brief", "Detailed"] },
    ]) });
    f.emit({ ...binding, type: "question", decisionId: "other", prompt: "Which folder?" });
    expect(f.events.filter(event => event.type === "request.opened")).toEqual([
      expect.objectContaining({
        requestId: "format", requestType: "question", summary: "Which format? (+1 more question)",
        questions: [
          { question: "Which format?", options: [{ label: "Markdown" }, { label: "Text", description: "Plain text" }] },
          { question: "Which tone?", options: [{ label: "Brief" }, { label: "Detailed" }] },
        ],
      }),
      expect.objectContaining({ requestId: "other", summary: "Which folder?", questions: [{ question: "Which folder?", options: [] }] }),
    ]);
    await f.instance.dispose();
  });

  it("settles the exact outstanding source tool before completion and ignores its late result", async () => {
    const f = await fixture();
    const { turnId } = await f.start();
    const binding = { botId: "bot", threadId: "thread", contextId: f.inputs[0]!.contextId, requestId: turnId };
    f.emit({ ...binding, type: "tool", callId: "source-reply", phase: "start", name: "orchestrator_reply" });
    f.emit({ ...binding, contextId: "retired", type: "tool", callId: "unrelated", phase: "start", name: "orchestrator_reply" });
    f.emit({ ...binding, type: "reply", persisted: true, messageId: "outbox", text: "durably delivered", purpose: "result" });
    f.emit({ ...binding, type: "completed" });
    f.emit({ ...binding, type: "tool", callId: "source-reply", phase: "end", name: "orchestrator_reply", output: "sent" });
    const completed = f.events.filter(event => event.type === "item.completed" && event.itemType === "tool");
    expect(completed).toEqual([expect.objectContaining({ itemId: "source-reply", turnId, ok: true })]);
    expect(f.events.indexOf(completed[0]!)).toBeLessThan(f.events.findIndex(event => event.type === "turn.completed"));
    expect(f.events.filter(event => event.type === "item.started")).toHaveLength(1);
    await f.instance.dispose();
  });

  it("marks only the stopped request's unfinished tool as unsuccessful", async () => {
    const f = await fixture();
    const { turnId } = await f.start();
    const binding = { botId: "bot", threadId: "thread", contextId: f.inputs[0]!.contextId, requestId: turnId };
    f.emit({ ...binding, type: "tool", callId: "waiting", phase: "start", name: "worker" });
    await f.instance.adapter.interruptTurn("thread", turnId);
    expect(f.events.filter(event => event.type === "item.completed" && event.itemType === "tool")).toEqual([
      expect.objectContaining({ itemId: "waiting", turnId, ok: false }),
    ]);
    await f.instance.dispose();
  });

  it("shows readable task changes once per ticket and turn", async () => {
    const f = await fixture();
    const { turnId } = await f.start();
    const binding = { botId: "bot", threadId: "thread", contextId: f.inputs[0]!.contextId, requestId: turnId };
    const ticket = { ...binding, type: "task" as const, ticketId: "private-native-uuid", title: "Write proof", state: "working" };
    f.emit(ticket);
    f.emit(ticket);
    f.emit({ ...ticket, state: "person/answer" });
    f.emit({ ...ticket, state: "person/answer" });
    f.emit({ ...ticket, ticketId: "second-ticket" });
    expect(f.events.filter(event => event.type === "runtime.notice")).toEqual([
      expect.objectContaining({ message: "Write proof: Working", turnId }),
      expect.objectContaining({ message: "Write proof: Waiting for your answer", turnId }),
      expect.objectContaining({ message: "Write proof: Working", turnId }),
    ]);
    await f.instance.dispose();
  });

  it("keeps a stopped task's terminal notice while rejecting later active work and approvals", async () => {
    const f = await fixture();
    const { turnId } = await f.start();
    const binding = { botId: "bot", threadId: "thread", contextId: f.inputs[0]!.contextId, requestId: turnId };
    const ticket = { ...binding, type: "task" as const, ticketId: "ticket", title: "Write proof", state: "working" };
    f.emit(ticket);
    await f.instance.adapter.interruptTurn("thread", turnId);
    f.emit({ ...ticket, state: "person/answer" });
    f.emit({ ...ticket, state: "stopped", ended: true });
    f.emit({ ...ticket, state: "stopped", ended: true });
    f.emit({ ...binding, type: "approval", decisionId: "late", prompt: "Continue?", ticketId: ticket.ticketId });
    expect(f.events.filter(event => event.type === "runtime.notice")).toEqual([
      expect.objectContaining({ message: "Write proof: Working" }),
      expect.objectContaining({ message: "Write proof: Stopped" }),
    ]);
    expect(f.events.filter(event => event.type === "request.opened")).toEqual([]);
    await f.instance.dispose();
  });

  it("projects persisted approval expiry after restart without requiring a new input or an in-memory decision", async () => {
    const f = await fixture();
    f.connect();
    f.emit({ type: "decision.resolved", botId: "bot", threadId: "thread", contextId: "persisted-context",
      requestId: "persisted-input", decisionId: "persisted-approval", reason: "The native process restarted" });
    expect(f.events).toEqual([
      expect.objectContaining({ type: "request.resolved", threadId: "thread", turnId: "persisted-input",
        requestId: "persisted-approval", behavior: "deny", source: "system", background: true,
        nativeTask: expect.objectContaining({ botId: "bot", contextId: "persisted-context" }) }),
    ]);
    expect(f.inputs).toEqual([]);
    await f.instance.dispose();
  });

  it("keeps a persistent task approval reachable after its input completes and during a new input", async () => {
    const f = await fixture();
    const first = await f.start();
    const binding = { botId: "bot", threadId: "thread", contextId: f.inputs[0]!.contextId, requestId: first.turnId };
    f.emit({ ...binding, type: "completed" });
    f.emit({ ...binding, type: "approval", decisionId: "background-before-next-input", prompt: "Write the task output?", ticketId: "ticket-a", agentId: "worker-a", callId: "write-a" });
    const next = await f.instance.adapter.sendTurn({
      botId: "bot", threadId: "thread", text: "an unrelated question", resumeCursor: `omb-superagent:${binding.contextId}`,
    });
    f.emit({ ...binding, type: "question", decisionId: "background-during-next-input", prompt: "Which format?", ticketId: "ticket-a" });
    expect(f.events.filter(event => event.type === "request.opened")).toEqual([
      expect.objectContaining({ requestId: "background-before-next-input", turnId: first.turnId, background: true,
        nativeTask: expect.objectContaining({ ticketId: "ticket-a", agentId: "worker-a", callId: "write-a" }) }),
      expect.objectContaining({ requestId: "background-during-next-input", turnId: first.turnId, background: true }),
    ]);
    expect(await f.instance.adapter.respondToRequest("thread", "background-before-next-input", { behavior: "allow" })).toBe("allowed-once");
    expect(await f.instance.adapter.respondToRequest("thread", "background-during-next-input", { behavior: "answer", message: "Markdown" })).toBe("answered");
    f.emit({ ...binding, type: "completed" });
    expect(f.events.filter(event => event.type === "turn.completed")).toHaveLength(1);
    f.emit({ ...binding, requestId: next.turnId, type: "completed" });
    expect(f.events.filter(event => event.type === "turn.completed")).toHaveLength(2);
    await f.instance.dispose();
  });

  it("does not end a persistent approval merely because the input turn ended", async () => {
    const f = await fixture();
    const first = await f.start();
    const binding = { botId: "bot", threadId: "thread", contextId: f.inputs[0]!.contextId, requestId: first.turnId };
    f.emit({ ...binding, type: "approval", decisionId: "decision", prompt: "Run it?" });
    f.emit({ ...binding, type: "completed" });
    expect(f.events.filter(event => event.type === "request.resolved")).toHaveLength(0);
    expect(await f.instance.adapter.respondToRequest("thread", "decision", { behavior: "deny" })).toBe("rejected");
    await f.instance.dispose();
  });

  it("keeps a native user resolution user-owned when it arrives before the RPC acknowledgment", async () => {
    const f = await fixture();
    const first = await f.start();
    const binding = { botId: "bot", threadId: "thread", contextId: f.inputs[0]!.contextId, requestId: first.turnId };
    f.emit({ ...binding, type: "approval", decisionId: "decision", prompt: "Run it?" });
    f.emit({ ...binding, type: "completed" });
    f.gateway.respond = async () => {
      f.emit({ ...binding, type: "decision.resolved", decisionId: "decision", behavior: "allow" });
      return true;
    };
    expect(await f.instance.adapter.respondToRequest("thread", "decision", { behavior: "allow" })).toBe("allowed-once");
    expect(f.events.filter(event => event.type === "request.resolved")).toEqual([
      expect.objectContaining({ requestId: "decision", behavior: "allow", source: "user" }),
    ]);
    await f.instance.dispose();
  });

  it("revokes an exact task decision independently while another input remains active", async () => {
    const f = await fixture();
    const first = await f.start();
    const binding = { botId: "bot", threadId: "thread", contextId: f.inputs[0]!.contextId, requestId: first.turnId };
    f.emit({ ...binding, type: "completed" });
    f.emit({ ...binding, type: "approval", decisionId: "aborted", prompt: "Old tool call", ticketId: "ticket-a" });
    await f.instance.adapter.sendTurn({ botId: "bot", threadId: "thread", text: "new", resumeCursor: `omb-superagent:${binding.contextId}` });
    f.emit({ ...binding, type: "decision.resolved", decisionId: "aborted", reason: "call cancelled" });
    expect(await f.instance.adapter.respondToRequest("thread", "aborted", { behavior: "allow" })).toBe("unavailable");
    expect(f.events.filter(event => event.type === "turn.completed")).toHaveLength(1);
    expect(f.events.filter(event => event.type === "request.resolved")).toEqual([expect.objectContaining({ requestId: "aborted", source: "system" })]);
    await f.instance.dispose();
  });

  it("uses a new native context for a changed directory while preserving the previous task identity", async () => {
    const f = await fixture();
    const first = await f.instance.adapter.sendTurn({ botId: "bot", threadId: "thread", text: "work", cwd: "/workspace/one" });
    const binding = { botId: "bot", threadId: "thread", contextId: f.inputs[0]!.contextId, requestId: first.turnId };
    f.emit({ ...binding, type: "completed" });
    await f.instance.adapter.sendTurn({
      botId: "bot", threadId: "thread", text: "work elsewhere", cwd: "/workspace/two",
      resumeCursor: `omb-superagent:${binding.contextId}`, system: "persona and bounded reference",
    });
    expect(f.inputs[1]).toMatchObject({
      cwd: "/workspace/two", contextTransition: "workspace", previousContextId: binding.contextId,
      instructions: "persona and bounded reference",
    });
    expect(f.inputs[1]!.contextId).not.toBe(binding.contextId);
    f.emit({ ...binding, type: "approval", decisionId: "old-directory-task", prompt: "Finish old workspace task?" });
    expect(await f.instance.adapter.respondToRequest("thread", "old-directory-task", { behavior: "deny" })).toBe("rejected");
    await f.instance.dispose();
  });
});
