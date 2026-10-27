import { expect, it } from "vitest";
import { defineWorkspace, useWorkspace } from "@vite-hub/workspace";
import { registerWorkspace } from "@vite-hub/workspace/test";
import { readRealtimeWorkspaceDocument, workspaceDocument } from "../src/server.ts";
import { realtimeMarkdownEditor as packagedEditor } from "../dist/index.js";
import { createRealtimeYDoc as packagedCreateYDoc, readRealtimeYDoc as packagedReadYDoc, workspaceDocument as packagedWorkspaceDocument } from "../dist/server.js";

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

it.each([
  ["source", workspaceDocument],
  ["packaged", packagedWorkspaceDocument],
] as const)("reports a conflict for a deleted document through the %s adapter", async (entry, createAdapter) => {
  const name = `realtime-deleted-memory-document-${entry}`;
  registerWorkspace(name, defineWorkspace({ store: { provider: "memory" }, rules: { "/**": { write: true, mediaType: "text/markdown" } } }));
  const workspace = useWorkspace(name, { mode: "write" });
  const adapter = createAdapter(name);
  const context = { authority: "memory", definition: "docs", documentId: "guides/page.md" } as const;
  await workspace.fs.writeFile(context.documentId, "# Original");
  const loaded = await adapter.load(context);
  await workspace.fs.rm(context.documentId);

  await expect(adapter.save(context, { body: "# Edited" }, {
    editors: [], ifDigest: loaded.digest, reason: "idle",
  })).rejects.toMatchObject({ code: "REALTIME_DOCUMENT_CONFLICT" });
  expect(await workspace.fs.exists(context.documentId)).toBe(false);
});

it("opens new documents through the packaged Realtime server without duplicate models", async () => {
  for (const markdown of ["", "# Shared document\n\nA paragraph."]) {
    const document = await packagedCreateYDoc(packagedEditor, { body: markdown });
    try { expect((await packagedReadYDoc(packagedEditor, document)).body).toBe(markdown); }
    finally { document.destroy(); }
  }
});
