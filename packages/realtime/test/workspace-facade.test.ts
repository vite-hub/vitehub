import { expect, it } from "vitest";
import { defineWorkspace, useWorkspace } from "@vite-hub/workspace";
import { registerWorkspace } from "@vite-hub/workspace/test";
import { readRealtimeWorkspaceDocument } from "../src/server.ts";
import { markdownToYDoc as packagedMarkdownToYDoc, yDocToMarkdown as packagedYDocToMarkdown } from "../dist/server.js";

it("opens a new collaborative document through real memory Workspace facades", async () => {
  const name = "realtime-new-memory-document";
  registerWorkspace(name, defineWorkspace({ store: { provider: "memory" }, rules: { "/**": { write: true, mediaType: "text/markdown" } } }));
  const readable = useWorkspace(name);
  const writable = useWorkspace(name, { mode: "write" });
  await expect(readRealtimeWorkspaceDocument(readable, writable, "guides/new.md")).resolves.toEqual({ baselineDigest: undefined, markdown: "" });
});

it("rejects an unregistered Workspace instead of opening an empty room", async () => {
  const name = "realtime-unregistered-workspace";
  await expect(readRealtimeWorkspaceDocument(useWorkspace(name), useWorkspace(name, { mode: "write" }), "guides/new.md"))
    .rejects.toMatchObject({ code: "WORKSPACE_NOT_FOUND", details: { name } });
});

it("opens new documents through the packaged Realtime server without duplicate models", () => {
  for (const markdown of ["", "# Shared document\n\nA paragraph."]) {
    const document = packagedMarkdownToYDoc(markdown);
    try { expect(packagedYDocToMarkdown(document)).toBe(markdown); }
    finally { document.destroy(); }
  }
});
