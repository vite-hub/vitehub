import { createRule } from "vite-doctor/extension"
import type { DoctorRule, RuleContext } from "vite-doctor/extension"

import {
  booleanValue, callArguments, chainRoot, isExport, isFunctionNode, isIdentifier, isNode, isNodeType, isRouteHandler, isTestFile, memberPath,
  objectProperties, objectProperty, objectValue, parentOf, propertyName, resolver, semanticParent, stringValue, unwrap, walkScript,
} from "../ast.ts"
import type { AstNode, Resolver, ViteHubReference } from "../ast.ts"
import { diagnostics } from "../diagnostics.ts"
import { viteHubInventory } from "../inventory.ts"

const serverEnvModule = "#vitehub/env/server"

/** The export name when `reference` is one of `names` from `modules`. */
function matchExport(reference: ViteHubReference | undefined, modules: readonly string[], names: readonly string[]): string | undefined {
  return reference && isExport(reference, modules, names) ? reference.name : undefined
}

/** True for a call of the ViteHub export `name`, or of a global with that name when nothing in scope binds it. */
function isViteHubCall(r: Resolver, call: unknown, modules: readonly string[], name: string): boolean {
  const target = unwrap(call)
  if (!isNodeType(target, "CallExpression")) return false
  const reference = r.callee(target)
  if (reference) return isExport(reference, modules, name)
  const callee = unwrap(target.callee)
  return isIdentifier(callee, name) && !r.binding(callee)
}

// Server Env value paths.

type EnvPath = { path: string[], sync: boolean }

/** The property path from an object pattern to the identifier `name`, such as `["github", "token"]`. */
function patternPath(pattern: unknown, name: string): string[] | undefined {
  const target = unwrap(pattern)
  if (isIdentifier(target, name)) return []
  if (isNodeType(target, "AssignmentPattern")) return patternPath(target.left, name)
  if (!isNodeType(target, "ObjectPattern") || !Array.isArray(target.properties)) return
  for (const property of target.properties) {
    if (!isNodeType(property, "Property")) continue
    const key = propertyName(property)
    const rest = key === undefined ? undefined : patternPath(property.value, name)
    if (key !== undefined && rest) return [key, ...rest]
  }
}

/** The identifiers that a binding pattern declares, in source order. */
function patternBindings(pattern: unknown, into: { type: "Identifier", name: string }[] = []): { type: "Identifier", name: string }[] {
  const target = unwrap(pattern)
  if (isIdentifier(target)) into.push(target)
  else if (isNodeType(target, "AssignmentPattern")) patternBindings(target.left, into)
  else if (isNodeType(target, "RestElement")) patternBindings(target.argument, into)
  else if (isNodeType(target, "ArrayPattern") && Array.isArray(target.elements)) for (const element of target.elements) patternBindings(element, into)
  else if (isNodeType(target, "ObjectPattern") && Array.isArray(target.properties)) {
    for (const property of target.properties) patternBindings(isNodeType(property, "RestElement") ? property.argument : isNode(property) ? property.value : undefined, into)
  }
  return into
}

/** Resolves expressions that read Server Env: `useServerEnv()`, `await loadServerEnv()`, and names bound from them. */
function envPaths(ctx: RuleContext): (node: unknown) => EnvPath | undefined {
  const r = resolver(ctx)
  function root(node: unknown, seen = new Set<unknown>()): EnvPath | undefined {
    const target = unwrap(node)
    if (seen.has(target)) return
    seen.add(target)
    if (isNodeType(target, "CallExpression") && isExport(r.callee(target), [serverEnvModule], "useServerEnv")) return { path: [], sync: true }
    if (isNodeType(target, "AwaitExpression") && isNodeType(unwrap(target.argument), "CallExpression") && isExport(r.callee(target.argument), [serverEnvModule], "loadServerEnv")) {
      return { path: [], sync: false }
    }
    if (isNodeType(target, "MemberExpression")) {
      const base = root(target.object, seen)
      const property = target.computed === true ? stringValue(target.property) : isIdentifier(target.property) ? target.property.name : undefined
      return base && property !== undefined ? { path: [...base.path, property], sync: base.sync } : undefined
    }
    if (isIdentifier(target)) {
      // Follow the binding, not the spelling: a parameter or `catch (token)` with the same name is another value.
      const declaration = r.binding(target)?.declaration
      if (!isNodeType(declaration, "VariableDeclarator")) return
      if (isIdentifier(declaration.id)) return root(declaration.init, seen)
      const path = patternPath(declaration.id, target.name)
      const base = path && root(declaration.init, seen)
      return base && path ? { path: [...base.path, ...path], sync: base.sync } : undefined
    }
  }
  return node => root(node)
}

const coercingCalls = new Set(["String", "JSON.stringify", "Buffer.from", "encodeURIComponent", "btoa"])
const coercingOperators = new Set(["+", "==", "!="])
const strictOperators = new Set(["===", "!=="])

/** `value === undefined` and `value == null` test whether an optional secret is set. They read no value. */
function isNullish(node: unknown): boolean {
  const target = unwrap(node)
  return isNodeType(target, "Literal") && target.value === null || isIdentifier(target, "undefined")
}

const logMethods = new Set(["debug", "error", "info", "log", "trace", "warn"])

/**
 * True when the nearest call that receives the value is `console.*()` or a logger call such as `logger.info()`.
 * Converting calls such as `JSON.stringify()` pass the value on. Any other call, such as `fetch()`, uses it first.
 */
function inLogCall(node: unknown): boolean {
  let current = parentOf(node)
  while (current && !isFunctionNode(current)) {
    if (current.type === "NewExpression") return false
    if (current.type === "CallExpression") {
      const path = memberPath(current.callee)
      if (path && (path[0] === "console" || path.length > 1 && logMethods.has(path.at(-1) ?? ""))) return true
      if (!path || !coercingCalls.has(path.join("."))) return false
    }
    current = parentOf(current)
  }
  return false
}

export const unsealSecretEnv: DoctorRule = createRule({
  meta: {
    id: "vitehub/unseal-secret-env",
    title: "Call `.unseal()` before using a secret Server Env value",
    category: "correctness",
    severity: "error",
    requires: { script: true },
  },
  create(ctx) {
    const secrets = new Set(viteHubInventory(ctx).env?.secret ?? [])
    if (!secrets.size) return
    const envPath = envPaths(ctx)

    function check(node: unknown, use: string, strict = false) {
      // Logs should show `<redacted>`. That is the reason `SecretEnv` redacts itself.
      if (inLogCall(node)) return
      const found = envPath(node)
      if (!found) return
      const path = found.path.join(".")
      if (!secrets.has(path)) return
      ctx.report(diagnostics.VHUB0004({
        why: strict
          ? `\`${path}\` is a secret Server Env value, a \`SecretEnv\` object. ${use} compares the object, so it is never equal to a string.`
          : `\`${path}\` is a secret Server Env value, a \`SecretEnv\`. ${use} converts it to the string \`<redacted>\`, so the code sends or compares \`<redacted>\` and not the secret.`,
        fix: `Call \`.unseal()\` where the code needs the raw value, for example \`${path.split(".").at(-1)}.unseal()\`.`,
      }), { range: ctx.range(node) })
    }

    return {
      ScriptNode(node) {
        if (isNodeType(node, "TemplateLiteral") && Array.isArray(node.expressions)) {
          for (const expression of node.expressions) check(expression, "A template literal")
        }
        else if (isNodeType(node, "BinaryExpression") && typeof node.operator === "string") {
          const strict = strictOperators.has(node.operator)
          if (!strict && !coercingOperators.has(node.operator)) return
          if (node.operator !== "+" && (isNullish(node.left) || isNullish(node.right))) return
          check(node.left, `The \`${node.operator}\` operator`, strict)
          check(node.right, `The \`${node.operator}\` operator`, strict)
        }
        else if (isNodeType(node, "CallExpression")) {
          const callee = memberPath(node.callee)?.join(".")
          const encodes = isNodeType(unwrap(node.callee), "MemberExpression") && callee?.endsWith(".encode")
          if (callee && (coercingCalls.has(callee) || encodes)) for (const argument of callArguments(node)) check(argument, `\`${callee}()\``)
        }
        else if (isNodeType(node, "Property")) {
          // A header value: `{ headers: { Authorization: token } }` or `new Headers({ ... })`.
          const object = parentOf(node)
          const owner = semanticParent(object).parent
          const isHeaders = owner?.type === "Property" && propertyName(owner) === "headers"
            || owner?.type === "NewExpression" && isIdentifier(unwrap(owner.callee), "Headers")
          if (isHeaders) check(node.value, "A request header")
        }
      },
    }
  },
})

// Credentials in configuration and Definitions.

const configFile = /(?:^|\/)(?:vite|nuxt)\.config\.[cm]?[jt]s$/
const credentialSuffixes = ["secret", "secrets", "token", "password", "apikey", "privatekey"]

function isCredentialKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-_]/g, "")
  return credentialSuffixes.some(suffix => normalized.endsWith(suffix))
}

/** `process.env.X` or `import.meta.env.X`, which a config file reads when it builds. */
function isBuildEnvRead(node: unknown): boolean {
  const target = unwrap(node)
  if (!isNodeType(target, "MemberExpression")) return false
  const object = unwrap(target.object)
  if (isNodeType(object, "MemberExpression") && isNodeType(unwrap(object.object), "MetaProperty") && isIdentifier(object.property, "env")) return true
  const path = memberPath(object)
  return path?.length === 2 && path[0] === "process" && path[1] === "env" || isNodeType(object, "MemberExpression") && isBuildEnvRead(object)
}

function literalSecret(node: unknown): boolean {
  const value = stringValue(node)
  return value !== undefined && value.trim().length > 0
}

const gatewayPresets = ["anthropic", "cliproxy", "cloudflare", "defineAiGateway", "litellm", "ollama", "openai", "openrouter", "typesafe", "vercel"]

export const noLiteralCredentials: DoctorRule = createRule({
  meta: {
    id: "vitehub/no-literal-credentials",
    title: "Keep credentials out of source and build output",
    category: "security",
    severity: "error",
    requires: { script: true },
  },
  create(ctx) {
    const r = resolver(ctx)
    const isConfig = configFile.test(ctx.file.relativePath)

    function report(node: unknown, why: string) {
      ctx.report(diagnostics.VHUB0005({
        why,
        fix: "Declare the credential in `env.server` with `env({ secret: true, source: env.source(\"NAME\") })`, set `NAME` in the host environment, and read it at runtime.",
      }), { range: ctx.range(node) })
    }

    /** Reports credential-named properties with string literals below `node`. */
    function literalCredentials(node: unknown, owner: string) {
      walkScript(unwrap(node), (child) => {
        if (child.type !== "Property") return
        const key = propertyName(child)
        if (key && isCredentialKey(key) && literalSecret(child.value)) {
          report(child.value, `\`${key}\` in ${owner} is a string literal. The credential is then in source control and in the server bundle.`)
        }
      })
    }

    function serverEnvEntries(node: unknown, path: string) {
      for (const property of objectProperties(node)) {
        const key = propertyName(property)
        if (key === undefined) continue
        const value = unwrap(property.value)
        const entryPath = `${path}.${key}`
        if (isBuildEnvRead(value)) {
          report(value, `\`${entryPath}\` reads the host environment when Vite loads the config. ViteHub then writes the value into the generated server module as a literal.`)
        }
        else if (isNodeType(value, "ObjectExpression")) {
          serverEnvEntries(value, entryPath)
        }
        else if (isNodeType(value, "CallExpression")) {
          const options = callArguments(value).findLast(argument => isNodeType(unwrap(argument), "ObjectExpression"))
          const fallback = objectProperty(options, "default")
          if (!fallback) continue
          if (isBuildEnvRead(fallback.value)) {
            report(fallback.value, `The \`default\` of \`${entryPath}\` reads the host environment when Vite loads the config. ViteHub writes defaults into the generated server module.`)
          }
          else if (booleanValue(objectValue(options, "secret")) === true) {
            report(fallback.value, `\`${entryPath}\` is secret but has a \`default\`. ViteHub writes defaults into the generated server module, so the secret is in the build output.`)
          }
        }
        else if (isCredentialKey(key) && literalSecret(value)) {
          report(value, `\`${entryPath}\` is a literal value. ViteHub writes literal Server Env values into the generated server module.`)
        }
      }
    }

    function emailOptions(node: unknown) {
      for (const property of objectProperties(objectValue(node, "options"))) {
        const key = propertyName(property)
        if (!key || !isCredentialKey(key)) continue
        if (literalSecret(property.value) || isBuildEnvRead(property.value)) {
          report(property.value, `The Email option \`${key}\` is read when Vite loads the config, so ViteHub writes it into the build output.`)
        }
      }
    }

    return {
      ScriptNode(node) {
        if (isConfig && isNodeType(node, "Property")) {
          const key = propertyName(node)
          const owner = semanticParent(parentOf(node)).parent
          if (key === "server" && owner?.type === "Property" && propertyName(owner) === "env") serverEnvEntries(node.value, "env.server")
          if (key === "email" && isNodeType(unwrap(node.value), "ObjectExpression")) emailOptions(node.value)
          return
        }
        if (!isNodeType(node, "CallExpression")) return
        if (isConfig && isViteHubCall(r, node, ["email/vite"], "hubEmail")) {
          emailOptions(callArguments(node)[0])
          return
        }
        const reference = r.callee(node)
        if (isViteHubCall(r, node, ["auth"], "defineAuth")) {
          literalCredentials(callArguments(node)[0], "`defineAuth()`")
          return
        }
        const provider = matchExport(reference, ["connections/google", "connections"], ["google", "apiKey"])
        const gateway = matchExport(reference, ["gateways"], gatewayPresets)
        if (provider) {
          literalCredentials(callArguments(node)[0], `\`${provider}()\``)
          const fallback = unwrap(objectValue(callArguments(node)[0], "fallback"))
          if (isNodeType(fallback, "ArrowFunctionExpression") && literalSecret(fallback.body)) {
            report(fallback.body, "The `fallback` of `apiKey()` returns a string literal. The key is then in source control and in the server bundle.")
          }
        }
        else if (gateway) {
          const options = callArguments(node)[0]
          literalCredentials(options, `\`${gateway}()\``)
          for (const header of objectProperties(objectValue(options, "headers"))) {
            if (literalSecret(header.value)) report(header.value, `A header of \`${gateway}()\` is a string literal. Gateway headers carry credentials.`)
          }
        }
      },
    }
  },
})

// Async helpers.

const promiseMethods = new Set(["then", "catch", "finally"])

/** True when a variable that holds the promise is awaited somewhere in the file. */
/** True when a promise in this position is read as its value: in a string, a comparison, a property, or a member read. */
function readsPromiseAsValue(parent: AstNode, child: unknown): boolean {
  return ["TemplateLiteral", "BinaryExpression"].includes(parent.type)
    || parent.type === "Property" && parent.value === child
    || parent.type === "MemberExpression" && parent.object === child && !(isIdentifier(parent.property) && promiseMethods.has(parent.property.name))
}

/** True when a later use of the name that holds the promise reads it as its value. Returning or passing it on is fine. */
function misusedLater(r: Resolver, target: { type: "Identifier", name: string }): boolean {
  const own = r.binding(target)
  if (!own) return false
  let misused = false
  walkScript(r.ctx.file.scriptAst, (node) => {
    if (misused || node === target || !isIdentifier(node, target.name) || r.binding(node) !== own) return
    const { parent, child } = semanticParent(node)
    if (parent && readsPromiseAsValue(parent, child)) misused = true
  })
  return misused
}

export const awaitAsyncHelpers: DoctorRule = createRule({
  meta: {
    id: "vitehub/await-async-helpers",
    title: "Await ViteHub guards and async Server Env helpers",
    category: "correctness",
    severity: "error",
    requires: { script: true },
  },
  create(ctx) {
    const r = resolver(ctx)
    return {
      ScriptNode(node) {
        if (!isNodeType(node, "CallExpression")) return
        const reference = r.callee(node)
        const { parent, child } = semanticParent(node)
        if (!parent) return
        const guard = matchExport(reference, ["rate-limit"], ["requireRateLimit", "checkRateLimit"])
        if (guard) {
          const unchecked = parent.type === "ExpressionStatement"
            || parent.type === "UnaryExpression" && parent.operator === "!"
            || ["IfStatement", "ConditionalExpression"].includes(parent.type) && parent.test === child
          if (!unchecked) return
          ctx.report(diagnostics.VHUB0006({
            why: `\`${guard}()\` is async. Without \`await\`, the handler continues before the limit is checked, and a rejected request is not stopped.`,
            fix: `Write \`await ${guard}(...)\`.`,
          }), { range: ctx.range(node) })
          return
        }
        const helper = matchExport(reference, [serverEnvModule], ["deriveSecret", "loadServerEnv"])
        if (!helper) return
        let misused = readsPromiseAsValue(parent, child)
        if (parent.type === "VariableDeclarator" && parent.init === child) {
          misused = isNodeType(parent.id, "ObjectPattern") || isIdentifier(parent.id) && misusedLater(r, parent.id)
        }
        if (!misused) return
        ctx.report(diagnostics.VHUB0006({
          why: `\`${helper}()\` returns a promise. Without \`await\`, this code reads the promise, not the value, for example \`[object Promise]\` in a string.`,
          fix: `Write \`await ${helper}(...)\`.`,
        }), { range: ctx.range(node) })
      },
    }
  },
})

export const loadProviderEnv: DoctorRule = createRule({
  meta: {
    id: "vitehub/load-provider-env",
    title: "Read provider-backed Server Env with `loadServerEnv()`",
    category: "correctness",
    severity: "error",
    requires: { script: true },
  },
  create(ctx) {
    const providers = new Set(viteHubInventory(ctx).env?.provider ?? [])
    if (!providers.size) return
    const envPath = envPaths(ctx)

    function report(node: unknown, path: string) {
      ctx.report(diagnostics.VHUB0007({
        why: `\`${path}\` comes from an Env provider. \`useServerEnv()\` reads synchronously, so this read throws \`ENV_ASYNC_REQUIRED\` when the request runs.`,
        fix: "Read the value from `await loadServerEnv(event)`, which loads provider values first.",
      }), { range: ctx.range(node) })
    }

    return {
      ScriptNode(node) {
        if (isNodeType(node, "MemberExpression")) {
          const found = envPath(node)
          if (found?.sync && providers.has(found.path.join("."))) report(node, found.path.join("."))
        }
        else if (isNodeType(node, "VariableDeclarator") && isNodeType(node.id, "ObjectPattern")) {
          const root = envPath(node.init)
          if (!root?.sync) return
          for (const identifier of patternBindings(node.id)) {
            const path = patternPath(node.id, identifier.name)
            const full = path && [...root.path, ...path].join(".")
            if (full && providers.has(full)) report(identifier, full)
          }
        }
      },
    }
  },
})

// Rate Limit.

/** True when `node` is a limiter from `createRateLimiter()`, directly or through a `const`. */
function isRateLimiter(r: Resolver, node: unknown, seen = new Set<unknown>()): boolean {
  const target = unwrap(node)
  if (seen.has(target)) return false
  seen.add(target)
  if (isNodeType(target, "CallExpression")) return isExport(r.callee(target), ["rate-limit"], "createRateLimiter")
  const binding = r.binding(target)
  return Boolean(binding && isNodeType(binding.declaration, "VariableDeclarator") && isIdentifier(binding.declaration.id) && isRateLimiter(r, binding.init, seen))
}

export const checkRateLimitDecision: DoctorRule = createRule({
  meta: {
    id: "vitehub/check-rate-limit-decision",
    title: "Check `decision.allowed` from a Rate Limit",
    category: "correctness",
    severity: "error",
    requires: { script: true },
  },
  create(ctx) {
    const r = resolver(ctx)
    return {
      ScriptNode(node) {
        if (!isNodeType(node, "CallExpression")) return
        const callee = unwrap(node.callee)
        const name = isExport(r.callee(node), ["rate-limit"], "checkRateLimit") ? "checkRateLimit()"
          : isNodeType(callee, "MemberExpression") && isIdentifier(callee.property, "consume") && isRateLimiter(r, callee.object) ? "consume()"
            : undefined
        if (!name) return
        const awaited = semanticParent(node).parent
        if (awaited?.type !== "AwaitExpression") return
        const { parent, child } = semanticParent(awaited)
        if (!parent) return
        const ignored = parent.type === "ExpressionStatement"
        const asBoolean = parent.type === "UnaryExpression" && parent.operator === "!"
          || parent.type === "LogicalExpression"
          || ["IfStatement", "WhileStatement", "ConditionalExpression"].includes(parent.type) && parent.test === child
        if (!ignored && !asBoolean) return
        ctx.report(diagnostics.VHUB0008({
          why: ignored
            ? `\`${name}\` uses a token and returns a decision, but this code ignores the decision. The operation runs when the limit is reached.`
            : `\`${name}\` returns a decision object, which is always truthy. This check never sees a reached limit.`,
          fix: "Store the decision and stop the operation when it is not allowed: `if (!decision.allowed) ...`. Use `requireRateLimit()` to reject with status 429.",
        }), { range: ctx.range(awaited) })
      },
    }
  },
})


/** True when the call result is assigned to a name that is declared outside `handler`. */
function isAssignedOutside(r: Resolver, call: AstNode, handler: AstNode): boolean {
  let current = parentOf(call)
  while (current && current !== handler) {
    if (isNodeType(current, "AssignmentExpression") && isIdentifier(current.left)) {
      let declaration: AstNode | undefined = r.binding(current.left)?.declaration
      while (declaration && declaration !== handler) declaration = parentOf(declaration)
      if (!declaration) return true
    }
    current = parentOf(current)
  }
  return false
}

export const rateLimiterAtModuleScope: DoctorRule = createRule({
  meta: {
    id: "vitehub/rate-limiter-at-module-scope",
    title: "Create memory Rate Limiters once per module",
    category: "correctness",
    severity: "error",
    requires: { script: true },
  },
  create(ctx) {
    if (isTestFile(ctx.file.relativePath)) return
    const r = resolver(ctx)
    return {
      ScriptNode(node) {
        if (!isNodeType(node, "CallExpression") || !isExport(r.callee(node), ["rate-limit/drivers/memory"], "memoryRateLimitDriver")) return
        let current = parentOf(node)
        while (current && !(isFunctionNode(current) && isRouteHandler(ctx, current))) current = parentOf(current)
        // `limiter ??= createRateLimiter(...)` keeps one driver in a binding outside the handler.
        if (!current || isAssignedOutside(r, node, current)) return
        ctx.report(diagnostics.VHUB0009({
          why: "`memoryRateLimitDriver()` keeps its counters in the driver object. This route handler creates a new driver for each request, so every request starts at zero and the limit is never reached.",
          fix: "Create the driver and its `createRateLimiter()` once at module scope, and use that limiter in the handler.",
        }), { range: ctx.range(node) })
      },
    }
  },
})

// Auth, Connections, and Blob.

const authRuntimeOptions = new Set(["baseURL", "secret", "secrets"])

export const authRuntimeOptionsRule: DoctorRule = createRule({
  meta: {
    id: "vitehub/auth-runtime-options",
    title: "Resolve Auth runtime options in the `defineAuth()` callback",
    category: "correctness",
    severity: "error",
    requires: { script: true },
  },
  create(ctx) {
    const r = resolver(ctx)
    return {
      ScriptNode(node) {
        if (!isNodeType(node, "CallExpression") || !isViteHubCall(r, node, ["auth"], "defineAuth")) return
        const options = callArguments(node)[0]
        for (const property of objectProperties(options)) {
          const key = propertyName(property)
          if (!key || !authRuntimeOptions.has(key)) continue
          ctx.report(diagnostics.VHUB0010({
            why: `\`defineAuth()\` resolves \`${key}\` at runtime. In the static options object, the build accepts it, then \`defineAuth()\` throws \`AUTH_C0037\` when the server loads the Auth Definition.`,
            fix: `Pass a callback and return \`${key}\` from it, for example \`defineAuth(({ env, requestOrigin }) => ({ baseURL: requestOrigin, secret: env.auth.secret.unseal() }))\`.`,
          }), { range: ctx.range(property) })
        }
      },
    }
  },
})

export const noAgentConnectionActor: DoctorRule = createRule({
  meta: {
    id: "vitehub/no-agent-connection-actor",
    title: "Do not claim an Agent actor in `useConnection()`",
    category: "security",
    severity: "error",
    requires: { script: true },
  },
  create(ctx) {
    const r = resolver(ctx)
    return {
      ScriptNode(node) {
        if (!isNodeType(node, "CallExpression") || !isExport(r.callee(node), ["connections/server"], "useConnection")) return
        const actor = objectProperty(callArguments(node)[1], "actor")
        const value = stringValue(actor?.value)
        if (!actor || !value?.startsWith("agent:")) return
        ctx.report(diagnostics.VHUB0011({
          why: `\`actor: "${value}"\` claims an Agent identity. Only the Agent runtime can act as an Agent, so the first call throws \`CONNECTIONS_INVALID_ACTOR\`.`,
          fix: "Use a server actor such as `\"schedule:gmail\"`, or call the Connection from the Agent with its Connection Capability.",
        }), { range: ctx.range(actor) })
      },
    }
  },
})

const valibotObjectSchemas = new Set(["object", "looseObject", "strictObject", "objectWithRest"])

/** True for `v.object(...)` or `object(...)` imported from `valibot`. */
function isValibotObject(r: Resolver, call: AstNode): boolean {
  const callee = unwrap(call.callee)
  const root = chainRoot(callee)
  const origin = root ? r.binding(root)?.origin : undefined
  if (origin?.source !== "valibot") return false
  if (isIdentifier(callee)) return valibotObjectSchemas.has(origin.name)
  const path = memberPath(callee)
  return origin.name === "*" && path?.length === 2 && valibotObjectSchemas.has(path[1] ?? "")
}

export const noNestedBlobReferenceSchema: DoctorRule = createRule({
  meta: {
    id: "vitehub/no-nested-blob-reference-schema",
    title: "Do not nest Blob reference schemas in Valibot objects",
    category: "correctness",
    severity: "error",
    requires: { script: true },
  },
  create(ctx) {
    const r = resolver(ctx)
    return {
      ScriptNode(node) {
        if (!isNodeType(node, "CallExpression") || !isValibotObject(r, node)) return
        for (const property of objectProperties(callArguments(node)[0])) {
          const value = unwrap(property.value)
          const reference = isNodeType(value, "CallExpression") ? r.callee(value) : undefined
          if (!reference || !isExport(reference, ["blob"], ["image", "file"])) continue
          ctx.report(diagnostics.VHUB0012({
            why: `\`${reference.name}()\` is a Standard Schema, not a Valibot schema. Valibot accepts the object, then fails when it parses a value.`,
            fix: `Validate the field with \`${reference.name}()['~standard'].validate(value)\`, or pass \`${reference.name}()\` where a Standard Schema is read directly, such as an Agent tool \`inputSchema\`.`,
          }), { range: ctx.range(property) })
        }
      },
    }
  },
})

export const rules: DoctorRule[] = [
  unsealSecretEnv,
  noLiteralCredentials,
  awaitAsyncHelpers,
  loadProviderEnv,
  checkRateLimitDecision,
  rateLimiterAtModuleScope,
  authRuntimeOptionsRule,
  noAgentConnectionActor,
  noNestedBlobReferenceSchema,
]
