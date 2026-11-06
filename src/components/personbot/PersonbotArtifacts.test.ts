import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ArtifactRecord } from "../../../packages/personbot-protocol/src/index.ts";
import { artifactContentUrl, artifactPreviewKind, PersonbotArtifacts } from "./PersonbotArtifacts";

const artifact: ArtifactRecord = {
  id: "report", name: "<script>report</script>.md", mediaType: "text/markdown", size: 12,
  sha256: "0".repeat(64), sessionId: "conversation", originSessionId: "conversation", createdAt: "2026-11-05T00:00:00.000Z",
};

describe("Personbot immutable artifact controls", () => {
  it("allows only safe raster and escaped text previews", () => {
    expect(artifactPreviewKind("image/png")).toBe("image");
    expect(artifactPreviewKind("text/markdown; charset=utf-8")).toBe("text");
    expect(artifactPreviewKind("application/json")).toBe("text");
    expect(artifactPreviewKind("text/html")).toBeUndefined();
    expect(artifactPreviewKind("image/svg+xml")).toBeUndefined();
    expect(artifactPreviewKind("application/pdf")).toBeUndefined();
    expect(artifactContentUrl("file/with?#id", true)).toBe("/api/personbot/artifacts/file%2Fwith%3F%23id/content?inline=1");
  });

  it("escapes artifact names and shows only the selected session's files", () => {
    const html = renderToStaticMarkup(createElement(PersonbotArtifacts, {
      snapshot: { artifacts: [artifact, { ...artifact, id: "other", name: "other.txt", sessionId: "elsewhere" }] },
      selectedId: "conversation", client: { publishArtifact: vi.fn(async () => true) }, disabled: false,
    }));
    expect(html).toContain("&lt;script&gt;report&lt;/script&gt;.md");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("other.txt");
    expect(html).toContain('href="/api/personbot/artifacts/report/content"');
    expect(html).toContain("下载");
    expect(html).toContain("预览");
  });
});
