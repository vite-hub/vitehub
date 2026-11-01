import { createRule } from "vite-doctor/extension"
import type { DoctorRule, RuleContext } from "vite-doctor/extension"

import { callArguments, chainRoot, defaultExport, enclosingFunction, isExport, isFunctionNode, isIdentifier, isNode, isNodeType, isTestFile, memberPath, objectProperties, objectProperty, objectValue, propertyName, resolver, semanticParent, stringValue, unwrap, walkScript } from "../ast.ts"
import type { AstNode, Resolver, ViteHubReference } from "../ast.ts"
import { diagnostics } from "../diagnostics.ts"
import { discoveredDefinition, viteHubInventory } from "../inventory.ts"
import type { DefinitionKind } from "../inventory.ts"

type NamedCall = { modules: readonly string[], names: readonly string[], kind: DefinitionKind, label: string }

/** Runtime Helpers that take a Definition name as their first argument. */
const namedCalls: readonly NamedCall[] = [
  { modules: ["queue"], names: ["runQueue", "deferQueue", "getQueue"], kind: "queue", label: "Queue" },
  { modules: ["workflow"], names: ["runWorkflow", "deferWorkflow", "getWorkflowRun", "cancelWorkflow"], kind: "workflow", label: "Workflow" },
  { modules: ["database/drizzle"], names: ["useDatabase"], kind: "database", label: "Database" },
  { modules: ["channels", "channels/server"], names: ["useChannel"], kind: "channel", label: "Channel" },
  { modules: ["browser"], names: ["runBrowser"], kind: "browser", label: "Browser" },
  { modules: ["sandbox/task"], names: ["runSandboxTask"], kind: "sandboxTask", label: "Sandbox Task" },
  { modules: ["schedule/runtime"], names: ["runSchedule"], kind: "schedule", label: "Schedule" },
  { modules: ["connections/server"], names: ["useConnection"], kind: "connection", label: "Connection" },
  { modules: ["agent/vue"], names: ["useAgent"], kind: "agent", label: "Agent" },
]

function namedCall(reference: ViteHubReference | undefined): NamedCall | undefined {
  return namedCalls.find(entry => isExport(reference, entry.modules, entry.names))
}

function quoteList(names: readonly string[]): string {
  const shown = names.slice(0, 8).map(name => `\`${name}\``).join(", ")
  return names.length > 8 ? `${shown}, and ${names.length - 8} more` : shown
}

export const knownDefinitionNames: DoctorRule = createRule({
  meta: {
    id: "vitehub/known-definition-names",
    title: "Use the name of a discovered Definition",
    category: "correctness",
    severity: "error",
    requires: { script: true },
  },
  create(ctx) {
    const r = resolver(ctx)
    const { definitions } = viteHubInventory(ctx)
    // Discovery cannot see a Workflow that this file registers: an Agent with `runtime: workflow("name")`,
    // or `createWorkflow("name", handler)` and `createWorkflow({ name, handler })`.
    const localWorkflows = new Set<string>()
    walkScript(ctx.file.scriptAst, (node) => {
      if (!isNodeType(node, "CallExpression")) return
      const callee = r.callee(node)
      if (!isExport(callee, ["agent"], "workflow") && !isExport(callee, ["workflow"], "createWorkflow")) return
      const first = callArguments(node)[0]
      const name = stringValue(first) ?? stringValue(objectValue(first, "name"))
      if (name) localWorkflows.add(name)
    })
    return {
      ScriptNode(node) {
        if (!isNodeType(node, "CallExpression")) return
        const reference = r.callee(node)
        const entry = namedCall(reference)
        if (!reference || !entry) return
        const discovered = definitions[entry.kind]
        // Plugins can contribute Definitions that Doctor cannot see, so a kind without files is not checked.
        if (!discovered?.length) return
        const known = [...discovered.map(definition => definition.name), ...entry.kind === "workflow" ? localWorkflows : []]
        const argument = callArguments(node)[0]
        const name = stringValue(argument)
        if (name === undefined) return
        // `runSchedule(name, { registry })` reads its own registry, not the discovered Schedules.
        if (entry.kind === "schedule" && objectProperty(callArguments(node)[1], "registry")) return
        const base = entry.kind === "connection" ? name.split(":")[0] ?? name : name
        if (known.includes(base) || entry.kind === "database" && name === "default") return
        ctx.report(diagnostics.VHUB0013({
          why: `\`${reference.name}("${name}")\` names a ${entry.label} that ViteHub does not discover. The call fails when it runs. Known ${entry.label} names: ${quoteList(known)}.`,
          fix: `Use the name of a discovered ${entry.label}, or add the ${entry.label} Definition file for \`${name}\`.`,
        }), { range: ctx.range(argument) })
      },
    }
  },
})

/** Kinds whose runtime loads the default export of each discovered file. */
const defaultExportKinds = new Set<DefinitionKind>(["agent", "browser", "connection", "queue", "realtime", "sandboxTask", "schedule", "workflow"])

export const definitionDefaultExport: DoctorRule = createRule({
  meta: {
    id: "vitehub/definition-default-export",
    title: "Default-export each discovered Definition",
    category: "correctness",
    severity: "error",
    requires: { script: true },
  },
  create(ctx) {
    if (ctx.file.relativePath.endsWith(".d.ts")) return
    const discovered = discoveredDefinition(ctx)
    const step = viteHubInventory(ctx).definitions.workflow?.find(workflow => workflow.steps?.includes(ctx.file.relativePath))
    if (!(discovered && defaultExportKinds.has(discovered.kind)) && !step) return
    return {
      ScriptNode(node) {
        if (!isNodeType(node, "Program") || defaultExport(ctx)) return
        ctx.report(diagnostics.VHUB0014({
          why: step
            ? `\`${ctx.file.relativePath}\` is a step of the \`${step.name}\` Workflow, but it has no default export. The Workflow calls the default export, so the step fails when it runs.`
            : `ViteHub discovers \`${ctx.file.relativePath}\` as the \`${discovered?.name}\` ${discovered?.kind} Definition, but the file has no default export. The Definition fails when it is used.`,
          fix: step
            ? "Default-export the step function: `export default async function (input) { ... }`."
            : "Default-export the Definition, for example `export default defineQueue(...)`. Move helper modules out of the discovered directory, for example to `server/utils/`.",
        }))
      },
    }
  },
})

type Factory = { module: string, name: string, kind: DefinitionKind }

const definitionFactories: readonly Factory[] = [
  { module: "queue", name: "defineQueue", kind: "queue" },
  { module: "workflow", name: "defineWorkflow", kind: "workflow" },
  { module: "schedule", name: "defineSchedule", kind: "schedule" },
  { module: "browser", name: "defineBrowser", kind: "browser" },
  { module: "realtime", name: "defineRealtime", kind: "realtime" },
  { module: "channels", name: "defineOutboundChannel", kind: "channel" },
  { module: "agent", name: "defineAgent", kind: "agent" },
  { module: "connections", name: "defineConnection", kind: "connection" },
  { module: "sandbox/task", name: "defineSandboxTask", kind: "sandboxTask" },
]

/** An Agent can extend another Agent from any file, so only files meant as Agent Definitions are checked. */
const agentDefinitionPath = /(?:^|\/)agents\/|\.agent\.[cm]?[jt]s$/

export const definitionLocation: DoctorRule = createRule({
  meta: {
    id: "vitehub/definition-location",
    title: "Put each Definition where ViteHub discovers it",
    category: "correctness",
    severity: "error",
    requires: { script: true },
  },
  create(ctx) {
    if (isTestFile(ctx.file.relativePath)) return
    const r = resolver(ctx)
    const { definitions } = viteHubInventory(ctx)
    return {
      ScriptNode(node) {
        if (!isNodeType(node, "Program")) return
        const exported = defaultExport(ctx)
        const value = unwrap(exported?.value)
        if (!exported || !isNodeType(value, "CallExpression")) return
        const reference = r.callee(value)
        const factory = definitionFactories.find(entry => isExport(reference, [entry.module], entry.name))
        if (!factory) return
        const files = definitions[factory.kind]
        if (!files || files.some(definition => definition.file === ctx.file.relativePath)) return
        // A discovered file can re-export this module: `export { default } from "../utils/email-queue"`.
        const module = ctx.file.relativePath.replace(/\.(?:c|m)?[jt]sx?$/, "")
        if (files.some(definition => definition.imports?.some(target => target === module || target === module.replace(/\/index$/, "")))) return
        if (factory.kind === "agent" && !agentDefinitionPath.test(ctx.file.relativePath)) return
        ctx.report(diagnostics.VHUB0015({
          why: `\`${ctx.file.relativePath}\` default-exports \`${factory.name}()\`, but ViteHub does not discover this file. The Definition is never registered, so calls to it fail and it never runs.`,
          fix: `Move the file to the directory or file suffix that ViteHub scans for ${factory.kind} Definitions. The Definitions and discovery reference lists each convention.`,
        }), { range: ctx.range(exported.node) })
      },
    }
  },
})

const queueOptionKeys = new Set(["delaySeconds", "idempotencyKey", "retentionSeconds", "contentType"])

function isQueueEnqueue(reference: ViteHubReference | undefined): boolean {
  if (isExport(reference, ["queue"], ["runQueue", "deferQueue"])) return true
  return reference?.module === "queue" && reference.name === "dynamicQueue" && reference.path.length === 1 && ["run", "defer"].includes(reference.path[0] ?? "")
}

export const queuePayloadOptions: DoctorRule = createRule({
  meta: {
    id: "vitehub/queue-payload-options",
    title: "Pass Queue options as the third argument",
    category: "correctness",
    severity: "warn",
    requires: { script: true },
  },
  create(ctx) {
    const r = resolver(ctx)
    return {
      ScriptNode(node) {
        if (!isNodeType(node, "CallExpression") || !isQueueEnqueue(r.callee(node))) return
        const args = callArguments(node)
        if (args.length !== 2 || !objectValue(args[1], "payload")) return
        const options = objectProperties(args[1]).map(property => propertyName(property)).filter(key => key !== undefined && queueOptionKeys.has(key))
        if (!options.length) return
        ctx.report(diagnostics.VHUB0016({
          why: `This call sends \`{ payload, ${options.join(", ")} }\` as the job payload. ViteHub does not read enqueue options from the payload, so \`${options.join("`, `")}\` has no effect.`,
          fix: "Pass the payload and the options as separate arguments: `runQueue(name, payload, { delaySeconds })`.",
        }), { range: ctx.range(args[1]) })
      },
    }
  },
})

const dispatchCalls: readonly { modules: readonly string[], names: readonly string[] }[] = [
  { modules: ["queue"], names: ["runQueue", "deferQueue", "getQueue"] },
  { modules: ["workflow"], names: ["runWorkflow", "deferWorkflow"] },
  { modules: ["sandbox/task"], names: ["runSandboxTask"] },
  { modules: ["browser"], names: ["runBrowser"] },
]

export const noModuleScopeDispatch: DoctorRule = createRule({
  meta: {
    id: "vitehub/no-module-scope-dispatch",
    title: "Dispatch jobs inside a request",
    category: "correctness",
    severity: "warn",
    requires: { script: true },
  },
  create(ctx) {
    if (isTestFile(ctx.file.relativePath)) return
    const r = resolver(ctx)
    return {
      ScriptNode(node) {
        if (!isNodeType(node, "CallExpression") || enclosingFunction(node)) return
        const reference = r.callee(node)
        if (!reference || !dispatchCalls.some(entry => isExport(reference, entry.modules, entry.names))) return
        ctx.report(diagnostics.VHUB0017({
          why: `\`${reference.name}()\` runs once when the module loads, outside a request. ViteHub reads the host binding and \`waitUntil\` from the active request, so the call can fail or be dropped on Cloudflare and Vercel.`,
          fix: `Call \`${reference.name}()\` inside a route handler, Queue, Workflow, or Schedule handler.`,
        }), { range: ctx.range(node) })
      },
    }
  },
})

/** A non-tuple result of a call, or `undefined` when the call is not one of these APIs. */
function nonTupleResult(r: Resolver, call: unknown): { name: string, kind: "response" | "value" } | undefined {
  const reference = r.callee(call)
  if (!reference) return
  if (isExport(reference, ["sandbox/task"], "runSandboxTask") || isExport(reference, ["browser"], "runBrowser")) return { name: reference.name, kind: "response" }
  if (isExport(reference, ["workflow"], ["runWorkflow", "deferWorkflow", "getWorkflowRun", "cancelWorkflow", "resumeWorkflowSignal"])
    || isExport(reference, ["queue"], "getQueue")
    || isExport(reference, ["schedule/runtime"], "runSchedule")) return { name: reference.name, kind: "value" }
  // `runAgent(agent, context, input)` returns the Agent's output, which can be an array, so it is not checked.
}

function arrayPatternTarget(awaited: AstNode): AstNode | undefined {
  const { parent, child } = semanticParent(awaited)
  if (isNodeType(parent, "VariableDeclarator") && parent.init === child && isNodeType(parent.id, "ArrayPattern")) return parent.id
  if (isNodeType(parent, "AssignmentExpression") && parent.right === child && isNodeType(parent.left, "ArrayPattern")) return parent.left
}

export const noDestructureNonTuples: DoctorRule = createRule({
  meta: {
    id: "vitehub/no-destructure-non-tuples",
    title: "Do not destructure results that are not tuples",
    category: "correctness",
    severity: "error",
    requires: { script: true },
  },
  create(ctx) {
    const r = resolver(ctx)
    return {
      ScriptNode(node) {
        if (!isNodeType(node, "AwaitExpression")) return
        const result = nonTupleResult(r, unwrap(node.argument))
        const pattern = result && arrayPatternTarget(node)
        if (!result || !pattern) return
        ctx.report(diagnostics.VHUB0018({
          why: result.kind === "response"
            ? `\`${result.name}()\` returns a Web \`Response\`, not an \`[error, value]\` tuple. A \`Response\` is not iterable, so this destructuring throws.`
            : result.name === "runSchedule"
              ? "`runSchedule()` returns a Schedule Run record, not an `[error, value]` tuple. A failed handler resolves with `status: \"failed\"`, so this destructuring throws."
              : `\`${result.name}()\` returns its value and throws on failure. It does not return an \`[error, value]\` tuple, so this destructuring throws or reads the wrong values.`,
          fix: result.kind === "response"
            ? `Read the response: \`const response = await ${result.name}(...)\`, check \`response.ok\`, then call \`await response.json()\`.`
            : result.name === "runSchedule"
              ? "Assign the run, then check it: `const run = await runSchedule(name)`, then `if (run.status === \"failed\")`."
              : `Assign the result directly: \`const value = await ${result.name}(...)\`. Use \`try\`/\`catch\` to handle failures.`,
        }), { range: ctx.range(pattern) })
      },
    }
  },
})

const responseMembers = new Set(["arrayBuffer", "blob", "body", "bodyUsed", "bytes", "clone", "formData", "headers", "json", "ok", "redirected", "status", "statusText", "text", "type", "url"])

function responseCall(r: Resolver, node: unknown): string | undefined {
  const target = unwrap(node)
  if (!isNodeType(target, "AwaitExpression")) return
  const result = nonTupleResult(r, unwrap(target.argument))
  return result?.kind === "response" ? result.name : undefined
}

export const checkResponseResults: DoctorRule = createRule({
  meta: {
    id: "vitehub/check-response-results",
    title: "Read Sandbox Task and Browser results as a Response",
    category: "correctness",
    severity: "error",
    requires: { script: true },
  },
  create(ctx) {
    const r = resolver(ctx)
    function report(node: unknown, name: string, member: string) {
      ctx.report(diagnostics.VHUB0019({
        why: `\`${name}()\` returns a Web \`Response\`. \`${member}\` is not a \`Response\` property, so it is \`undefined\`. A failed run also returns a \`Response\` with an error status, not your data.`,
        fix: `Check \`response.ok\`, then read the data: \`const data = await response.json()\`.`,
      }), { range: ctx.range(node) })
    }
    return {
      ScriptNode(node) {
        if (isNodeType(node, "VariableDeclarator") && isNodeType(node.id, "ObjectPattern")) {
          const name = responseCall(r, node.init)
          if (!name) return
          const properties = Array.isArray(node.id.properties) ? node.id.properties.filter(isNode) : []
          const member = properties.map(property => propertyName(property)).find(key => key !== undefined && !responseMembers.has(key))
          if (member) report(node.id, name, member)
          return
        }
        if (!isNodeType(node, "MemberExpression") || node.computed === true || !isIdentifier(node.property) || responseMembers.has(node.property.name)) return
        const object = unwrap(node.object)
        let name = responseCall(r, object)
        if (!name && isIdentifier(object)) {
          const binding = r.binding(object)
          if (binding && !binding.origin && isNodeType(binding.declaration, "VariableDeclarator") && isIdentifier(binding.declaration.id)) name = responseCall(r, binding.init)
        }
        if (name) report(node, name, node.property.name)
      },
    }
  },
})

/** The step property that the Workflow runtime derives from a step file name. */
function stepPropertyName(file: string): string {
  const base = (file.split("/").pop() ?? file).replace(/\.(?:c|m)?[jt]s$/i, "").replace(/^\d+[.-]?/, "")
  return base.replace(/[-_.]+([a-z0-9])/gi, (_, char: string) => char.toUpperCase())
}

const sourceFile = /\.(?:c|m)?[jt]sx?$/

/** The handler of a folder Workflow index: the function passed to `defineWorkflow()`, or the default-exported function. */
function workflowHandler(ctx: RuleContext): { fn: AstNode, params: Set<string> } | undefined {
  const value = unwrap(defaultExport(ctx)?.value)
  const fn = isNodeType(value, "CallExpression") ? unwrap(callArguments(value)[0]) : value
  if (!isFunctionNode(fn) || !isNode(fn) || !Array.isArray(fn.params)) return
  const names = new Set<string>()
  const collect = (pattern: unknown): void => {
    const target = unwrap(pattern)
    if (isIdentifier(target)) names.add(target.name)
    else if (isNodeType(target, "AssignmentPattern")) collect(target.left)
    else if (isNodeType(target, "ObjectPattern") && Array.isArray(target.properties)) {
      for (const property of target.properties) if (isNode(property)) collect(property.type === "RestElement" ? property.argument : property.value)
    }
  }
  collect(fn.params[0])
  return { fn, params: names }
}

export const workflowStepNames: DoctorRule = createRule({
  meta: {
    id: "vitehub/workflow-step-names",
    title: "Call folder Workflow steps by their file names",
    category: "correctness",
    severity: "error",
    requires: { script: true },
  },
  create(ctx) {
    const workflows = viteHubInventory(ctx).definitions.workflow ?? []
    const path = ctx.file.relativePath
    const workflow = workflows.find(definition => definition.file === path && definition.steps?.length)
    // A folder Workflow without `index.ts` has no index file to report on, so each step file reports its own name.
    const indexless = workflow ? undefined : workflows.find(definition => definition.steps?.includes(path) && !sourceFile.test(definition.file))
    const steps = (workflow ?? indexless)?.steps
    if (!steps) return
    const owners = new Map<string, string[]>()
    for (const step of steps) owners.set(stepPropertyName(step), [...owners.get(stepPropertyName(step)) ?? [], step])
    if (indexless) {
      const name = stepPropertyName(path)
      const files = owners.get(name) ?? []
      if (name && files.length < 2) return
      return {
        ScriptNode(node) {
          if (!isNodeType(node, "Program")) return
          ctx.report(diagnostics.VHUB0020({
            why: name
              ? `The step files ${quoteList(files)} of the \`${indexless.name}\` Workflow all become the \`steps.${name}\` property. The Workflow fails when it runs.`
              : `The step file \`${path}\` has no name after its number prefix, so it has no \`steps\` property. The Workflow fails when it runs.`,
            fix: "Rename the step files so that each one has a unique name after its number prefix, for example `01.create-user.ts`.",
          }))
        },
      }
    }
    if (!workflow) return
    const names = [...owners.keys()].filter(Boolean)
    const handler = workflowHandler(ctx)
    const r = resolver(ctx)
    return {
      ScriptNode(node) {
        if (isNodeType(node, "Program")) {
          for (const [name, files] of owners) {
            if (name && files.length < 2) continue
            ctx.report(diagnostics.VHUB0020({
              why: name
                ? `The step files ${quoteList(files)} all become the \`steps.${name}\` property. The Workflow fails when it runs.`
                : `The step file ${quoteList(files)} has no name after its number prefix, so it has no \`steps\` property. The Workflow fails when it runs.`,
              fix: "Rename the step files so that each one has a unique name after its number prefix, for example `01.create-user.ts`.",
            }))
          }
          return
        }
        if (!isNodeType(node, "MemberExpression") || node.computed === true || !isIdentifier(node.property)) return
        const objectPath = memberPath(node.object)
        if (!objectPath || objectPath.at(-1) !== "steps" || objectPath.length > 2) return
        // Steps come from the Workflow handler's argument, as `{ steps }` or `ctx.steps`. Other `steps` are other data.
        const root = chainRoot(node.object)
        const binding = r.binding(root)
        if (!root || !binding || !handler || binding !== r.scopes.lookup(handler.fn, root.name) || !handler.params.has(root.name)) return
        const step = node.property.name
        if (names.includes(step)) return
        ctx.report(diagnostics.VHUB0020({
          why: `\`steps.${step}\` matches no step file of the \`${workflow.name}\` Workflow, so it is \`undefined\` when the Workflow runs. Known steps: ${quoteList(names)}.`,
          fix: "Use a known step name, or add a step file. ViteHub removes the number prefix from the file name and converts it to camelCase: `01.send-email.ts` becomes `steps.sendEmail`.",
        }), { range: ctx.range(node) })
      },
    }
  },
})

const cronFields = [
  { label: "minute", min: 0, max: 59 },
  { label: "hour", min: 0, max: 23 },
  { label: "day of month", min: 1, max: 31 },
  { label: "month", min: 1, max: 12 },
  { label: "day of week", min: 0, max: 7 },
] as const

/** Problems in a five-field cron expression that the Schedule build does not report. */
function cronProblems(cron: string): string[] {
  const fields = cron.trim().split(/\s+/)
  if (fields.length !== 5) return []
  const problems: string[] = []
  fields.forEach((field, index) => {
    const spec = cronFields[index]
    if (!spec) return
    // Names such as `MON` work in the process runtime, and provider builds reject them with `SCHEDULE_R0003`.
    if (!/^[*,/\-0-9]+$/.test(field)) return
    for (const part of field.split(",")) {
      const [range, step] = part.split("/")
      if (step !== undefined && !(/^\d+$/.test(step) && Number(step) > 0)) problems.push(`the ${spec.label} step \`/${step}\` is not a positive number`)
      if (range === undefined || range === "*") continue
      const bounds = range.split("-")
      const numbers = bounds.map(Number)
      if (bounds.length > 2 || bounds.some(bound => !/^\d+$/.test(bound))) {
        problems.push(`the ${spec.label} field \`${field}\` is not valid`)
        continue
      }
      for (const value of numbers) {
        if (value < spec.min || value > spec.max) problems.push(`${value} is outside the ${spec.label} range ${spec.min}-${spec.max}`)
      }
      if (numbers.length === 2 && (numbers[0] ?? 0) > (numbers[1] ?? 0)) problems.push(`the ${spec.label} range \`${range}\` runs backwards`)
    }
  })
  return problems
}

export const validScheduleCron: DoctorRule = createRule({
  meta: {
    id: "vitehub/valid-schedule-cron",
    title: "Use a valid portable cron expression",
    category: "correctness",
    severity: "error",
    requires: { script: true },
  },
  create(ctx) {
    const r = resolver(ctx)
    return {
      ScriptNode(node) {
        if (!isNodeType(node, "CallExpression") || !isExport(r.callee(node), ["schedule"], "defineSchedule")) return
        const [first] = callArguments(node)
        const cronNode = stringValue(first) === undefined ? objectValue(first, "cron") : first
        const cron = stringValue(cronNode)
        if (cron === undefined) return
        const problems = cronProblems(cron)
        if (!problems.length) return
        ctx.report(diagnostics.VHUB0021({
          why: `The cron \`${cron}\` is not valid: ${problems.join("; ")}. The Schedule fails at deploy or when it first runs.`,
          fix: "Use five numeric fields in UTC, such as `0 8 * * 1` for 08:00 every Monday. Set only one of the day of month and the day of week.",
        }), { range: ctx.range(cronNode) })
      },
    }
  },
})

export const manualScheduleRun: DoctorRule = createRule({
  meta: {
    id: "vitehub/manual-schedule-run",
    title: "Run only manual Schedules by name",
    category: "correctness",
    severity: "error",
    requires: { script: true },
  },
  create(ctx) {
    const r = resolver(ctx)
    const schedules = viteHubInventory(ctx).definitions.schedule
    if (!schedules?.length) return
    return {
      ScriptNode(node) {
        if (!isNodeType(node, "CallExpression") || !isExport(r.callee(node), ["schedule/runtime"], "runSchedule")) return
        if (objectProperty(callArguments(node)[1], "registry")) return
        const argument = callArguments(node)[0]
        const name = stringValue(argument)
        const schedule = schedules.find(definition => definition.name === name)
        if (!schedule || schedule.manual === true) return
        ctx.report(diagnostics.VHUB0022({
          why: `\`runSchedule("${schedule.name}")\` runs a Schedule that does not set \`manual: true\`. It throws \`SCHEDULE_MANUAL_RUN_DISABLED\` when it runs.`,
          fix: `Add \`manual: true\` to \`defineSchedule()\` in \`${schedule.file}\`.`,
        }), { range: ctx.range(argument) })
      },
    }
  },
})

export const validOutboundChannel: DoctorRule = createRule({
  meta: {
    id: "vitehub/valid-outbound-channel",
    title: "Configure each outbound Channel connector",
    category: "correctness",
    severity: "error",
    requires: { script: true },
  },
  create(ctx) {
    const r = resolver(ctx)
    return {
      ScriptNode(node) {
        if (!isNodeType(node, "CallExpression") || !isExport(r.callee(node), ["channels"], "defineOutboundChannel")) return
        const definition = callArguments(node)[0]
        const connectors = unwrap(objectValue(definition, "connectors"))
        if (!isNodeType(connectors, "ObjectExpression")) return
        const properties = objectProperties(connectors)
        if (properties.some(property => property.type === "SpreadElement" || propertyName(property) === undefined)) return
        const fail = (target: unknown, why: string, fix: string) => ctx.report(diagnostics.VHUB0023({ why, fix }), { range: ctx.range(target) })
        if (!properties.length) {
          fail(connectors, "`defineOutboundChannel()` has no connectors, so the Channel cannot send. It throws `CHANNELS_C0003` when it loads, and `send()` returns that error.", "Add at least one connector with a `send(text, options)` function.")
          return
        }
        for (const property of properties) {
          const value = unwrap(property.value)
          const name = propertyName(property)
          if (isNodeType(value, "ObjectExpression") && !objectValue(value, "send") && !objectProperties(value).some(entry => entry.type === "SpreadElement")) {
            fail(property, `The connector \`${name}\` has no \`send\` function. The Channel throws \`CHANNELS_C0004\` when it loads, and \`send()\` returns that error.`, `Add \`send(text, options)\` to the \`${name}\` connector.`)
          }
        }
        const defaultConnectorNode = objectValue(definition, "defaultConnector")
        const defaultConnector = stringValue(defaultConnectorNode)
        const names = properties.map(property => propertyName(property))
        if (defaultConnector !== undefined && !names.includes(defaultConnector)) {
          fail(defaultConnectorNode, `\`defaultConnector: "${defaultConnector}"\` is not one of the connectors. The Channel throws \`CHANNELS_C0005\` when it loads, and \`send()\` returns that error.`, `Set \`defaultConnector\` to one of ${quoteList(names.filter((name): name is string => name !== undefined))}.`)
        }
      },
    }
  },
})

export const rules: DoctorRule[] = [
  knownDefinitionNames,
  definitionDefaultExport,
  definitionLocation,
  queuePayloadOptions,
  noModuleScopeDispatch,
  noDestructureNonTuples,
  checkResponseResults,
  workflowStepNames,
  validScheduleCron,
  manualScheduleRun,
  validOutboundChannel,
]
