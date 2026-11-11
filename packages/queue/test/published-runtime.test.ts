import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { build } from "vite"
import { describe, expect, it } from "vitest"

const distEntry = new URL("../dist/index.js", import.meta.url)
const queue = await import(distEntry.href)
const resolvePackageImport = createRequire(import.meta.url).resolve

describe("published Queue error runtime", () => {
  it("does not publish a package-specific error constructor", () => {
    expect(queue).not.toHaveProperty("QueueError")
  })

  it("keeps the Cloudflare worker helper off the public root", () => {
    expect(queue).not.toHaveProperty("createQueueCloudflareWorker")
  })
})

describe("published Queue internal runtime", () => {
  const internalRuntimeFiles = ["cloudflare-vite", "postgres-client", "state", "worker-client"]

  it.each(internalRuntimeFiles)("builds the internal runtime file %s that generated code imports by path", async (file) => {
    await expect(import(new URL(`../dist/internal/runtime/${file}.js`, import.meta.url).href))
      .resolves.toBeTypeOf("object")
  })

  it.each(internalRuntimeFiles)("does not export the internal runtime file %s", (file) => {
    expect(() => resolvePackageImport(`@vite-hub/queue/internal/runtime/${file}`)).toThrow(/Package subpath/)
    expect(() => resolvePackageImport(`@vite-hub/queue/runtime/${file}`)).toThrow(/Package subpath/)
  })

  it("keeps the supported hosted adapter public", () => {
    expect(resolvePackageImport("@vite-hub/queue/runtime/hosted"))
      .toBe(fileURLToPath(new URL("../dist/runtime/hosted.js", import.meta.url)))
  })
})

describe("published Queue provider isolation", () => {
  it.each(["sendQueue", "createQueueClient"])("bundles %s for Cloudflare without resolving Postgres", async (name) => {
    const result = await build({
      configFile: false,
      logLevel: "silent",
      ssr: { noExternal: true, resolve: { conditions: ["workerd", "worker", "browser"] } },
      plugins: [{
        name: "no-postgres",
        enforce: "pre",
        resolveId(source) {
          if (source.includes("postgres")) {
            throw new Error(`Cloudflare must not resolve ${source}`)
          }
          if (source === "virtual:queue-consumer") return "\0queue-consumer"
        },
        load(id) {
          if (id === "\0queue-consumer") return `export { ${name} } from ${JSON.stringify(fileURLToPath(distEntry))}`
        },
      }],
      build: {
        write: false,
        ssr: true,
        rollupOptions: { input: "virtual:queue-consumer", preserveEntrySignatures: "strict", external: [/^@vercel\//] },
      },
    })
    const outputs = Array.isArray(result) ? result : [result]
    const modules = outputs.flatMap(output => "output" in output ? output.output.flatMap(chunk => chunk.type === "chunk"
      ? [...Object.keys(chunk.modules), ...chunk.imports, ...chunk.dynamicImports]
      : []) : [])
    expect(modules.filter(id => id.includes("postgres"))).toEqual([])
  })

  it("creates a standalone Postgres producer from the published root", async () => {
    await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", `
      const { createQueueClient } = await import(${JSON.stringify(distEntry.href)});
      const client = await createQueueClient({ provider: "postgres", queue: "jobs" });
      if (client.provider !== "postgres") throw new Error("Wrong provider");
      await client.native.close();
    `], { env: { ...process.env, QUEUE_POSTGRES_URL: "postgres://localhost/queue" } })
  })

  it("runs a bundled Postgres producer outside the source installation", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "queue-node-output-"))
    try {
      await build({
        configFile: false,
        logLevel: "silent",
        ssr: { noExternal: true },
        plugins: [{
          name: "queue-node-producer",
          resolveId(source) {
            if (source === "virtual:queue-producer") return "\0queue-producer"
          },
          load(id) {
            if (id !== "\0queue-producer") return
            return `
              import { createQueueClient } from ${JSON.stringify(fileURLToPath(distEntry))};
              const client = await createQueueClient({ provider: "postgres", queue: "jobs" });
              if (client.provider !== "postgres") throw new Error("Wrong provider");
              await client.native.close();
            `
          },
        }],
        build: {
          outDir: outputDir,
          ssr: true,
          rollupOptions: {
            input: "virtual:queue-producer",
            external: [/^@vercel\//],
            output: { entryFileNames: "producer.mjs" },
          },
        },
      })
      await promisify(execFile)(process.execPath, [join(outputDir, "producer.mjs")], {
        cwd: outputDir,
        env: { ...process.env, QUEUE_POSTGRES_URL: "postgres://localhost/queue" },
      })
    }
    finally {
      await rm(outputDir, { force: true, recursive: true })
    }
  })
})
