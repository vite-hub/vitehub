import packageJson from "../../package.json" with { type: "json" }
import { detectNuxtModule } from "../shared/detect.ts"
import { readNuxtConfig } from "../shared/nuxt-config.ts"
import { editPackageJson } from "../shared/package-json.ts"
import { editConfig, moduleName, readHub } from "./config.ts"
import { moveSchema } from "./database.ts"
import { rewriteSources } from "./sources.ts"
import { findNuxtHubModuleFollowUps } from "./modules.ts"
import { findGlobalH3Overrides } from "./overrides.ts"
import { findWranglerFile, planWrangler, readCloudflareResourceOptions } from "./wrangler.ts"

import type { Codemod, CodemodContext, CodemodResult, FileEdit, FollowUp } from "../types.ts"
import type { SchemaMove } from "./database.ts"

/** The lowest Drizzle ORM and Kit that `@vite-hub/database` accepts. */
const drizzleMinimum = "1.0.0-rc.5"

/** The command that runs a package binary, from the install command. */
function runner(installCommand: string): string {
  if (installCommand.startsWith("pnpm")) return "pnpm"
  if (installCommand.startsWith("yarn")) return "yarn"
  if (installCommand.startsWith("bun")) return "bunx"
  return "npx"
}

function dataFollowUps(run: string, input: { database: boolean, d1: boolean, kv: boolean, blob: boolean, cloudflare: boolean, kvBinding: string }): FollowUp[] {
  const followUps: FollowUp[] = []
  if (input.database) {
    followUps.push(
      { message: "Back up the existing database and stop the app. For local SQLite, copy NuxtHub's .data/db/sqlite.db to ViteHub's default location with `mkdir -p .vitehub/data/database && cp .data/db/sqlite.db .vitehub/data/database/sqlite.db`, together with its -wal and -shm files if they exist." },
      { message: `Create the migration baseline with \`${run} vitehub database generate --name baseline\`. It writes server/databases/default/migrations/. Do not copy NuxtHub's server/db/migrations/ there.` },
      { message: "Compare the baseline SQL with the existing tables, columns, indexes, and constraints. When they match, add IF NOT EXISTS to each CREATE statement in the baseline folder's migration.sql, for example `CREATE TABLE IF NOT EXISTS`. The baseline then changes nothing in the existing database and creates the schema in a new one. Keep the folder name and snapshot.json." },
      input.d1
        ? { message: `Run \`${run} nuxt build\`, then record the baseline on D1 with \`${run} wrangler d1 migrations apply <database-name> --remote --config .output/server/wrangler.json\`. Check first with \`migrations list\` that only the baseline is pending. For the local SQLite copy, run \`${run} vitehub database migrate\`.` }
        : { message: `Record the baseline with \`${run} vitehub database migrate\`. Run it a second time to check that it applies nothing.` },
    )
  }
  if (input.kv) {
    const base = input.cloudflare ? `.vitehub/data/kv-cloudflare/${input.kvBinding}` : ".vitehub/data/kv"
    // Quote the path because a configured binding may contain shell metacharacters.
    const path = `'${base.replaceAll("'", "'\\''")}'`
    followUps.push({ message: `Copy the local KV data for ${input.cloudflare ? "Node development without a Cloudflare binding" : "the Node fs-lite driver"}: \`mkdir -p ${path} && cp -R .data/kv/. ${path}/\`.${input.cloudflare ? " Binding-backed development (for example workerd) reads the binding instead; import the keys into that development namespace with Wrangler. Repeat the copy if you change vitehub.kv.binding." : ""}` })
  }
  if (input.blob) {
    followUps.push({ message: `ViteHub stores Blob metadata in another format, so copy each local blob through the API. With the dev server running, run \`${run} vitehub blob put <pathname> .data/blob/<pathname> --content-type <type>\` for each file. Custom metadata is not copied.` })
  }
  return followUps
}

async function migrate({ cwd }: CodemodContext): Promise<CodemodResult> {
  const config = await readNuxtConfig(cwd)
  const plan = readHub(config)
  const { features } = plan
  const wranglerFile = findWranglerFile(cwd)
  const configResult = editConfig(config, plan, wranglerFile, await readCloudflareResourceOptions(cwd, wranglerFile, plan.bindings))
  const cloudflare = configResult.host === "cloudflare"
  const wrangler = await planWrangler(cwd, wranglerFile, features, cloudflare, plan.bindings, configResult.written)

  let schema: SchemaMove | undefined
  if (features.database) schema = await moveSchema(cwd, features.database)
  const skip = new Set([config.fileName, ...(schema?.moved.values() ?? [])])
  const sources = await rewriteSources({ cwd, features, schema, skip })

  const packageResult = await editPackageJson(cwd, packageJson.version, {
    remove: [moduleName],
    add: features.database ? ["vite-hub", "@vite-hub/database"] : ["vite-hub"],
    atLeast: features.database ? { "drizzle-orm": drizzleMinimum, "drizzle-kit": drizzleMinimum } : undefined,
  })
  const run = runner(packageResult.installCommand)

  const edits: FileEdit[] = [{ path: config.fileName, before: config.code, after: configResult.code }]
  if (packageResult.edit) edits.push(packageResult.edit)
  if (wrangler.edit) edits.push(wrangler.edit)
  edits.push(...(schema?.edits ?? []), ...sources.edits)

  const enabled = [features.database && "database", features.kv && "kv", features.blob && "blob", features.cache && "cache"].filter(Boolean)
  const notes = [
    "vite-hub/nuxt auto-imports kv, blob, db, and schema in server code for each enabled feature, as NuxtHub did.",
    "Local data stays in .data/. ViteHub reads .vitehub/data/. The follow-ups list the commands that copy it.",
  ]
  if (features.database) notes.push("NuxtHub's server/db/migrations/ stays in place for reference. ViteHub writes new migrations to server/databases/default/migrations/ and does not apply them during dev or build. Delete the old folder after the baseline.")
  if (features.cache) notes.push("Cached handlers come from Nitro and use the cache store of cache: true. In Nitro 3, import defineCachedHandler() (formerly cachedEventHandler()) and defineCachedFunction() from nitro/cache.")
  const installed = features.database ? "vite-hub and @vite-hub/database" : "vite-hub"
  return {
    summary: `moved ${enabled.length ? enabled.join(", ") : "no features"} from hub to vitehub${configResult.host ? ` with host "${configResult.host}"` : ""}, rewrote ${sources.imports} import${sources.imports === 1 ? "" : "s"} and ${sources.calls} KV and Blob call${sources.calls === 1 ? "" : "s"}${schema?.moved.size ? `, and moved the schema to server/databases/default/` : ""}.`,
    edits,
    followUps: [...configResult.followUps, ...await findGlobalH3Overrides(cwd), ...await findNuxtHubModuleFollowUps(cwd, config), ...wrangler.followUps, ...(schema?.followUps ?? []), ...sources.followUps, ...dataFollowUps(run, { database: Boolean(features.database), d1: wrangler.d1, kv: features.kv, blob: features.blob, cloudflare, kvBinding: configResult.written.kv?.binding ?? "KV" })],
    notes,
    nextSteps: [
      `Run \`${packageResult.installCommand}\` to install ${installed} and remove ${moduleName}.`,
      "Run `npx nuxi prepare`, then type-check the app.",
      `Run \`${run} nuxt build\` and \`${run} vitehub inspect output --json\` to check the resources and bindings.`,
    ],
  }
}

export const nuxthub: Codemod = {
  name: "nuxthub",
  description: "Move a Nuxt app from NuxtHub 0.10 (@nuxthub/core) to ViteHub KV, Blob, Database, and cache through vite-hub/nuxt.",
  usage: "[dir]",
  detect: ({ cwd }) => detectNuxtModule(cwd, moduleName, ["hub"]),
  run: migrate,
}
