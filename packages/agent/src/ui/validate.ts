import { type ActionBinding, getByPath, type PropResolutionContext, type RepeatStatePath, resolveElementProps, resolveRepeatStatePath, type Spec, type UIElement } from "@json-render/core"
import { schema } from "@json-render/vue/schema"
import { formFields, toChatModal, toElicitation } from "@vite-hub/forms"

import { type Catalog, type CatalogEntry, type CatalogSurface, isRecord, propsJsonSchema, surfaceEntries } from "./define.ts"
import { asyncProps, type CatalogDiagnostic, diagnostic, pointerSegment } from "./diagnostics.ts"
import { viteHubCatalog } from "./entries.ts"

import type { StandardSchemaV1 } from "@standard-schema/spec"
import type { FormSource } from "@vite-hub/forms"

/** The spec format version that this catalog reads and writes. */
export const specVersion = 1

/** The most elements that one spec may have. The Console uses the same limit. */
export const maxSpecElements = 128

/** The deepest that the element tree of one spec may be. The Console uses the same limit. */
export const maxSpecDepth = 20

/** The action that sends a named event, with its context, to the Agent that sent the spec. */
export const agentEventAction = "event"

/** An action that an event sends, such as `{ "action": "event", "params": { "name": "deploy.approve" } }`. */
export type SpecActionBinding = ActionBinding

/** One element of a spec: json-render's `UIElement`. Agent UI uses `type`, `props`, `children`, `on`, `repeat`, and `visible`. */
export type SpecElement = UIElement

/** A UI spec in the json-render format: a flat map of elements and the id of the root element. */
export interface CatalogSpec extends Spec {
  /** The spec format version. Saved specs carry it, so a later format can migrate them. */
  version?: typeof specVersion
}

export interface ValidateSpecOptions {
  /** The surface where the spec renders. Components and forms that do not render there fail with `AGENT_UI_R0005` and `AGENT_UI_R0016`. */
  surface: CatalogSurface
  /** The catalog to check against. The built-in catalog by default. */
  catalog?: Catalog
}

/** The result of `validateSpec()`. */
export type SpecValidation
  = | { valid: true, spec: CatalogSpec, diagnostics: [] }
    | { valid: false, diagnostics: CatalogDiagnostic[] }

const specKeys = new Set(["version", "root", "elements", "state"])
const elementKeys = new Set(["type", "props", "children", "on", "repeat", "visible"])
const bindingKeys = new Set(["action", "params", "confirm", "onSuccess", "onError", "preventDefault"])
/** The actions a spec may bind: the Agent event, and json-render's own state actions. */
export const specActions: readonly string[] = [agentEventAction, ...(schema.builtInActions ?? []).map(action => action.name)]

function names(values: Iterable<string>): string {
  const list = [...values]
  return list.length ? list.join(", ") : "none"
}

function issuePath(issue: StandardSchemaV1.Issue): (string | number)[] {
  return (issue.path ?? []).map((segment) => {
    const key = typeof segment === "object" ? segment.key : segment
    return typeof key === "number" ? key : String(key)
  })
}

const pointer = (path: (string | number)[]) => path.map(segment => `/${pointerSegment(segment)}`).join("")

function checkBinding(value: unknown, at: string, out: CatalogDiagnostic[]): void {
  if (!isRecord(value) || typeof value.action !== "string" || !value.action || (value.params !== undefined && !isRecord(value.params)) || Object.keys(value).some(key => !bindingKeys.has(key))) {
    out.push(diagnostic("AGENT_UI_R0001", { problem: "an action is { \"action\": \"<name>\", \"params\": {} }." }, at))
    return
  }
  if (!specActions.includes(value.action)) {
    out.push(diagnostic("AGENT_UI_R0014", { action: value.action, known: names(specActions) }, `${at}/action`))
    return
  }
  if (value.action === agentEventAction && (!isRecord(value.params) || typeof value.params.name !== "string" || !value.params.name || (value.params.context !== undefined && !isRecord(value.params.context)))) {
    out.push(diagnostic("AGENT_UI_R0001", { problem: "the event action needs params { \"name\": \"<event>\", \"context\": {} }, with an optional context object." }, `${at}/params`))
  }
}

/** Why `surface` cannot draw a form, or nothing when it can. The same checks as the surfaces of `@vite-hub/forms`. */
export function formProblem(source: FormSource, surface: CatalogSurface): string | undefined {
  try {
    if (surface === "mcp") toElicitation(source, { message: "" })
    else if (surface === "chatModal") toChatModal(source, { callbackId: "check", title: "check" })
    else formFields(source)
    return undefined
  }
  catch (error) {
    if (!(error instanceof Error)) return String(error)
    // Keep the code of `@vite-hub/forms`, such as FORMS_C0002, so the Agent can look it up.
    const code = "code" in error && typeof error.code === "string" ? error.code : undefined
    return code ? `${code}: ${error.message}` : error.message
  }
}

function checkForm(element: Record<string, unknown>, props: Record<string, unknown>, at: string, surface: CatalogSurface, catalog: Catalog, out: CatalogDiagnostic[]): void {
  const name = props.form
  if (typeof name !== "string") return
  const source = Object.hasOwn(catalog.forms, name) ? catalog.forms[name] : undefined
  if (!source) {
    out.push(diagnostic("AGENT_UI_R0015", { form: name, known: names(Object.keys(catalog.forms)) }, `${at}/props/form`))
    return
  }
  const problem = formProblem(source, surface)
  if (problem) out.push(diagnostic("AGENT_UI_R0016", { form: name, surface, problem }, `${at}/props/form`))
  const value = props.value
  if (value !== undefined && !(isRecord(value) && typeof value.$bindState === "string" && Object.keys(value).length === 1)) {
    out.push(diagnostic("AGENT_UI_R0007", { type: String(element.type), prop: "value", problem: "bind the form values to a state path with { \"$bindState\": \"/path\" }." }, `${at}/props/value`))
  }
}

function checkElement(id: string, value: unknown, elements: Record<string, unknown>, entries: Map<string, CatalogEntry>, surface: CatalogSurface, catalog: Catalog, out: CatalogDiagnostic[]): void {
  const at = `/elements/${pointerSegment(id)}`
  if (!isRecord(value) || typeof value.type !== "string" || !isRecord(value.props)) {
    out.push(diagnostic("AGENT_UI_R0001", { problem: `element "${id}" needs a string "type" and a "props" object.` }, at))
    return
  }
  for (const key of Object.keys(value)) {
    if (!elementKeys.has(key)) out.push(diagnostic("AGENT_UI_R0001", { problem: `element "${id}" has the key "${key}". An element has only type, props, children, on, repeat, and visible.` }, `${at}/${pointerSegment(key)}`))
  }
  const children = value.children
  if (children !== undefined) {
    if (!Array.isArray(children) || !children.every(child => typeof child === "string")) {
      out.push(diagnostic("AGENT_UI_R0001", { problem: `the children of "${id}" must be a list of element ids.` }, `${at}/children`))
    }
    else {
      children.forEach((child, index) => {
        if (!Object.hasOwn(elements, child)) out.push(diagnostic("AGENT_UI_R0003", { id: child }, `${at}/children/${index}`))
      })
    }
  }
  const repeat = value.repeat
  const statePath = isRecord(repeat) ? repeat.statePath : undefined
  const listPath = typeof statePath === "string" || (isRecord(statePath) && typeof statePath.$item === "string" && Object.keys(statePath).length === 1)
  if (repeat !== undefined && !(isRecord(repeat) && listPath && (repeat.key === undefined || typeof repeat.key === "string"))) {
    out.push(diagnostic("AGENT_UI_R0001", { problem: `"repeat" of "${id}" must be { "statePath": "/list", "key": "id" }, or { "statePath": { "$item": "field" } } inside another repeat.` }, `${at}/repeat`))
  }

  const entry = Object.hasOwn(catalog.entries, value.type) ? catalog.entries[value.type] : undefined
  if (!entry) {
    out.push(diagnostic("AGENT_UI_R0004", { type: value.type, known: names(entries.keys()) }, `${at}/type`))
    return
  }
  if (!entry.surfaces.includes(surface)) {
    out.push(diagnostic("AGENT_UI_R0005", { type: entry.name, surface, known: names(entries.keys()) }, `${at}/type`))
  }
  if (Array.isArray(children) && children.length && !entry.children) out.push(diagnostic("AGENT_UI_R0009", { type: entry.name }, `${at}/children`))
  const known = propsJsonSchema(entry).names
  for (const prop of Object.keys(value.props)) {
    if (!known.includes(prop)) out.push(diagnostic("AGENT_UI_R0006", { type: entry.name, prop, known: names(known) }, `${at}/props/${pointerSegment(prop)}`))
  }
  if (entry.name === "Form") checkForm(value, value.props, at, surface, catalog, out)

  if (value.on !== undefined) {
    if (!isRecord(value.on)) {
      out.push(diagnostic("AGENT_UI_R0001", { problem: `"on" of "${id}" must map event names to actions.` }, `${at}/on`))
      return
    }
    for (const [event, binding] of Object.entries(value.on)) {
      const eventAt = `${at}/on/${pointerSegment(event)}`
      if (!Object.hasOwn(entry.events, event)) out.push(diagnostic("AGENT_UI_R0008", { type: entry.name, event, known: names(Object.keys(entry.events)) }, eventAt))
      else if (Array.isArray(binding)) {
        if (!binding.length) out.push(diagnostic("AGENT_UI_R0001", { problem: `"on.${event}" of "${id}" is an empty list.` }, eventAt))
        binding.forEach((item, index) => checkBinding(item, `${eventAt}/${index}`, out))
      }
      else checkBinding(binding, eventAt, out)
    }
  }
}

/**
 * Walks the tree from the root once. It reports cycles, depth, and an element that appears in `children` more than once,
 * each problem once. Each element is visited at most once, so a spec that repeats a subtree cannot make the walk grow
 * past the number of elements.
 */
function checkTree(root: string, elements: Record<string, unknown>, out: CatalogDiagnostic[]): void {
  const reported = new Set<string>()
  const visited = new Set<string>([root])
  let tooDeep = false
  const report = (id: string, code: "AGENT_UI_R0012" | "AGENT_UI_R0013") => {
    if (reported.has(id)) return
    reported.add(id)
    out.push(diagnostic(code, { id }, `/elements/${pointerSegment(id)}`))
  }
  const visit = (id: string, ancestors: string[]): void => {
    const element = elements[id]
    if (!isRecord(element) || !Array.isArray(element.children)) return
    for (const child of element.children) {
      if (typeof child !== "string" || !Object.hasOwn(elements, child)) continue
      if (ancestors.includes(child)) {
        report(child, "AGENT_UI_R0012")
        continue
      }
      if (visited.has(child)) {
        report(child, "AGENT_UI_R0013")
        continue
      }
      visited.add(child)
      if (ancestors.length >= maxSpecDepth) {
        if (!tooDeep) out.push(diagnostic("AGENT_UI_R0011", { limit: maxSpecDepth }, `/elements/${pointerSegment(child)}`))
        tooDeep = true
        return
      }
      visit(child, [...ancestors, child])
    }
  }
  visit(root, [root])
}

/**
 * Checks the props of each element after its expressions resolve, as the renderer shows them: once for each item of a
 * `repeat` list, and once with the spec's state for an element that no repeat holds. Runs only on a sound tree.
 */
function checkProps(spec: CatalogSpec, catalog: Catalog, out: CatalogDiagnostic[]): void {
  const seen = new Set<string>()
  const check = (id: string, context: PropResolutionContext) => {
    const element = spec.elements[id]!
    const entry = catalog.entries[element.type]!
    const resolved = resolveElementProps(element.props, context)
    const result = entry.props["~standard"].validate(resolved)
    if (result instanceof Promise) throw asyncProps(entry.name)
    for (const issue of result.issues ?? []) {
      const path = issuePath(issue)
      const found = diagnostic("AGENT_UI_R0007", { type: entry.name, prop: String(path[0] ?? ""), problem: issue.message }, `/elements/${pointerSegment(id)}/props${pointer(path)}`)
      const key = `${found.path}|${found.message}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(found)
    }
  }
  const reached = new Set<string>()
  const walk = (id: string, context: PropResolutionContext) => {
    reached.add(id)
    check(id, context)
    const element = spec.elements[id]!
    const scopes = element.repeat ? repeatScopes(spec, element.repeat.statePath, context) : [context]
    for (const scope of scopes) for (const child of element.children ?? []) walk(child, scope)
  }
  const base: PropResolutionContext = { stateModel: spec.state ?? {} }
  walk(spec.root, base)
  for (const id of Object.keys(spec.elements)) if (!reached.has(id)) check(id, base)
}

function repeatScopes(spec: CatalogSpec, statePath: RepeatStatePath, context: PropResolutionContext): PropResolutionContext[] {
  const base = resolveRepeatStatePath(statePath, context.repeatBasePath)
  const items = base === undefined ? undefined : getByPath(spec.state ?? {}, base)
  if (!Array.isArray(items)) return []
  return items.map((item: unknown, index) => ({ ...context, repeatItem: item, repeatIndex: index, repeatBasePath: `${base}/${index}` }))
}

/**
 * Checks a spec against the catalog for one surface. The diagnostics are plain JSON with stable codes, so an app can send
 * them back to the Agent that wrote the spec. A Form must name a form of the catalog that the surface can draw.
 *
 * @example
 * ```ts
 * const result = validateSpec(spec, { surface: "web", catalog })
 * if (!result.valid) return { error: result.diagnostics }
 * ```
 */
export function validateSpec(spec: unknown, options: ValidateSpecOptions): SpecValidation {
  const catalog = options.catalog ?? viteHubCatalog
  const out: CatalogDiagnostic[] = []
  if (!isRecord(spec) || typeof spec.root !== "string" || !isRecord(spec.elements)) {
    out.push(diagnostic("AGENT_UI_R0001", { problem: "a spec is an object with a string \"root\" and an \"elements\" object." }, ""))
    return { valid: false, diagnostics: out }
  }
  for (const key of Object.keys(spec)) {
    if (!specKeys.has(key)) out.push(diagnostic("AGENT_UI_R0001", { problem: `the spec has the key "${key}". A spec has only version, root, elements, and state.` }, `/${pointerSegment(key)}`))
  }
  if (spec.version !== undefined && spec.version !== specVersion) out.push(diagnostic("AGENT_UI_R0002", { version: JSON.stringify(spec.version) }, "/version"))
  if (spec.state !== undefined && !isRecord(spec.state)) out.push(diagnostic("AGENT_UI_R0001", { problem: "\"state\" must be an object." }, "/state"))

  const ids = Object.keys(spec.elements)
  if (ids.length > maxSpecElements) {
    out.push(diagnostic("AGENT_UI_R0010", { count: ids.length, limit: maxSpecElements }, "/elements"))
    return { valid: false, diagnostics: out }
  }
  if (!Object.hasOwn(spec.elements, spec.root)) out.push(diagnostic("AGENT_UI_R0003", { id: spec.root }, "/root"))

  const entries = new Map(surfaceEntries(catalog, options.surface).map(entry => [entry.name, entry]))
  for (const id of ids) checkElement(id, spec.elements[id], spec.elements, entries, options.surface, catalog, out)
  checkTree(spec.root, spec.elements, out)
  if (out.length) return { valid: false, diagnostics: out }

  // SAFETY: every key, element, binding, and tree link above matched the CatalogSpec shape.
  const checked = spec as unknown as CatalogSpec
  checkProps(checked, catalog, out)
  if (out.length) return { valid: false, diagnostics: out }
  return { valid: true, spec: checked, diagnostics: [] }
}
