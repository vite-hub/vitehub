import { createRule } from "vite-doctor/extension"
import type { DoctorRule, RuleContext } from "vite-doctor/extension"

import { callArguments, defaultExport, isIdentifier, isNode, isNodeType, moduleSpecifier, numberValue, objectProperties, objectProperty, objectValue, propertyName, resolver, semanticParent, stringValue, unwrap, vitehubModule } from "../ast.ts"
import type { AstNode, Resolver } from "../ast.ts"
import { diagnostics } from "../diagnostics.ts"

// Local helpers.

const dependencyFields = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]

/** True when the project `package.json` lists `name` in any dependency field. */
function dependsOn(ctx: RuleContext, name: string): boolean {
  const manifest: unknown = ctx.getJson("package.json")
  if (!manifest || typeof manifest !== "object") return false
  return dependencyFields.some((field) => {
    const dependencies: unknown = Reflect.get(manifest, field)
    return Boolean(dependencies && typeof dependencies === "object" && Reflect.has(dependencies, name))
  })
}

function programBody(ctx: RuleContext): unknown[] {
  const program = ctx.file.scriptAst
  return isNode(program) && Array.isArray(program.body) ? program.body : []
}

/** Import declarations at the top of the file, with the imported name for each local binding. */
function importsOf(ctx: RuleContext): { source: string, node: AstNode, specifiers: { imported: string, local: string, typeOnly: boolean, node: AstNode }[], typeOnly: boolean }[] {
  return programBody(ctx).flatMap((statement) => {
    if (!isNodeType(statement, "ImportDeclaration") || !isNode(statement.source) || typeof statement.source.value !== "string") return []
    const specifiers = (Array.isArray(statement.specifiers) ? statement.specifiers : []).flatMap((specifier) => {
      if (!isNode(specifier) || !isIdentifier(specifier.local)) return []
      const imported = specifier.type === "ImportDefaultSpecifier" ? "default"
        : specifier.type === "ImportNamespaceSpecifier" ? "*"
          : isIdentifier(specifier.imported) ? specifier.imported.name : stringValue(specifier.imported) ?? specifier.local.name
      return [{ imported, local: specifier.local.name, typeOnly: specifier.importKind === "type", node: specifier }]
    })
    return [{ source: statement.source.value, node: statement, specifiers, typeOnly: statement.importKind === "type" }]
  })
}

/** The ViteHub export that a call or `new` expression calls, when it is `name` from one of `modules`. */
function calls(r: Resolver, node: unknown, modules: readonly string[], name: string): boolean {
  const reference = r.callee(node)
  return Boolean(reference && reference.path.length === 0 && modules.includes(reference.module) && reference.name === name)
}

/** True when `node` calls `vitehub()` imported from the `vite-hub` root. */
function isViteHubPluginCall(r: Resolver, node: unknown): boolean {
  const target = unwrap(node)
  if (!isNodeType(target, "CallExpression")) return false
  const origin = r.binding(target.callee)?.origin
  return origin?.source === "vite-hub" && origin.name === "vitehub"
}

const nuxtConfigFile = /(?:^|\/)nuxt\.config\.[cm]?[jt]s$/
const viteConfigFile = /(?:^|\/)vite\.config\.[cm]?[jt]s$/

/** The object literal that a config file exports, through `defineNuxtConfig()` or `defineConfig()`. */
function configObject(ctx: RuleContext): AstNode | undefined {
  const exported = unwrap(defaultExport(ctx)?.value)
  const value = isNodeType(exported, "CallExpression") ? unwrap(callArguments(exported)[0]) : exported
  return isNodeType(value, "ObjectExpression") ? value : undefined
}

/** The entries of `modules` in a Nuxt config, with the name and inline options of each. */
function nuxtModules(config: AstNode): { name: string, options?: unknown, node: unknown }[] {
  const modules = unwrap(objectValue(config, "modules"))
  if (!isNodeType(modules, "ArrayExpression") || !Array.isArray(modules.elements)) return []
  return modules.elements.flatMap((element) => {
    const name = stringValue(element)
    if (name) return [{ name, node: element }]
    const entry = unwrap(element)
    if (!isNodeType(entry, "ArrayExpression") || !Array.isArray(entry.elements)) return []
    const tupleName = stringValue(entry.elements[0])
    return tupleName ? [{ name: tupleName, options: entry.elements[1], node: element }] : []
  })
}

function arrayElements(node: unknown): unknown[] {
  const target = unwrap(node)
  return isNodeType(target, "ArrayExpression") && Array.isArray(target.elements) ? target.elements : []
}

/** A property value that is present and is not the literal `undefined`. */
function hasValue(object: unknown, name: string): boolean {
  const property = objectProperty(object, name)
  return Boolean(property && !isIdentifier(unwrap(property.value), "undefined"))
}

// VHUB0024

const caretExtension = "@tiptap/extension-collaboration-caret"

export const realtimeCarets: DoctorRule = createRule({
  meta: {
    id: "vitehub/realtime-carets",
    title: "Use the Realtime carets option instead of CollaborationCaret",
    category: "correctness",
    severity: "warn",
    requires: { script: true },
  },
  create(ctx) {
    // Only an editor that ViteHub Realtime syncs is affected, so the rule checks files that import Realtime.
    const usesRealtime = importsOf(ctx).some(declaration => vitehubModule(declaration.source)?.startsWith("realtime"))
    if (!usesRealtime) return
    return {
      ScriptNode(node) {
        const source = moduleSpecifier(node)
        if (!source || source.typeOnly || source.specifier !== caretExtension) return
        ctx.report(diagnostics.VHUB0024({
          why: `\`${caretExtension}\` has its own copy of y-tiptap. It cannot find the sync plugin that ViteHub Realtime installs, so it draws no carets.`,
          fix: "Remove the CollaborationCaret extension. `realtime.extensions` already draws carets. To change their markup, pass `carets: { render, selectionRender }` to `useRealtimeTiptap()`.",
        }), { range: ctx.range(node) })
      },
    }
  },
})

// VHUB0025

const persistenceDefaults = { debounce: 2_000, maxWait: 10_000 }

export const realtimePersistence: DoctorRule = createRule({
  meta: {
    id: "vitehub/realtime-persistence",
    title: "Give Realtime persistence valid timings",
    category: "correctness",
    severity: "error",
    requires: { script: true },
  },
  create(ctx) {
    const r = resolver(ctx)
    return {
      ScriptNode(node) {
        if (!isNodeType(node, "CallExpression") || !calls(r, node, ["realtime"], "defineRealtime")) return
        const persistence = unwrap(objectValue(callArguments(node)[0], "persistence"))
        if (!isNodeType(persistence, "ObjectExpression") || objectProperties(persistence).some(property => property.type === "SpreadElement")) return
        const timings: Partial<Record<"debounce" | "maxWait", number>> = {}
        for (const name of ["debounce", "maxWait"] as const) {
          const property = objectProperty(persistence, name)
          if (!property) {
            timings[name] = persistenceDefaults[name]
            continue
          }
          const value = numberValue(property.value)
          const literal = unwrap(property.value)
          if (value !== undefined && Number.isFinite(value) && value >= 0) {
            timings[name] = value
          }
          else if (value !== undefined || isNodeType(literal, "Literal") || isNodeType(literal, "TemplateLiteral")) {
            ctx.report(diagnostics.VHUB0025({
              why: `\`persistence.${name}\` must be a number of milliseconds that is 0 or more. ViteHub Realtime throws \`REALTIME_INVALID_PERSISTENCE\` when the first room opens.`,
              fix: `Set \`${name}\` to milliseconds, for example \`${name}: ${persistenceDefaults[name]}\`.`,
            }), { range: ctx.range(property) })
          }
        }
        if (timings.debounce !== undefined && timings.maxWait !== undefined && timings.maxWait < timings.debounce) {
          ctx.report(diagnostics.VHUB0025({
            why: `\`persistence.maxWait\` (${timings.maxWait} ms) is less than \`persistence.debounce\` (${timings.debounce} ms). ViteHub Realtime throws \`REALTIME_INVALID_PERSISTENCE\` when the first room opens. Unset values use the defaults: debounce ${persistenceDefaults.debounce} ms, maxWait ${persistenceDefaults.maxWait} ms.`,
            fix: "Make `maxWait` equal to or greater than `debounce`.",
          }), { range: ctx.range(persistence) })
        }
      },
    }
  },
})

// VHUB0026

const forgeClasses = new Set(["BranchMovedError", "ForgeApiError", "ForgeTimeoutError", "MergeBlockedError", "NotFoundError", "RateLimitedError"])

export const forgeErrorImports: DoctorRule = createRule({
  meta: {
    id: "vitehub/forge-error-imports",
    title: "Import Forge error classes from @vite-hub/forge",
    category: "correctness",
    severity: "warn",
    requires: { script: true },
  },
  create(ctx) {
    if (!dependsOn(ctx, "@vite-hub/forge")) return
    return {
      ScriptNode(node) {
        if (!isNodeType(node, "ImportDeclaration") || node.importKind === "type") return
        if (!isNode(node.source) || node.source.value !== "forges") return
        const names = (Array.isArray(node.specifiers) ? node.specifiers : []).flatMap(specifier =>
          isNode(specifier) && specifier.importKind !== "type" && isIdentifier(specifier.imported) && forgeClasses.has(specifier.imported.name) ? [specifier.imported.name] : [])
        if (!names.length) return
        ctx.report(diagnostics.VHUB0026({
          why: `\`${names.join("`, `")}\` from \`forges\` is a different class from the one that \`@vite-hub/forge\` bundles. \`forgeProvider()\` throws the bundled classes, so \`instanceof\` checks against this import are always false.`,
          fix: `Import \`${names.join("`, `")}\` from \`@vite-hub/forge\`.`,
        }), { range: ctx.range(node) })
      },
    }
  },
})

// VHUB0027

const runtimeNames = new Set(["crabbox", "trusted-host", "vercel"])
const runtimeKinds = new Set(["cloudflare", "crabbox", "trusted-host", "vercel"])

function checkSandboxDefinition(ctx: RuleContext, definition: unknown) {
  const target = unwrap(definition)
  if (!isNodeType(target, "ObjectExpression") || objectProperties(target).some(property => property.type === "SpreadElement")) return
  const runtimeProperty = objectProperty(target, "runtime")
  const runtime = unwrap(runtimeProperty?.value)
  const runtimeName = stringValue(runtime)
  const kind = isNodeType(runtime, "ObjectExpression") ? stringValue(objectValue(runtime, "kind")) : undefined
  if (runtimeProperty && runtimeName !== undefined && !runtimeNames.has(runtimeName)) {
    ctx.report(diagnostics.VHUB0027({
      why: runtimeName === "cloudflare"
        ? "`runtime: \"cloudflare\"` is not a valid Sandbox runtime. Cloudflare needs its Durable Objects namespace, so it has only a tagged form. `resolveSandbox()` throws `SANDBOX_R0031` on each call."
        : `\`runtime: "${runtimeName}"\` is not a Sandbox runtime. \`resolveSandbox()\` throws \`SANDBOX_R0031\` on each call.`,
      fix: runtimeName === "cloudflare"
        ? "Use `runtime: { kind: \"cloudflare\", namespace: env.SANDBOX }`."
        : "Use `\"crabbox\"`, `\"trusted-host\"`, `\"vercel\"`, a tagged configuration such as `{ kind: \"cloudflare\", namespace }`, or a custom runtime object.",
    }), { range: ctx.range(runtimeProperty) })
  }
  if (kind !== undefined && !runtimeKinds.has(kind)) {
    ctx.report(diagnostics.VHUB0027({
      why: `\`kind: "${kind}"\` is not a Sandbox runtime kind. \`resolveSandbox()\` throws \`SANDBOX_R0033\` on each call.`,
      fix: "Use `kind: \"crabbox\"`, `\"trusted-host\"`, `\"cloudflare\"`, or `\"vercel\"`.",
    }), { range: ctx.range(runtime) })
  }
  const cwd = hasValue(target, "cwd")
  const checkout = hasValue(target, "checkout")
  if (cwd && checkout) {
    ctx.report(diagnostics.VHUB0027({
      why: "A Sandbox cannot have both `cwd` and `checkout`. `resolveSandbox()` throws `SANDBOX_R0035` on each call.",
      fix: "Use `cwd` for a directory that the caller owns, or `checkout` for a disposable Git checkout. Remove the other.",
    }), { range: ctx.range(target) })
  }
  if ((runtimeName === "crabbox" || kind === "crabbox") && !cwd && !checkout) {
    ctx.report(diagnostics.VHUB0027({
      why: "The `crabbox` runtime needs a working directory. It throws `SANDBOX_R0091` when the Sandbox opens.",
      fix: "Add `cwd` or `checkout` to the Sandbox definition.",
    }), { range: ctx.range(target) })
  }
}

export const sandboxRuntimeOptions: DoctorRule = createRule({
  meta: {
    id: "vitehub/sandbox-runtime-options",
    title: "Give Sandbox definitions a valid runtime",
    category: "correctness",
    severity: "error",
    requires: { script: true },
  },
  create(ctx) {
    const r = resolver(ctx)
    return {
      ScriptNode(node) {
        if (!isNodeType(node, "CallExpression")) return
        if (calls(r, node, ["sandbox"], "resolveSandbox")) checkSandboxDefinition(ctx, callArguments(node)[0])
        else if (calls(r, node, ["agent"], "defineAgent")) checkSandboxDefinition(ctx, objectValue(callArguments(node)[0], "sandbox"))
      },
    }
  },
})

// VHUB0028

export const defineAgentFromViteHub: DoctorRule = createRule({
  meta: {
    id: "vitehub/define-agent-from-vite-hub",
    title: "Import defineAgent from vite-hub/agent",
    category: "correctness",
    severity: "warn",
    requires: { script: true },
  },
  create(ctx) {
    if (!dependsOn(ctx, "vite-hub")) return
    return {
      ScriptNode(node) {
        if (!isNodeType(node, "ImportDeclaration") || node.importKind === "type") return
        if (!isNode(node.source) || node.source.value !== "@vite-hub/agent") return
        const imports = (Array.isArray(node.specifiers) ? node.specifiers : []).some(specifier =>
          isNode(specifier) && specifier.importKind !== "type" && isIdentifier(specifier.imported, "defineAgent"))
        if (!imports) return
        ctx.report(diagnostics.VHUB0028({
          why: "This app uses `vite-hub`, but imports `defineAgent` from the owner package `@vite-hub/agent`. That version does not apply the app-wide `agent.invocations` journal or the Console journal, so Invocations of this Agent are not recorded. A string `invocations` setting such as `\"database\"` also fails when the module loads.",
          fix: "Import `defineAgent` from `vite-hub/agent`.",
        }), { range: ctx.range(node) })
      },
    }
  },
})

// VHUB0029

export const rateLimitCapabilityLimiter: DoctorRule = createRule({
  meta: {
    id: "vitehub/rate-limit-capability-limiter",
    title: "Give the rateLimit Capability a limiter",
    category: "correctness",
    severity: "error",
    requires: { script: true },
  },
  create(ctx) {
    const r = resolver(ctx)
    return {
      ScriptNode(node) {
        if (!isNodeType(node, "CallExpression") || !calls(r, node, ["agent/capabilities"], "rateLimit")) return
        const options = unwrap(callArguments(node)[0])
        if (!isNodeType(options, "ObjectExpression") || objectProperties(options).some(property => property.type === "SpreadElement")) return
        if (objectProperty(options, "limiter")) return
        const inline = ["limit", "window", "store"].filter(name => objectProperty(options, name))
        ctx.report(diagnostics.VHUB0029({
          why: inline.length
            ? `\`rateLimit()\` no longer accepts the inline \`${inline.join("`, `")}\` options. Without \`limiter\`, the Capability throws \`AGENT_R0162\` on the first Invocation.`
            : "`rateLimit()` needs a `limiter`. Without it, the Capability throws `AGENT_R0162` on the first Invocation.",
          fix: "Pass a Rate Limiter: `rateLimit({ limiter: createRateLimiter({ driver: memoryRateLimitDriver(), limit: 20, window: \"1m\" }) })`, with `createRateLimiter` from `@vite-hub/rate-limit` and `memoryRateLimitDriver` from `@vite-hub/rate-limit/drivers/memory`.",
        }), { range: ctx.range(node) })
      },
    }
  },
})

// VHUB0030

export const noViteHubPluginInNuxt: DoctorRule = createRule({
  meta: {
    id: "vitehub/no-vitehub-plugin-in-nuxt",
    title: "Configure ViteHub in Nuxt through the module only",
    category: "correctness",
    severity: "warn",
    requires: { script: true },
  },
  create(ctx) {
    if (!nuxtConfigFile.test(ctx.file.relativePath)) return
    const config = configObject(ctx)
    if (!config || !nuxtModules(config).some(entry => entry.name === "vite-hub/nuxt")) return
    const r = resolver(ctx)
    for (const plugin of arrayElements(objectValue(objectValue(config, "vite"), "plugins"))) {
      if (!isViteHubPluginCall(r, plugin)) continue
      ctx.report(diagnostics.VHUB0030({
        why: "`vite-hub/nuxt` installs the `vitehub()` plugins itself. It keeps a plugin from `vite.plugins` that has the same name in place of its own, so the options of this `vitehub()` call silently replace the module options.",
        fix: "Remove `vitehub()` from `vite.plugins`. Put its options in the `vitehub` key of `nuxt.config.ts`.",
      }), { range: ctx.range(plugin) })
    }
  },
})

// VHUB0031

function checkViteHubOptions(ctx: RuleContext, options: unknown, host: "nuxt" | "vite", where: string) {
  const target = unwrap(options)
  if (!isNodeType(target, "ObjectExpression")) return
  for (const property of objectProperties(target)) {
    const name = propertyName(property)
    const value = unwrap(property.value)
    const isObject = isNodeType(value, "ObjectExpression")
    let report: { why: string, fix: string } | undefined
    if (name === "sandbox") {
      report = {
        why: "`sandbox` is not a ViteHub option. It was renamed to `sandboxTask`, so this key does nothing.",
        fix: "Rename `sandbox` to `sandboxTask: true`.",
      }
    }
    else if (name === "devtools") {
      report = {
        why: "The ViteHub `devtools` option was removed with the browser DevTools, so this key does nothing.",
        fix: "Remove `devtools`. Use the ViteHub Console with `console: true`.",
      }
    }
    else if (name === "sandboxTask" && isObject) {
      report = {
        why: "`sandboxTask` takes only `true` or `false`. ViteHub turns Sandbox Tasks on only for `true`, so an object silently turns them off. The preset selects the provider.",
        fix: "Set `sandboxTask: true`.",
      }
    }
    else if (name === "queue" && isObject) {
      report = {
        why: "`queue` takes only `true` or `false`. ViteHub ignores the fields of this object, because the preset selects the Queue provider.",
        fix: "Set `queue: true`, and choose the provider with `preset`.",
      }
    }
    else if (name === "env" && host === "vite" && isObject) {
      const sections = ["server", "public", "define"].filter(section => objectProperty(value, section))
      if (sections.length) {
        report = {
          why: `\`vitehub({ env })\` takes Env integration options only. ViteHub ignores \`env.${sections.join("`, `env.")}\` here, so these declarations do not exist at runtime.`,
          fix: "Move `server`, `public`, and `define` to the top-level `env` key of the Vite config: `defineConfig({ env: { server: { ... } }, plugins: [vitehub()] })`.",
        }
      }
    }
    else if (name === "connections" && host === "nuxt" && !(isNodeType(value, "Literal") && value.value === false)) {
      report = {
        why: "The Nuxt module does not support `connections` yet. `nuxt build` fails with `VITE_HUB_B0012`. Without `database`, `nuxt dev` also fails with `VITE_HUB_R0124`.",
        fix: "Remove `connections` from the Nuxt config, or use the `vitehub()` Vite plugin for Connections.",
      }
    }
    if (report) ctx.report(diagnostics.VHUB0031({ why: `In ${where}: ${report.why}`, fix: report.fix }), { range: ctx.range(property) })
  }
}

export const validViteHubOptions: DoctorRule = createRule({
  meta: {
    id: "vitehub/valid-vitehub-options",
    title: "Use ViteHub options that take effect",
    category: "correctness",
    severity: "warn",
    requires: { script: true },
  },
  create(ctx) {
    if (nuxtConfigFile.test(ctx.file.relativePath)) {
      const config = configObject(ctx)
      if (!config) return
      const module = nuxtModules(config).find(entry => entry.name === "vite-hub/nuxt")
      if (!module) return
      checkViteHubOptions(ctx, objectValue(config, "vitehub"), "nuxt", "the `vitehub` key")
      checkViteHubOptions(ctx, module.options, "nuxt", "the inline `vite-hub/nuxt` options")
      return
    }
    if (!viteConfigFile.test(ctx.file.relativePath)) return
    const r = resolver(ctx)
    return {
      ScriptNode(node) {
        if (isNodeType(node, "CallExpression") && isViteHubPluginCall(r, node)) checkViteHubOptions(ctx, callArguments(node)[0], "vite", "`vitehub()`")
      },
    }
  },
})

// VHUB0032

const nuxtHubImport = /^(?:hub:(?:db|kv|blob)|@nuxthub\/.+)$/

export const noNuxtHubLeftovers: DoctorRule = createRule({
  meta: {
    id: "vitehub/no-nuxthub-leftovers",
    title: "Finish the move from NuxtHub",
    category: "correctness",
    severity: "warn",
    requires: { script: true },
  },
  create(ctx) {
    const config = nuxtConfigFile.test(ctx.file.relativePath) ? configObject(ctx) : undefined
    const modules = config ? nuxtModules(config) : []
    const usesViteHub = dependsOn(ctx, "vite-hub") || modules.some(entry => entry.name === "vite-hub/nuxt")
    if (!usesViteHub) return
    if (config) {
      for (const entry of modules) {
        if (entry.name !== "@nuxthub/core") continue
        ctx.report(diagnostics.VHUB0032({
          why: "The Nuxt config still installs `@nuxthub/core`. NuxtHub and ViteHub both register `kv`, `blob`, and database helpers, so the app can call the wrong one.",
          fix: "Remove `@nuxthub/core` from `modules` and from `package.json`. Use `vite-hub/nuxt`.",
        }), { range: ctx.range(entry.node) })
      }
      const hub = objectProperty(config, "hub")
      if (hub) {
        ctx.report(diagnostics.VHUB0032({
          why: "`vite-hub/nuxt` does not read the NuxtHub `hub` key, so these features stay off.",
          fix: "Rename `hub` to `vitehub` and add a `preset`. For example, `hub: { db: \"sqlite\" }` becomes `vitehub: { preset: \"node\", database: true }`.",
        }), { range: ctx.range(hub) })
      }
    }
    return {
      ScriptNode(node) {
        const source = moduleSpecifier(node)
        if (!source || !nuxtHubImport.test(source.specifier)) return
        ctx.report(diagnostics.VHUB0032({
          why: `\`${source.specifier}\` is a NuxtHub import. ViteHub does not provide it.`,
          fix: "Import `kv` from `vite-hub/kv`, `blob` from `vite-hub/blob`, and `useDatabase` from `vite-hub/database/drizzle`. Each KV and Blob method returns an `[error, value]` tuple.",
        }), { range: ctx.range(node) })
      },
    }
  },
})

// VHUB0033

/** Import paths that ViteHub removed, with the path that replaces each one. */
const removedPaths = new Map([
  ["vite-hub/box", { replacement: "vite-hub/sandbox", note: "Box was renamed to Sandbox." }],
  ["vite-hub/sandbox-task", { replacement: "vite-hub/sandbox/task", note: "Sandbox Task moved into the Sandbox package." }],
  ["@vite-hub/sandbox-task", { replacement: "@vite-hub/sandbox/task", note: "Sandbox Task moved into the Sandbox package." }],
  ["vite-hub/content/presets/cms", { replacement: "vite-hub/cms", note: "The CMS has its own package." }],
  ["@vite-hub/content/presets/cms", { replacement: "@vite-hub/cms", note: "The CMS has its own package." }],
  ["vite-hub/schedule/runtime/driver", { replacement: "`defineSchedule()` from `vite-hub/schedule` in `server/schedules/`", note: "Runtime Schedules were removed." }],
])

/** Exports that ViteHub renamed, by module name from `vitehubModule()`. */
const renamedExports: { modules: (module: string) => boolean, renames: Map<string, string> }[] = [
  {
    modules: module => module === "ui" || module.startsWith("ui/"),
    renames: new Map([
      ["AgentChat", "Chat"],
      ["AgentChatMessage", "ChatMessage"],
      ["AgentChatPrompt", "PromptInput"],
      ["AgentSession", "ChatSession"],
      ["AgentMarkdown", "Markdown"],
      ["AgentCodeView", "CodeView"],
      ["AgentFile", "FileView"],
      ["AgentFileDiff", "FileDiff"],
      ["AgentMultiFileDiff", "MultiFileDiff"],
      ["AgentPatchDiff", "PatchDiff"],
      ["AgentUnresolvedFile", "UnresolvedFile"],
      ["AgentFileTree", "FileTree"],
      ["AgentToolList", "ToolList"],
      ["AgentTrace", "TraceRun"],
      ["useAgentFileTree", "useFileTree"],
      ["useAgentFileTreeSelection", "useFileTreeSelection"],
    ]),
  },
  {
    modules: module => module === "agent/capabilities",
    renames: new Map([["cost", "usage"]]),
  },
]

export const noRemovedApis: DoctorRule = createRule({
  meta: {
    id: "vitehub/no-removed-apis",
    title: "Replace removed ViteHub APIs",
    category: "correctness",
    severity: "error",
    requires: { script: true },
  },
  create(ctx) {
    const r = resolver(ctx)
    return {
      ScriptNode(node) {
        const source = moduleSpecifier(node)
        if (source) {
          const removed = removedPaths.get(source.specifier)
          if (removed) {
            ctx.report(diagnostics.VHUB0033({
              why: `\`${source.specifier}\` no longer exists. ${removed.note}`,
              fix: `Use ${removed.replacement.includes("`") ? removed.replacement : `\`${removed.replacement}\``}.`,
            }), { range: ctx.range(node) })
            return
          }
          const module = vitehubModule(source.specifier)
          const table = module ? renamedExports.find(entry => entry.modules(module)) : undefined
          if (table && isNodeType(node, "ImportDeclaration") && Array.isArray(node.specifiers)) {
            for (const specifier of node.specifiers) {
              const imported = isNode(specifier) && isIdentifier(specifier.imported) ? specifier.imported.name : undefined
              const replacement = imported && table.renames.get(imported)
              if (!replacement || !isNode(specifier)) continue
              ctx.report(diagnostics.VHUB0033({
                why: `\`${source.specifier}\` no longer exports \`${imported}\`. It was renamed to \`${replacement}\`.`,
                fix: `Import \`${replacement}\` from \`${source.specifier}\`.`,
              }), { range: ctx.range(specifier) })
            }
          }
          return
        }
        if (!isNodeType(node, "CallExpression")) return
        const options = callArguments(node)[0]
        if (calls(r, node, ["agent/capabilities"], "gmail")) {
          const mode = objectProperty(options, "mode")
          if (mode) {
            ctx.report(diagnostics.VHUB0033({
              why: "`gmail()` no longer reads `mode`. ViteHub ignores it, so the Agent gets only the default `search` and `read` tools.",
              fix: "Use `operations`, for example `gmail({ operations: [\"search\", \"read\", \"draft\"] })`, and allow `gmail.users.drafts.create` in the Connection rules.",
            }), { range: ctx.range(mode) })
          }
        }
        else if (calls(r, node, ["content", "content/collections"], "documents")) {
          const route = objectProperty(options, "route")
          if (route) {
            ctx.report(diagnostics.VHUB0033({
              why: "`documents()` no longer reads `route`. ViteHub ignores it, so document URLs, the sitemap, and `resolve()` fall back to the document id.",
              fix: "Rename `route` to `url`.",
            }), { range: ctx.range(route) })
          }
        }
      },
    }
  },
})

// VHUB0034

export const markdownFilePath: DoctorRule = createRule({
  meta: {
    id: "vitehub/markdown-file-path",
    title: "Pass renderMarkdownFile a path that does not depend on the working directory",
    category: "correctness",
    severity: "warn",
    requires: { script: true },
  },
  create(ctx) {
    const r = resolver(ctx)
    return {
      ScriptNode(node) {
        if (!isNodeType(node, "CallExpression") || !calls(r, node, ["markdown-template/file"], "renderMarkdownFile")) return
        const path = callArguments(node)[0]
        const value = stringValue(path)
        if (value === undefined || !/^\.\.?\//.test(value)) return
        ctx.report(diagnostics.VHUB0034({
          why: `\`renderMarkdownFile("${value}")\` resolves the path from the working directory of the process, not from this file. It reads a different file, or none, when the server starts in another directory. Deployed bundles do not include the Markdown file.`,
          fix: `Import the template, \`import render from "${value.replace(/\.md$/, ".template.md")}"\`, so the build bundles it. To read the file at runtime, pass \`new URL("${value}", import.meta.url)\`.`,
        }), { range: ctx.range(path) })
      },
    }
  },
})

// VHUB0035

const commentsEntryFile = /(?:^|\/)server\/comments\.m?[jt]s$/

/** The exported names of the entry, and the export statement of each name. */
function namedExports(ctx: RuleContext): Map<string, AstNode> {
  const names = new Map<string, AstNode>()
  for (const statement of programBody(ctx)) {
    if (!isNodeType(statement, "ExportNamedDeclaration") || statement.exportKind === "type") continue
    const declaration = statement.declaration
    if (isNodeType(declaration, "VariableDeclaration") && Array.isArray(declaration.declarations)) {
      for (const declarator of declaration.declarations) {
        if (isNode(declarator) && isIdentifier(declarator.id)) names.set(declarator.id.name, declarator)
      }
    }
    for (const specifier of Array.isArray(statement.specifiers) ? statement.specifiers : []) {
      if (!isNode(specifier) || specifier.exportKind === "type") continue
      const name = isIdentifier(specifier.exported) ? specifier.exported.name : stringValue(specifier.exported)
      if (name) names.set(name, specifier)
    }
  }
  return names
}

export const commentsEntry: DoctorRule = createRule({
  meta: {
    id: "vitehub/comments-entry",
    title: "Export the live Comments API as `comments`",
    category: "correctness",
    severity: "error",
    requires: { script: true },
  },
  create(ctx) {
    if (!commentsEntryFile.test(ctx.file.relativePath)) return
    const r = resolver(ctx)
    const exported = defaultExport(ctx)
    const hasDefault = Boolean(exported && !isNodeType(unwrap(exported.value), "TSInterfaceDeclaration"))
    const named = namedExports(ctx)
    const comments = named.get("comments")
    if (hasDefault && comments) {
      ctx.report(diagnostics.VHUB0035({
        why: "`server/comments.ts` has a default export and a `comments` export. A default export selects Comment operations, so ViteHub never installs the live `comments` API.",
        fix: "Keep one form. For the live-site API, remove the default export and keep `export const comments = defineComments({ ... })`.",
      }), { range: ctx.range(comments) })
    }
    return {
      ScriptNode(node) {
        if (!isNodeType(node, "CallExpression") || !calls(r, node, ["comments"], "defineComments")) return
        const { parent } = semanticParent(node)
        const declarator = isNodeType(parent, "VariableDeclarator") ? parent : undefined
        const exportedName = declarator && isIdentifier(declarator.id) && named.get(declarator.id.name) === declarator ? declarator.id.name : undefined
        if (!hasDefault && !comments && exportedName) {
          ctx.report(diagnostics.VHUB0035({
            why: `\`server/comments.ts\` exports \`defineComments()\` as \`${exportedName}\`. ViteHub installs the live API only for an export named \`comments\`. Without it, the entry selects Comment operations.`,
            fix: `Rename the export to \`comments\`: \`export const comments = defineComments({ ... })\`.`,
          }), { range: ctx.range(node) })
        }
        // Comment operations, selected by a default export, have no `database` option.
        const database = hasDefault ? undefined : objectProperty(callArguments(node)[0], "database")
        if (database && stringValue(database.value) === undefined) {
          ctx.report(diagnostics.VHUB0035({
            why: "ViteHub reads `database` from `defineComments()` without running the file, so it must be a string literal. With any other value, ViteHub stores Comments in the default Database.",
            fix: "Write the Database name as a string, for example `database: \"analytics\"`.",
          }), { range: ctx.range(database) })
        }
      },
    }
  },
})

export const rules: DoctorRule[] = [
  realtimeCarets,
  realtimePersistence,
  forgeErrorImports,
  sandboxRuntimeOptions,
  defineAgentFromViteHub,
  rateLimitCapabilityLimiter,
  noViteHubPluginInNuxt,
  validViteHubOptions,
  noNuxtHubLeftovers,
  noRemovedApis,
  markdownFilePath,
  commentsEntry,
]
