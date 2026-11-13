import { type Catalog, type CatalogEntry, type CatalogSurface, isRecord, propsJsonSchema, surfaceEntries } from "./define.ts";
import { asyncProps, type CatalogDiagnostic, diagnostic, pointerSegment } from "./diagnostics.ts";
import { viteHubCatalog } from "./entries.ts";
import type { StandardSchemaV1 } from "./standard-schema.ts";

/** The spec format version that this catalog reads and writes. */
export const specVersion = 1;

/** The most elements that one spec may have. The Console uses the same limit. */
export const maxSpecElements = 128;

/** The deepest that the element tree of one spec may be. The Console uses the same limit. */
export const maxSpecDepth = 20;

/** An action that an event sends, such as `{ "action": "approve", "params": { "note": { "$state": "/note" } } }`. */
export interface SpecActionBinding {
  action: string;
  params?: Record<string, unknown>;
}

/** One element of a spec. */
export interface SpecElement {
  /** The name of a catalog entry. */
  type: string;
  props: Record<string, unknown>;
  /** Element ids, in order. */
  children?: string[];
  /** The actions that the element's events send. */
  on?: Record<string, SpecActionBinding | SpecActionBinding[]>;
}

/** A UI spec in the json-render format: a flat map of elements and the id of the root element. */
export interface CatalogSpec {
  /** The spec format version. Saved specs carry it, so a later format can migrate them. */
  version?: typeof specVersion;
  root: string;
  elements: Record<string, SpecElement>;
  /** The first values of the state that inputs bind to and props read. */
  state?: Record<string, unknown>;
}

export interface ValidateSpecOptions {
  /** The surface where the spec renders. Components that do not render there fail with `KIT_R0005`. */
  surface: CatalogSurface;
  /** The catalog to check against. The built-in catalog by default. */
  catalog?: Catalog;
}

/** The result of `validateSpec()`. */
export type SpecValidation
  = | { valid: true; spec: CatalogSpec; diagnostics: [] }
    | { valid: false; diagnostics: CatalogDiagnostic[] };

const specKeys = new Set(["version", "root", "elements", "state"]);
const elementKeys = new Set(["type", "props", "children", "on"]);
const bindingKeys = new Set(["action", "params"]);

function names(values: Iterable<string>): string {
  const list = [...values];
  return list.length ? list.join(", ") : "none";
}

function issuePath(issue: StandardSchemaV1.Issue): (string | number)[] {
  return (issue.path ?? []).map((segment) => {
    const key = typeof segment === "object" ? segment.key : segment;
    return typeof key === "number" ? key : String(key);
  });
}

function checkBinding(value: unknown): boolean {
  return isRecord(value)
    && typeof value.action === "string"
    && value.action.length > 0
    && (value.params === undefined || isRecord(value.params))
    && Object.keys(value).every(key => bindingKeys.has(key));
}

function checkElement(id: string, value: unknown, spec: Record<string, unknown>, entries: Map<string, CatalogEntry>, surface: CatalogSurface, catalog: Catalog, out: CatalogDiagnostic[]): void {
  const at = `/elements/${pointerSegment(id)}`;
  if (!isRecord(value) || typeof value.type !== "string" || !isRecord(value.props)) {
    out.push(diagnostic("KIT_R0001", { problem: `element "${id}" needs a string "type" and a "props" object.` }, at));
    return;
  }
  for (const key of Object.keys(value)) {
    if (!elementKeys.has(key)) out.push(diagnostic("KIT_R0001", { problem: `element "${id}" has the key "${key}". An element has only type, props, children, and on.` }, `${at}/${pointerSegment(key)}`));
  }
  const elements = spec.elements;
  const children = value.children;
  if (children !== undefined) {
    if (!Array.isArray(children) || !children.every(child => typeof child === "string")) {
      out.push(diagnostic("KIT_R0001", { problem: `the children of "${id}" must be a list of element ids.` }, `${at}/children`));
    }
    else {
      children.forEach((child, index) => {
        if (!isRecord(elements) || !Object.hasOwn(elements, child)) out.push(diagnostic("KIT_R0003", { id: child }, `${at}/children/${index}`));
      });
    }
  }

  const entry = Object.hasOwn(catalog.entries, value.type) ? catalog.entries[value.type] : undefined;
  if (!entry) {
    out.push(diagnostic("KIT_R0004", { type: value.type, known: names(entries.keys()) }, `${at}/type`));
    return;
  }
  if (!entry.surfaces.includes(surface)) {
    out.push(diagnostic("KIT_R0005", { type: entry.name, surface, known: names(entries.keys()) }, `${at}/type`));
  }
  if (Array.isArray(children) && children.length && !entry.children) out.push(diagnostic("KIT_R0009", { type: entry.name }, `${at}/children`));

  const known = propsJsonSchema(entry).names;
  const props: Record<string, unknown> = {};
  for (const [prop, propValue] of Object.entries(value.props)) {
    if (known.includes(prop)) props[prop] = propValue;
    else out.push(diagnostic("KIT_R0006", { type: entry.name, prop, known: names(known) }, `${at}/props/${pointerSegment(prop)}`));
  }
  const result = entry.props["~standard"].validate(props);
  if (result instanceof Promise) throw asyncProps(entry.name);
  for (const issue of result.issues ?? []) {
    const path = issuePath(issue);
    out.push(diagnostic("KIT_R0007", { type: entry.name, prop: String(path[0] ?? ""), problem: issue.message }, `${at}/props${path.map(segment => `/${pointerSegment(segment)}`).join("")}`));
  }

  if (value.on !== undefined) {
    if (!isRecord(value.on)) {
      out.push(diagnostic("KIT_R0001", { problem: `"on" of "${id}" must map event names to actions.` }, `${at}/on`));
      return;
    }
    for (const [event, binding] of Object.entries(value.on)) {
      const eventAt = `${at}/on/${pointerSegment(event)}`;
      if (!Object.hasOwn(entry.events, event)) out.push(diagnostic("KIT_R0008", { type: entry.name, event, known: names(Object.keys(entry.events)) }, eventAt));
      else if (!(Array.isArray(binding) ? binding.length > 0 && binding.every(checkBinding) : checkBinding(binding))) {
        out.push(diagnostic("KIT_R0001", { problem: `"on.${event}" of "${id}" must be { "action": "<name>", "params": {} } or a list of them.` }, eventAt));
      }
    }
  }
}

/**
 * Walks the tree from the root once. It reports cycles, depth, and an element that appears in `children` more than once,
 * each problem once. Each element is visited at most once, so a spec that repeats a subtree cannot make the walk grow
 * past the number of elements.
 */
function checkTree(root: string, elements: Record<string, unknown>, out: CatalogDiagnostic[]): void {
  const reported = new Set<string>();
  const visited = new Set<string>([root]);
  let tooDeep = false;
  const report = (id: string, code: "KIT_R0012" | "KIT_R0015") => {
    if (reported.has(id)) return;
    reported.add(id);
    out.push(diagnostic(code, { id }, `/elements/${pointerSegment(id)}`));
  };
  const visit = (id: string, ancestors: string[]): void => {
    const element = elements[id];
    if (!isRecord(element) || !Array.isArray(element.children)) return;
    for (const child of element.children) {
      if (typeof child !== "string" || !Object.hasOwn(elements, child)) continue;
      if (ancestors.includes(child)) {
        report(child, "KIT_R0012");
        continue;
      }
      if (visited.has(child)) {
        report(child, "KIT_R0015");
        continue;
      }
      visited.add(child);
      if (ancestors.length >= maxSpecDepth) {
        if (!tooDeep) out.push(diagnostic("KIT_R0011", { limit: maxSpecDepth }, `/elements/${pointerSegment(child)}`));
        tooDeep = true;
        return;
      }
      visit(child, [...ancestors, child]);
    }
  };
  visit(root, [root]);
}

/**
 * Checks a spec against the catalog for one surface. The diagnostics are plain JSON with stable codes, so an app can send
 * them back to the Agent that wrote the spec.
 *
 * @example
 * ```ts
 * const result = validateSpec(spec, { surface: "chatModal" });
 * if (!result.valid) return { error: result.diagnostics };
 * ```
 */
export function validateSpec(spec: unknown, options: ValidateSpecOptions): SpecValidation {
  const catalog = options.catalog ?? viteHubCatalog;
  const out: CatalogDiagnostic[] = [];
  if (!isRecord(spec) || typeof spec.root !== "string" || !isRecord(spec.elements)) {
    out.push(diagnostic("KIT_R0001", { problem: "a spec is an object with a string \"root\" and an \"elements\" object." }, ""));
    return { valid: false, diagnostics: out };
  }
  for (const key of Object.keys(spec)) {
    if (!specKeys.has(key)) out.push(diagnostic("KIT_R0001", { problem: `the spec has the key "${key}". A spec has only version, root, elements, and state.` }, `/${pointerSegment(key)}`));
  }
  if (spec.version !== undefined && spec.version !== specVersion) out.push(diagnostic("KIT_R0002", { version: JSON.stringify(spec.version) }, "/version"));
  if (spec.state !== undefined && !isRecord(spec.state)) out.push(diagnostic("KIT_R0001", { problem: "\"state\" must be an object." }, "/state"));

  const ids = Object.keys(spec.elements);
  if (ids.length > maxSpecElements) {
    out.push(diagnostic("KIT_R0010", { count: ids.length, limit: maxSpecElements }, "/elements"));
    return { valid: false, diagnostics: out };
  }
  if (!Object.hasOwn(spec.elements, spec.root)) out.push(diagnostic("KIT_R0003", { id: spec.root }, "/root"));

  const entries = new Map(surfaceEntries(catalog, options.surface).map(entry => [entry.name, entry]));
  for (const id of ids) checkElement(id, spec.elements[id], spec, entries, options.surface, catalog, out);
  checkTree(spec.root, spec.elements, out);

  if (out.length) return { valid: false, diagnostics: out };
  // SAFETY: every key, element, binding, and prop above matched the CatalogSpec shape and the catalog schemas.
  return { valid: true, spec: spec as unknown as CatalogSpec, diagnostics: [] };
}
