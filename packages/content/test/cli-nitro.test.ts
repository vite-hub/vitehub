import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { Readable, Writable } from "node:stream"

import { describe, expect, it } from "vitest"
import { createServer } from "vite"

import { runContentCli } from "../src/cli.ts"
import { hubContent } from "../src/vite.ts"

import type { IncomingMessage, ServerResponse } from "node:http"
import type { Connect } from "vite"

function stream() {
  let value = ""
  return {
    output: () => value,
    write(chunk: string | Uint8Array) {
      value += String(chunk)
      return true
    },
  }
}

/** Sends one Fetch API request through the Vite middleware stack without a listening port. */
async function viaMiddlewares(middlewares: Connect.Server, input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init)
  const url = new URL(request.url)
  const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined
  const req = Object.assign(Readable.from(body ? [body] : []), {
    headers: Object.fromEntries(request.headers),
    method: request.method,
    url: `${url.pathname}${url.search}`,
  }) as unknown as IncomingMessage
  req.headers.host = url.host
  return await new Promise<Response>((resolveResponse, reject) => {
    const chunks: Buffer[] = []
    const headers = new Headers()
    const res = Object.assign(new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk))
        callback()
      },
      final(callback) {
        resolveResponse(new Response(Buffer.concat(chunks), { headers, status: res.statusCode }))
        callback()
      },
    }), {
      setHeader(name: string, value: string) {
        headers.set(name, value)
      },
      statusCode: 200,
    })
    middlewares(req, res as unknown as ServerResponse, (error?: unknown) => {
      if (error) reject(error)
      else resolveResponse(new Response("Not found", { status: 404 }))
    })
  })
}

const packages = resolve(import.meta.dirname, "../..")

/** `server/content.ts` of the test app: one collection on a libSQL Blob + Database Store. */
function contentDefinition(root: string): string {
  return `import { readFile } from "node:fs/promises"
import { createClient } from "@libsql/client"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/libsql"
import { z } from "zod"
import { createBlobDatabaseWorkspaceStore, workspaceHistorySchema } from "@vite-hub/workspace/blob-database"
import { registerWorkspace } from "@vite-hub/workspace/test"
import { defineContent, documents } from ${JSON.stringify(join(packages, "content/src/index.ts"))}
import { createBlobStorage } from ${JSON.stringify(join(packages, "blob/src/storage.ts"))}
import { createDriver } from ${JSON.stringify(join(packages, "blob/src/drivers/fs.ts"))}

const database = drizzle(createClient({ url: ${JSON.stringify(`file:${join(root, "history.sqlite")}`)} }), { schema: workspaceHistorySchema })
const migration = await readFile(${JSON.stringify(join(packages, "workspace/test/fixtures/history.sql"))}, "utf8")
for (const statement of migration.split(";").filter(statement => statement.trim())) await database.run(sql.raw(statement))
const blob = createBlobStorage(createDriver({ driver: "fs", base: ${JSON.stringify(join(root, "objects"))} }))
registerWorkspace("site", { store: createBlobDatabaseWorkspaceStore({ blob, database, workspace: "site" }) })

export const content = defineContent({
  workspace: "site",
  collections: { posts: documents({ path: "posts/**/*.md", fields: { title: z.string() } }) },
  logger: false,
})
await content.collection("posts").save("hello", { data: { title: "Hello" }, body: "Hi.\\n" })
`
}

describe("vitehub content against a Vite + Nitro Development Server", () => {
  it("reaches the app's server/content.ts through the Nitro dev environment", async () => {
    // SAFETY: Nitro publishes this Vite plugin at the runtime-resolved `nitro/vite` entry.
    const { nitro }: { nitro: () => unknown } = await import("nitro/vite" as string)
    // Nitro writes its dev worker with relative imports, so the app root stays inside the workspace and resolves packages normally.
    const tmp = resolve(import.meta.dirname, "../.vitest-tmp")
    await mkdir(tmp, { recursive: true })
    const root = await mkdtemp(join(tmp, "content-cli-nitro-"))
    await mkdir(join(root, "server", "routes"), { recursive: true })
    await writeFile(join(root, "package.json"), "{\"name\":\"content-cli-nitro\",\"private\":true,\"type\":\"module\"}\n")
    await writeFile(join(root, "server", "routes", "index.ts"), "export default () => 'ok'\n")
    await writeFile(join(root, "server", "content.ts"), contentDefinition(root))
    const server = await createServer({
      appType: "custom",
      configFile: false,
      logLevel: "silent",
      plugins: [hubContent({ importBase: join(packages, "content/src") }), nitro() as never],
      root,
      server: { middlewareMode: true, ws: false },
    })
    try {
      const fetch = (input: string | URL | Request, init?: RequestInit) => viaMiddlewares(server.middlewares, input, init)
      const run = async (...args: string[]) => {
        const stdout = stream()
        const stderr = stream()
        const code = await runContentCli(args, { cwd: root, env: {}, rootDir: root, stderr, stdout }, { fetch })
        return { code, stderr: stderr.output(), stdout: stdout.output() }
      }

      expect(await run("collections")).toEqual({ code: 0, stderr: "", stdout: "posts  posts/**/*.md\n  Fields: title\n  Documents: 1 (1 draft)\n" })
      expect(await run("status")).toEqual({ code: 0, stderr: "", stdout: "draft  posts/hello\n" })
      expect((await run("diff", "posts", "hello")).stdout).toBe("--- /dev/null\n+++ draft/posts/hello.md\n@@ -0,0 +1,5 @@\n+---\n+title: Hello\n+---\n+\n+Hi.\n")
      const published = await run("publish", "--yes")
      expect(published.stdout).toMatch(/^Published 1 document in revision \S+:\n {2}add {5}posts\/hello\n$/)
      expect(await run("status")).toEqual({ code: 0, stderr: "", stdout: "published  posts/hello\n" })
      expect((await run("revisions", "posts", "hello", "--ref", "published")).stdout).toContain("  publish  Publish 1 Content document\n")
    }
    finally {
      await server.close()
      await rm(root, { force: true, recursive: true })
    }
  }, 120_000)
})
