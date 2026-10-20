import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { hubRealtime, inspectRealtimeDefinitions } from "../src/vite.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vitehub-realtime-inspect-"))
  roots.push(root)
  for (const [file, source] of Object.entries(files)) {
    await mkdir(join(root, file, ".."), { recursive: true })
    await writeFile(join(root, file), source)
  }
  return root
}

describe("Realtime inspection", () => {
  it("describes adapters, codecs, access, persistence, and authority without executing definitions", async () => {
    const root = await project({
      "server/realtime/docs.ts": `import { defineRealtime } from "vite-hub/realtime"
export default defineRealtime({ auth: true, document: { workspace: "docs" }, history: { checkpoint: true } })
`,
      "server/realtime/content.ts": `import { defineRealtime } from "vite-hub/realtime"
import { contentDocument, contentEditor } from "./content-adapter"
throw new Error("inspection must not execute definitions")
export default defineRealtime({
  authorize: ({ mode }) => mode === "read",
  document: contentDocument("pages"),
  editor: contentEditor,
  identify: ({ request }) => null,
  persistence: { debounce: 500 },
})
`,
    })

    const summaries = await inspectRealtimeDefinitions({ authority: "memory", projectRoot: root })
    const fields = Object.fromEntries(summaries.map(summary => [summary.name, Object.fromEntries(summary.fields.map(field => [field.label, field.value]))]))

    expect(fields.docs).toEqual({
      Authority: "memory: one Node process, rooms lost on restart",
      Authorization: "every connection may read and write",
      Document: "Workspace \"docs\" (Markdown file per path)",
      Editor: "built-in Markdown kit",
      History: "history.checkpoint() enabled",
      Identity: "ViteHub Auth session, required",
      Persistence: "idle save after 2000 ms (at most 10000 ms) and when the last client leaves",
    })
    expect(fields.content).toEqual({
      Authority: "memory: one Node process, rooms lost on restart",
      Authorization: "authorize() per document and mode",
      Document: "custom adapter (contentDocument())",
      Editor: "custom codec (contentEditor)",
      History: "none",
      Identity: "identify()",
      Persistence: "idle save after 500 ms (at most 10000 ms) and when the last client leaves",
    })
  })

  it("reports the resolved Durable Object authority through the plugin inspector", async () => {
    const root = await project({
      "server/realtime/docs.ts": `export default { document: { workspace: "docs" }, persistence: false }`,
    })
    const plugin = hubRealtime({ authority: "cloudflare", projectRoot: root })
    const config = { nitro: { preset: "cloudflare-durable" }, root }
    await (plugin.config as (config: object, environment: object) => Promise<void>)(config, { command: "serve", mode: "development" })
    const contributor = typeof plugin.vitehub.inspect === "function" ? await plugin.vitehub.inspect() : plugin.vitehub.inspect
    const [summary] = await contributor!.definitions![0]!.list()

    expect(summary!.fields).toEqual(expect.arrayContaining([
      { label: "Authority", value: "cloudflare: one Durable Object per document, Yjs state in SQLite" },
      { label: "Persistence", value: "explicit saves only" },
    ]))
  })
})
