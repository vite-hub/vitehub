import { resolve } from "node:path"

import { createRule } from "vite-doctor/extension"
import type { DoctorRule, RuleContext } from "vite-doctor/extension"

import { callArguments, defaultExport, isIdentifier, isNode, isNodeType, isServerFile, isTestFile, moduleSourceVisitors, numberValue, objectProperty, parentOf, resolver, stringValue, unwrap } from "../ast.ts"
import type { AstNode } from "../ast.ts"
import { diagnostics } from "../diagnostics.ts"
import { generatedFile, viteHubPackage } from "./imports.ts"
import { dependsOn } from "./integrations.ts"

// Each built-in that these rules point to: what it is called and where its docs are.

const docs = "https://vitehub.dev/docs"

const builtIns = {
  generate: { name: "`vitehub database generate`", url: `${docs}/database/configure#apply-migrations` },
  migrate: { name: "`vitehub database migrate`", url: `${docs}/database/configure#apply-migrations` },
  migrateOnDeploy: { name: "`database.migrateOnDeploy`", url: `${docs}/database/configure#migrate-when-you-deploy` },
  backup: { name: "`database.migrateOnStart: { backup: true }`", url: `${docs}/database/configure#back-up-sqlite-before-migrations` },
  export: { name: "`vitehub database export`", url: `${docs}/database/configure#export-a-database` },
  forwardAuth: { name: "`forwardAuth()` from `vite-hub/auth/forward`", url: `${docs}/auth/configure#sign-in-through-a-trusted-proxy` },
  chunkParameters: { name: "`chunkParameters()` from `vite-hub/database`", url: `${docs}/database/server-api#stay-under-the-bound-parameter-limit` },
  deploy: { name: "`vitehub deploy`", url: `${docs}/cli/project#check-env-before-a-deploy` },
  setIfAbsent: { name: "`kv.setIfAbsent()` from `vite-hub/kv`", url: `${docs}/kv/server-api#use-it-at-runtime` },
  withIdempotency: { name: "`withIdempotency()` from `vite-hub/database`", url: `${docs}/database/server-api#run-work-once-for-a-key` },
  nuxtTypes: { name: "the ViteHub Nuxt module", url: `${docs}/development/generated-files#include-generated-types` },
} as const

type BuiltIn = typeof builtIns[keyof typeof builtIns]

const see = (...items: BuiltIn[]) => `See ${items.map(item => item.url).filter((url, index, urls) => urls.indexOf(url) === index).join(" and ")}.`

/** True for files of an app that uses `vite-hub`: not ViteHub itself, generated files, or tests. */
function appFile(ctx: RuleContext): boolean {
  if (generatedFile.test(ctx.file.relativePath) || isTestFile(ctx.file.relativePath)) return false
  return !viteHubPackage.test(ctx.project.packageName ?? "") && dependsOn(ctx, "vite-hub")
}

/** The text of a string or template literal, with `${}` placeholders for template expressions. */
function literalText(node: unknown): string | undefined {
  const value = stringValue(node)
  if (value !== undefined) return value
  if (!isNodeType(node, "TemplateLiteral") || !Array.isArray(node.quasis)) return
  // A template element's `value` is `{ raw, cooked }`, which has no `type`.
  return node.quasis.map((quasi) => {
    const value: unknown = isNode(quasi) ? quasi.value : undefined
    const cooked: unknown = value && typeof value === "object" ? Reflect.get(value, "cooked") : undefined
    return typeof cooked === "string" ? cooked : ""
  }).join("${}")
}

/** The source text of a node, to compare two expressions such as storage keys. */
function sourceOf(ctx: RuleContext, node: unknown): string | undefined {
  return isNode(node) && typeof node.start === "number" && typeof node.end === "number" ? ctx.file.text.slice(node.start, node.end) : undefined
}

// vitehub/prefer-built-ins (VHUB0037): code that a ViteHub built-in replaces.

const drizzleConfigFile = /(?:^|\/)drizzle\.config\.[cm]?[jt]s$/
const viteHubDatabaseFolder = /(?:^|\/)databases\//
const migrationsLedgerSql = /\b(?:create\s+table|insert\s+(?:or\s+\w+\s+)?into|select\b[\s\S]*\bfrom|delete\s+from|update)\b[\s\S]*\bd1_migrations\b/i
const vacuumInto = /\bvacuum\s+into\b/i
const proxyIdentityHeaders = [
  /^x-auth-request-[\w-]+$/i,
  /^x-forwarded-(?:user|email|preferred-username|access-token|groups)$/i,
  /^cf-access-(?:jwt-assertion|authenticated-user-email)$/i,
  /^tailscale-user-(?:login|name|profile-pic)$/i,
]
/** D1 binds 100 parameters per statement, and SQLite builds before 3.32 bound 999. */
const parameterLimits = new Set([100, 999, 32766])

function isParameterLimitName(name: string): boolean {
  return /max|limit/i.test(name) && (/bind|variable/i.test(name) || (/param/i.test(name) && /d1|sql|query|statement/i.test(name)))
}

const storageReads = new Set(["get", "getItem", "has", "hasItem"])
const storageWrites = new Set(["set", "setItem"])

/** The receiver, method, and key of `await receiver.method(key, ...)`. */
function awaitedStorageCall(ctx: RuleContext, node: unknown, methods: Set<string>): { receiver: string, key: string, call: AstNode } | undefined {
  const awaited = unwrap(node)
  if (!isNodeType(awaited, "AwaitExpression")) return
  const call = unwrap(awaited.argument)
  if (!isNodeType(call, "CallExpression") || !isNodeType(call.callee, "MemberExpression") || call.callee.computed === true) return
  if (!isIdentifier(call.callee.property) || !methods.has(call.callee.property.name)) return
  const receiver = sourceOf(ctx, call.callee.object)
  const key = sourceOf(ctx, callArguments(call)[0])
  return receiver && key ? { receiver, key, call } : undefined
}

/** True for `return`, `return false`, or `throw`, alone or as the only statement of a block. */
function exits(node: unknown): boolean {
  const statement = isNodeType(node, "BlockStatement") && Array.isArray(node.body) && node.body.length === 1 ? node.body[0] : node
  return isNodeType(statement, "ReturnStatement") || isNodeType(statement, "ThrowStatement")
}

export const preferBuiltIns: DoctorRule = createRule({
  meta: {
    id: "vitehub/prefer-built-ins",
    title: "Use the ViteHub built-in instead of code that does its job",
    category: "correctness",
    severity: "warn",
    requires: { script: true },
  },
  create(ctx) {
    if (!appFile(ctx)) return
    const reported = new Set<string>()
    const report = (entry: string, node: unknown, why: string, fix: string) => {
      if (reported.has(entry)) return
      reported.add(entry)
      ctx.report(diagnostics.VHUB0037({ why, fix }), { range: ctx.range(node) })
    }

    if (drizzleConfigFile.test(ctx.file.relativePath)) {
      const exported = unwrap(defaultExport(ctx)?.value)
      const config = isNodeType(exported, "CallExpression") ? unwrap(callArguments(exported)[0]) : exported
      for (const name of ["out", "schema"]) {
        const property = objectProperty(config, name)
        const value = unwrap(property?.value)
        const paths = isNodeType(value, "ArrayExpression") && Array.isArray(value.elements) ? value.elements.map(stringValue) : [stringValue(value)]
        if (!property || !paths.some(path => path !== undefined && viteHubDatabaseFolder.test(path))) continue
        report("drizzle-config", property, `This Drizzle Kit config reads or writes \`databases/\`, the folder of ViteHub Database Definitions. ViteHub loads every Definition and writes its migrations with ${builtIns.generate.name}, so a second config can drift from the Definitions and write migrations ViteHub does not track.`, `Delete this config and run ${builtIns.generate.name} and ${builtIns.migrate.name}. ${see(builtIns.generate)}`)
        break
      }
    }

    const forwardAuthImported = { value: false }

    function checkText(node: unknown) {
      const text = literalText(node)
      if (text === undefined) return
      if (migrationsLedgerSql.test(text)) {
        report("d1-migrations", node, "This SQL reads or writes `d1_migrations`, the ledger of a hand-written D1 migrator. ViteHub applies migrations to D1 and records them in the same Wrangler table, one request per file and its row.", `Use ${builtIns.migrateOnDeploy.name} for a D1 binding, or ${builtIns.migrate.name} for D1 over HTTP. ${see(builtIns.migrateOnDeploy, builtIns.migrate)}`)
      }
      if (vacuumInto.test(text)) {
        report("vacuum-into", node, "This copies a SQLite database with `VACUUM INTO`. ViteHub backs up each local SQLite file the same way before it applies pending migrations, and keeps the newest copies.", `Set ${builtIns.backup.name}, or run ${builtIns.export.name} for a dump. ${see(builtIns.backup, builtIns.export)}`)
      }
      if (!forwardAuthImported.value && stringValue(node) !== undefined && proxyIdentityHeaders.some(header => header.test(text))) {
        report("proxy-header", node, `This reads \`${text}\`, an identity header that a sign-in proxy such as oauth2-proxy, Cloudflare Access, or Tailscale Serve sends. Anyone who reaches the app without the proxy can send it too. ${builtIns.forwardAuth.name} turns the header into a Better Auth session only after your \`verify\` function proves it.`, `Use ${builtIns.forwardAuth.name} with \`header: "${text}"\` and a \`verify\` function. ${see(builtIns.forwardAuth)}`)
      }
      if (text === "--secrets-file" && /\bwrangler\b/.test(ctx.file.text)) {
        report("secrets-file", node, "This passes a secrets file to `wrangler deploy`. A `.env` file holds more than the Worker needs, and Wrangler's dotenv mode expands `$VAR`. `vitehub deploy` sends only the env that the app declares, as a JSON file with mode 600 that it deletes after the deploy.", `Deploy with ${builtIns.deploy.name}. ${see(builtIns.deploy)}`)
      }
    }

    return {
      ...moduleSourceVisitors((_node, source) => {
        if (/^(?:vite-hub|@vite-hub)\/auth\/forward$/.test(source.specifier)) forwardAuthImported.value = true
      }),
      Literal(node) {
        checkText(node)
      },
      TemplateLiteral(node) {
        checkText(node)
      },
      VariableDeclarator(node) {
        const declaration = parentOf(node)
        if (!isNodeType(declaration, "VariableDeclaration") || declaration.kind !== "const" || !isIdentifier(node.id)) return
        const limit = numberValue(node.init)
        if (limit === undefined || !parameterLimits.has(limit) || !isParameterLimitName(node.id.name)) return
        report("parameter-limit", node, `\`${node.id.name}\` hard-codes the number of bound parameters that one SQL statement takes. ${builtIns.chunkParameters.name} splits values to fit the D1 limit, and counts the columns of a table for multi-row inserts.`, `Use ${builtIns.chunkParameters.name}, for example \`chunkParameters(rows, { per: table })\`. ${see(builtIns.chunkParameters)}`)
      },
      IfStatement(node) {
        const read = awaitedStorageCall(ctx, node.test, storageReads)
        if (!read || !exits(node.consequent) || node.alternate) return
        const block = parentOf(node)
        const body = isNode(block) && Array.isArray(block.body) ? block.body : []
        const after = body.slice(body.indexOf(node) + 1)
        const written = after.some((statement) => {
          if (!isNodeType(statement, "ExpressionStatement")) return false
          const write = awaitedStorageCall(ctx, statement.expression, storageWrites)
          return write?.receiver === read.receiver && write.key === read.key && isNodeType(unwrap(callArguments(write.call)[1]), "Literal")
        })
        if (!written) return
        report("check-then-set", node, `This reads \`${read.key}\` and then writes it, so two requests that arrive together both pass the check. Storage such as Workers KV or per-instance memory cannot make the two steps one.`, `Use ${builtIns.setIfAbsent.name}, which writes the key in one atomic step, or ${builtIns.withIdempotency.name} where the KV driver has no atomic write, such as Cloudflare KV. ${see(builtIns.setIfAbsent, builtIns.withIdempotency)}`)
      },
    }
  },
})

// vitehub/prefer-built-in-commands (VHUB0038): package.json scripts that a ViteHub command replaces.

const scriptCommands: { pattern: RegExp, builtIn: (match: RegExpExecArray, manifest: Record<string, unknown>) => { why: string, fix: string } | undefined }[] = [
  {
    pattern: /\bdrizzle-kit\s+(generate|migrate|up)\b/,
    builtIn: match => ({
      why: `\`drizzle-kit ${match[1]}\` runs Drizzle Kit with its own config. \`vitehub database ${match[1]}\` runs it on every ViteHub Database Definition, with the dialect, aliases, and migrations folder of each.`,
      fix: `Run \`vitehub database ${match[1]}\`. ${see(builtIns.generate)}`,
    }),
  },
  {
    pattern: /\bwrangler\s+d1\s+migrations\s+apply\b[^&|;]*--remote\b/,
    builtIn: () => ({
      why: "This applies D1 migrations in a separate step before the deploy. With `database.migrateOnDeploy`, `vitehub deploy` applies them for each D1 binding and stops when one fails. Without it, `vitehub deploy` stops when the build has a migration that D1 does not list.",
      fix: `Set ${builtIns.migrateOnDeploy.name} and deploy with ${builtIns.deploy.name}. ${see(builtIns.migrateOnDeploy)}`,
    }),
  },
  {
    pattern: /\bwrangler\s+deploy\b[^&|;]*--secrets-file\b/,
    builtIn: () => ({
      why: "This passes a secrets file to `wrangler deploy`. `vitehub deploy` sends only the env that the app declares, as a JSON file with mode 600 that it deletes after the deploy.",
      fix: `Deploy with ${builtIns.deploy.name}. ${see(builtIns.deploy)}`,
    }),
  },
  {
    pattern: /\bvitehub\s+types\s+prepare\b/,
    builtIn: (_match, manifest) => dependencyNames(manifest).has("nuxt")
      ? {
          why: "In a Nuxt app, the ViteHub Nuxt module writes its types during `nuxt prepare`, so `vitehub types prepare` does the same work twice.",
          fix: `Remove \`vitehub types prepare\` and keep \`nuxt prepare\`. ${see(builtIns.nuxtTypes)}`,
        }
      : undefined,
  },
]

const dependencyFields = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]

function dependencyNames(manifest: Record<string, unknown>): Set<string> {
  return new Set(dependencyFields.flatMap((field) => {
    const dependencies = manifest[field]
    return dependencies && typeof dependencies === "object" ? Object.keys(dependencies) : []
  }))
}

/** Offsets of `"name": "command"` inside the `scripts` object of a package.json. */
function scriptOffsets(text: string, name: string): [number, number] | undefined {
  const scripts = /"scripts"\s*:\s*\{/.exec(text)
  if (!scripts) return
  const key = JSON.stringify(name).replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")
  const entry = new RegExp(`${key}\\s*:\\s*"(?:[^"\\\\]|\\\\.)*"`, "g")
  entry.lastIndex = scripts.index + scripts[0].length
  const match = entry.exec(text)
  return match ? [match.index, match.index + match[0].length] : undefined
}

export const preferBuiltInCommands: DoctorRule = createRule({
  meta: {
    id: "vitehub/prefer-built-in-commands",
    title: "Use the ViteHub command instead of a script that does its job",
    category: "correctness",
    severity: "warn",
    execution: "manifest",
  },
  create(ctx) {
    return {
      onProjectStart() {
        const roots = ctx.project.workspacePackages?.map(item => item.root) ?? ["."]
        for (const root of roots) {
          const file = resolve(ctx.project.root, root, "package.json")
          const text = ctx.fs.readText(file)
          if (text === undefined) continue
          let manifest: unknown
          try {
            manifest = JSON.parse(text)
          }
          catch {
            continue
          }
          if (!manifest || typeof manifest !== "object") continue
          const fields = Object.fromEntries(Object.entries(manifest))
          if (typeof fields.name === "string" && viteHubPackage.test(fields.name)) continue
          if (!dependencyNames(fields).has("vite-hub")) continue
          const scripts = fields.scripts
          if (!scripts || typeof scripts !== "object") continue
          for (const [name, command] of Object.entries(scripts)) {
            if (typeof command !== "string") continue
            for (const { pattern, builtIn } of scriptCommands) {
              const match = pattern.exec(command)
              const message = match && builtIn(match, fields)
              if (!message) continue
              const offsets = scriptOffsets(text, name) ?? [0, 0]
              ctx.report(diagnostics.VHUB0038({ why: `The \`${name}\` script: ${message.why}`, fix: message.fix }), {
                file,
                range: ctx.helpers.rangeFromOffsets(file, text, offsets[0], offsets[1]),
              })
            }
          }
        }
      },
    }
  },
})

// vitehub/no-owned-table-writes (VHUB0039): writes to tables that a ViteHub feature owns.

/** ViteHub modules that export the tables of a feature. Auth tables are left out: Better Auth and the app share them. */
const ownedTableModule = /^(?!auth\/)([\w-]+)(?:\/[\w-]+)*\/(?:database|blob-database)(?:\/postgres)?$/
const serverApiPages = new Set(["comments", "content", "env", "forms", "sync", "webhooks"])
const docsFolders: Record<string, string> = { agent: "agents" }
const ownedTableSql = /\b(insert\s+(?:or\s+\w+\s+)?into|replace\s+into|update|delete\s+from)\s+["'`[]?(vitehub_\w+)/i
const drizzleWrites = new Set(["insert", "update", "delete"])
const databaseFolder = /(?:^|\/)server\/databases\//

function featureDocs(feature: string): string {
  const folder = docsFolders[feature] ?? feature
  return serverApiPages.has(folder) ? `${docs}/${folder}/server-api` : `${docs}/${folder}`
}

export const noOwnedTableWrites: DoctorRule = createRule({
  meta: {
    id: "vitehub/no-owned-table-writes",
    title: "Change ViteHub feature tables through the feature",
    category: "correctness",
    severity: "warn",
    requires: { script: true },
  },
  create(ctx) {
    // Request-time code only. Migrations, seeds, and scripts that write migration files move data on purpose.
    if (!appFile(ctx) || !isServerFile(ctx.file.relativePath) || databaseFolder.test(ctx.file.relativePath)) return
    const r = resolver(ctx)
    return {
      CallExpression(node) {
        if (!isNodeType(node.callee, "MemberExpression") || node.callee.computed === true || !isIdentifier(node.callee.property)) return
        const method = node.callee.property.name
        if (!drizzleWrites.has(method)) return
        const table = callArguments(node)[0]
        const reference = r.reference(table)
        const feature = reference && reference.path.length === 0 ? ownedTableModule.exec(reference.module)?.[1] : undefined
        if (!reference || !feature) return
        ctx.report(diagnostics.VHUB0039({
          why: `This calls \`${method}()\` on \`${reference.name}\`, a table that ViteHub ${feature} owns. The write skips the checks that ${feature} runs, such as permissions and counters, and breaks when ViteHub changes the table.`,
          fix: `Use the ${feature} server API. When it has no operation for this write, ask for one in vite-hub/vitehub. See ${featureDocs(feature)}.`,
        }), { range: ctx.range(node) })
      },
      Literal(node) {
        checkSql(node)
      },
      TemplateLiteral(node) {
        checkSql(node)
      },
    }

    function checkSql(node: unknown) {
      const match = ownedTableSql.exec(literalText(node) ?? "")
      if (!match) return
      ctx.report(diagnostics.VHUB0039({
        why: `This SQL changes \`${match[2]}\`, a table that a ViteHub feature owns. The write skips the checks that the feature runs, and breaks when ViteHub changes the table.`,
        fix: "Use the server API of the feature that owns the table. When it has no operation for this write, ask for one in vite-hub/vitehub.",
      }), { range: ctx.range(node) })
    }
  },
})

export const rules: DoctorRule[] = [preferBuiltIns, preferBuiltInCommands, noOwnedTableWrites]
