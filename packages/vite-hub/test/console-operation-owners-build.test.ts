import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { build } from "esbuild"
import { afterEach, describe, expect, it } from "vitest"

import { writeConsoleAppModule } from "../src/console/app-module.ts"
import { transformConsoleOperationFeatures } from "../src/console/operation-features.ts"
import { authConsoleReadOperations } from "../src/console/runtime/auth-operations.ts"

import type { ConsoleSectionId } from "../src/console/runtime/sections.ts"

const owners = {
  agents: { code: "agent/console/", operation: "agents.list" },
  auth: { code: "auth/console/", operation: Object.values(authConsoleReadOperations)[0]! },
  databases: { code: "database/console/", operation: "databases.browse" },
  env: { code: "env/console/", operation: "env.get" },
  logs: { code: "logs/console/", operation: "logs.list" },
  site: { code: "console/runtime/server/site-access-operation.", operation: "site.access" },
  workspaces: { code: "workspace/console/", operation: "workspaces.files" },
} as const

type Owner = keyof typeof owners

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true })
})

async function bundleConsoleApp(on: readonly Owner[]): Promise<{ chunks: Array<{ inputs: string[], text: string }>, generated: string }> {
  const root = await mkdtemp(join(tmpdir(), "vitehub-console-owners-"))
  roots.push(root)
  const file = join(root, "app.mjs")
  const sections = on.filter((owner): owner is Exclude<Owner, "site"> => owner !== "site") satisfies readonly ConsoleSectionId[]
  await writeConsoleAppModule({ file, projectRoot: root, sections, site: on.includes("site"), catalog: { agents: [], content: {} }, blobStores: [], access: { mode: "token" } })
  const result = await build({
    bundle: true,
    entryPoints: [file],
    external: ["#vitehub/*"],
    format: "esm",
    metafile: true,
    outdir: join(root, "server"),
    packages: "external",
    platform: "node",
    splitting: true,
    write: false,
    plugins: [{
      name: "console-operation-features",
      setup(builder) {
        builder.onLoad({ filter: /\.[jt]s$/ }, async ({ path }) => {
          const code = await readFile(path, "utf8")
          return { contents: transformConsoleOperationFeatures(code, sections, false) ?? code, loader: path.endsWith(".ts") ? "ts" : "js" }
        })
      },
    }],
  })
  const outputs = new Map(result.outputFiles.map(output => [output.path, output.text]))
  return {
    chunks: Object.entries(result.metafile.outputs).map(([path, output]) => ({ inputs: Object.keys(output.inputs), text: outputs.get(join(root, path.slice(path.indexOf("server/")))) ?? "" })),
    generated: await readFile(file, "utf8"),
  }
}

describe("the server output of the generated Console app module", () => {
  it.each([
    [[]],
    [["agents"]],
    [["auth"]],
    [["databases"]],
    [["env", "logs"]],
    [["site"]],
    [["workspaces"]],
    [["agents", "auth", "databases", "env", "logs", "site", "workspaces"]],
  ] as Array<[readonly Owner[]]>)("has a Console operation chunk only for the configured primitives %j", { timeout: 60_000 }, async (on) => {
    const { chunks, generated } = await bundleConsoleApp(on)
    for (const [owner, { code, operation }] of Object.entries(owners) as Array<[Owner, typeof owners[Owner]]>) {
      const configured = on.includes(owner)
      const owned = chunks.filter(chunk => chunk.inputs.some(input => input.includes(`dist/${code}`)))
      expect(owned.length > 0, `${owner} chunk`).toBe(configured)
      expect(chunks.some(chunk => chunk.text.includes(JSON.stringify(operation))), `${owner} operation ${operation}`).toBe(configured)
      expect(generated.includes(`/dist/${code}`), `${owner} import`).toBe(configured)
    }
    expect(chunks.filter(chunk => chunk.inputs.some(input => input.includes("dist/blob/console/") || input.includes("dist/content/console/")))).toEqual([])
  })
})
