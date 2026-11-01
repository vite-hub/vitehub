import { createRule } from "vite-doctor/extension"
import type { DoctorRule, RuleContext } from "vite-doctor/extension"

import { moduleSpecifier, vitehubModule } from "../ast.ts"
import { diagnostics } from "../diagnostics.ts"

const generatedFile = /(?:^|\/)\.vitehub\//
const generatedImport = /(?:^|\/)(?:\.vitehub|\.nuxt\/vitehub)(?:\/|$)/
const internalImport = /^(?:vite-hub\/_internal|@vite-hub\/internal|@vite-hub\/[^/]+\/_?internal)(?:\/|$)/
/** The `#vitehub/*` aliases that the import paths reference documents. Packages resolve others for generated code. */
const publicAliases = /^#vitehub\/(?:env\/public|env\/server|auth\/server|schedule\/registry|emails\/.+)$/

export const noInternalImports: DoctorRule = createRule({
  meta: {
    id: "vitehub/no-internal-imports",
    title: "Import ViteHub through its public paths",
    category: "imports",
    severity: "warn",
    requires: { script: true },
  },
  create(ctx) {
    if (generatedFile.test(ctx.file.relativePath)) return
    return {
      ScriptNode(node) {
        const specifier = moduleSpecifier(node)?.specifier
        if (!specifier) return
        // A declaration file never runs, and the docs load generated types such as `.vitehub/queue.d.ts` this way.
        if (generatedImport.test(specifier) && !ctx.file.relativePath.endsWith(".d.ts")) {
          ctx.report(diagnostics.VHUB0001({
            why: `\`${specifier}\` imports a file that ViteHub generates. ViteHub can replace or remove generated files on the next build.`,
            fix: "Import the stable `#vitehub/*` alias or the `vite-hub/*` path that the ViteHub import paths reference lists.",
          }), { range: ctx.range(node) })
        }
        else if (internalImport.test(specifier)) {
          ctx.report(diagnostics.VHUB0001({
            why: `\`${specifier}\` is an internal ViteHub path. Only generated ViteHub code and package implementations use it, and it can change in any release.`,
            fix: "Import the public `vite-hub/*` path for this feature. The ViteHub import paths reference lists each one.",
          }), { range: ctx.range(node) })
        }
        else if (specifier.startsWith("#vitehub/") && !publicAliases.test(specifier)) {
          ctx.report(diagnostics.VHUB0001({
            why: `\`${specifier}\` is a module that ViteHub generates for its own runtime code. Its exports can change in any release.`,
            fix: "Import the public `vite-hub/*` path for this feature. The public aliases are `#vitehub/env/public`, `#vitehub/env/server`, `#vitehub/auth/server`, `#vitehub/emails/<name>`, and `#vitehub/schedule/registry`.",
          }), { range: ctx.range(node) })
        }
      },
    }
  },
})

const serverOnlyAliases = new Set(["#vitehub/env/server", "#vitehub/auth/server"])
/**
 * Modules that load server runtime code: generated registries, `node:*` built-ins, or `process.env`.
 * Names are paths after `vite-hub/` or `@vite-hub/`.
 */
const serverOnlyModules = new Set([
  "agent", "agent/capabilities", "agent/channels", "agent/mcp",
  "blob", "browser", "browser/actions", "channels", "comments", "content",
  "database/drizzle",
  "env", "env/auth", "env/bridge", "env/database", "env/http", "env/provider", "env/seal", "env/secret",
  "forge", "gateways", "kv", "markdown-template/file", "queue", "rate-limit",
  "sandbox", "sandbox/ssh", "sandbox/task",
  "schedule/runtime", "schedule/runtime/kv", "schedule/runtime/process",
  "workflow", "workspace", "workspace/runtime",
])
const clientAppDirs = ["components", "composables", "layouts", "middleware", "pages", "plugins", "stores", "utils"]

function isServerOnly(specifier: string): boolean {
  if (serverOnlyAliases.has(specifier)) return true
  const module = vitehubModule(specifier)
  if (!module) return false
  return serverOnlyModules.has(module) || /(?:^|\/)server(?:\/|$)/.test(module) || /^browser\/(?:controllers|providers)\//.test(module)
}

export function isClientFile(ctx: RuleContext): boolean {
  const path = ctx.file.relativePath
  if (/(?:^|\/)server\//.test(path) || /\.server\.[^/]+$/.test(path)) return false
  if (path.endsWith(".vue")) return true
  return ctx.project.framework === "nuxt" && clientAppDirs.some(dir => ctx.file.inAppDir(dir))
}

export const noServerImportsInClient: DoctorRule = createRule({
  meta: {
    id: "vitehub/no-server-imports-in-client",
    title: "Keep server-only ViteHub imports out of client code",
    category: "security",
    severity: "error",
    requires: { script: true },
  },
  create(ctx) {
    if (!isClientFile(ctx)) return
    return {
      ScriptNode(node) {
        const source = moduleSpecifier(node)
        if (!source || source.typeOnly || !isServerOnly(source.specifier)) return
        ctx.report(diagnostics.VHUB0002({
          why: `\`${source.specifier}\` is server-only, and \`${ctx.file.relativePath}\` runs in the browser. ViteHub does not block this import, so the client bundle can include server code and Server Env values.`,
          fix: "Move this code to a server route under `server/` and call that route from the client. Use `#vitehub/env/public` for values that the browser can read.",
        }), { range: ctx.range(node) })
      },
    }
  },
})

export const rules: DoctorRule[] = [noInternalImports, noServerImportsInClient]
