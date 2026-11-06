import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PendingDecision } from "../../../packages/personbot-projection/src/index.ts";
import { PersonbotDecisionCard } from "./PersonbotView";

describe("native question decision details", () => {
  it.each([
    ["plan-review", "**Back up the database**, then apply the schema migration.", "Proceed with plan"],
    ["approval", "Requested scope: **write access** to the fixture workspace only.", "Allow requested scope"],
  ])("shows the %s proposal as Markdown before its choices", (kind, detail, choice) => {
    const decision: PendingDecision = {
      kind: "question", generation: "fixture", requestId: "review", sessionId: "session",
      questions: [{
        id: "proposal", question: "Review this request", detail, intent: { kind },
        options: [{ label: choice }, { label: "Reject" }],
      }],
    };
    const html = renderToStaticMarkup(createElement(PersonbotDecisionCard, {
      decision, client: { decide: vi.fn(async () => {}) }, disabled: false, busy: false,
    }));
    expect(html).toContain("data-personbot-question-detail");
    expect(html).toContain(kind === "plan-review" ? "<strong>Back up the database</strong>" : "<strong>write access</strong>");
    expect(html.indexOf("data-personbot-question-detail")).toBeLessThan(html.indexOf(choice));
    expect(html).toContain("Review this request");
  });
});
