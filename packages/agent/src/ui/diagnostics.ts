import { type Diagnostic, defineDiagnostics } from "nostics"

// Each code identifies one failure of an Agent UI spec. Keep published codes stable: Agents and apps match on them.
const uiDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: "https://vitehub.dev/docs/agents/diagnostics",
  codes: {
    // Configuration errors. `defineCatalogEntry()`, `defineCatalog()`, and `checkSpecForm()` throw them.
    /** Two entries of one catalog have the same name. */
    AGENT_UI_ENTRY_DUPLICATE: {
      why: ({ entry }: { entry: string }) => `The catalog has two entries named ${entry}.`,
      fix: "Give each entry its own name. To replace a built-in entry, leave the built-in one out of the list that you pass to `defineCatalog()`.",
    },
    /** A catalog entry is invalid. */
    AGENT_UI_ENTRY_INVALID: {
      why: ({ entry, problem }: { entry: string, problem: string }) => `The catalog entry ${entry} is invalid: ${problem}`,
      fix: "Give the entry a PascalCase name, a description, an object props schema that implements Standard Schema and Standard JSON Schema (such as a Zod 4 object), camelCase event names, a positive integer version, and at least one surface out of web, mcp, chatCard, and chatModal.",
    },
    /** `checkSpecForm()` got an element that is not a Form of a known form. */
    AGENT_UI_NOT_A_FORM: {
      why: ({ id, problem }: { id: string, problem: string }) => `The spec element "${id}" is not a Form that the catalog can check: ${problem}`,
      fix: "Pass the id of a Form element of a spec that `validateSpec()` accepted, with the same catalog.",
    },
    /** A props schema validated asynchronously. */
    AGENT_UI_PROPS_ASYNC: {
      why: ({ entry }: { entry: string }) => `The props schema of ${entry} returned a Promise. Spec validation is synchronous.`,
      fix: "Use a props schema without async refinements or transforms.",
    },
    // Runtime errors. `validateSpec()` returns them. Each one goes back to the Agent that wrote the spec.
    /** An event binds an action that the catalog does not have. */
    AGENT_UI_ACTION_UNKNOWN: {
      why: ({ action, known }: { action: string, known: string }) => `The spec binds the action "${action}". Use one of: ${known}.`,
      fix: "Send an event to the Agent with `{ \"action\": \"event\", \"params\": { \"name\": \"<name>\", \"context\": {} } }`.",
    },
    /** An element without children support has children. */
    AGENT_UI_CHILDREN_NOT_ALLOWED: {
      why: ({ type }: { type: string }) => `${type} takes no children.`,
      fix: "Remove `children` from the element, or move the children into a component that takes them, such as Stack or Card.",
    },
    /** An element has a component that the surface does not support. */
    AGENT_UI_COMPONENT_NOT_ON_SURFACE: {
      why: ({ type, surface, known }: { type: string, surface: string, known: string }) => `${type} does not render on the ${surface} surface. Use one of: ${known}.`,
      fix: "Use only the components of the surface. A posted chat card (chatCard) has no inputs: put a Form in a chat modal (chatModal).",
    },
    /** An element has a type that the catalog does not have. */
    AGENT_UI_COMPONENT_UNKNOWN: {
      why: ({ type, known }: { type: string, known: string }) => `The catalog has no component "${type}". Use one of: ${known}.`,
      fix: "Use a component of the catalog. To ask for values, use a Form that names a form of the catalog. An app adds its own components with `defineCatalog()`.",
    },
    /** An element contains itself. */
    AGENT_UI_ELEMENT_CYCLE: {
      why: ({ id }: { id: string }) => `The element "${id}" contains itself through its children.`,
      fix: "Make the elements a tree: an element cannot be its own child or the child of a child.",
    },
    /** The root or a child names an element that the spec does not have. */
    AGENT_UI_ELEMENT_NOT_FOUND: {
      why: ({ id }: { id: string }) => `The spec has no element "${id}".`,
      fix: "Add the element to `elements`, or remove its id from `root` or `children`.",
    },
    /** An element appears in `children` more than once. */
    AGENT_UI_ELEMENT_REPEATED: {
      why: ({ id }: { id: string }) => `The element "${id}" appears in children more than once.`,
      fix: "Use each element id once in `children`. To show the same content twice, add a second element with its own id.",
    },
    /** An element binds an event that its component does not emit. */
    AGENT_UI_EVENT_UNKNOWN: {
      why: ({ type, event, known }: { type: string, event: string, known: string }) => `${type} has no event "${event}". Its events are: ${known}.`,
      fix: "Bind only the events of the component in `on`.",
    },
    /** A Form names a form that the surface cannot draw. */
    AGENT_UI_FORM_NOT_ON_SURFACE: {
      why: ({ form, surface, problem }: { form: string, surface: string, problem: string }) => `The form "${form}" does not render on the ${surface} surface: ${problem}`,
      fix: "Send the form on a surface that can draw its fields, or give the form fields of text, numbers, true or false, and choices of text.",
    },
    /** A Form names a form that the catalog does not have. */
    AGENT_UI_FORM_UNKNOWN: {
      why: ({ form, known }: { form: string, known: string }) => `The catalog has no form "${form}". Use one of: ${known}.`,
      fix: "Name a form that the app passes to `defineCatalog(entries, { forms })`.",
    },
    /** A prop has a value that its component does not accept. */
    AGENT_UI_PROP_INVALID: {
      why: ({ type, prop, problem }: { type: string, prop: string, problem: string }) => `${type} prop "${prop}" is invalid: ${problem}`,
      fix: "Give the prop a value of the type that the catalog lists for it.",
    },
    /** An element has a prop that its component does not have. */
    AGENT_UI_PROP_UNKNOWN: {
      why: ({ type, prop, known }: { type: string, prop: string, known: string }) => `${type} has no prop "${prop}". Its props are: ${known}.`,
      fix: "Remove the prop, or use a prop of the component.",
    },
    /** The spec, or one of its elements, has the wrong shape. */
    AGENT_UI_SPEC_INVALID: {
      why: ({ problem }: { problem: string }) => `The spec has the wrong shape: ${problem}`,
      fix: "Write `{ \"root\": \"<id>\", \"elements\": { \"<id>\": { \"type\": \"<Component>\", \"props\": {} } } }`. An element can also have `children` (a list of element ids) and `on` (`{ \"<event>\": { \"action\": \"event\", \"params\": { \"name\": \"<name>\" } } }`). The spec can also have `version` and `state`.",
    },
    /** The element tree is deeper than the limit. */
    AGENT_UI_TOO_DEEP: {
      why: ({ limit }: { limit: number }) => `The element tree is more than ${limit} levels deep.`,
      fix: "Nest fewer containers.",
    },
    /** The spec has more elements than the limit. */
    AGENT_UI_TOO_MANY_ELEMENTS: {
      why: ({ count, limit }: { count: number, limit: number }) => `The spec has ${count} elements. The limit is ${limit}.`,
      fix: "Send fewer elements. Put long lists in one Table, or split the UI into more than one spec.",
    },
    /** The spec has a version that this catalog does not read. */
    AGENT_UI_VERSION_UNSUPPORTED: {
      why: ({ version }: { version: string }) => `The spec has version ${version}. This catalog reads version 1.`,
      fix: "Set `version` to 1, or leave it out.",
    },
  },
})

/** A stable code of the Agent UI diagnostics that `validateSpec()` returns. */
export type CatalogDiagnosticCode
  = | "AGENT_UI_ACTION_UNKNOWN" | "AGENT_UI_CHILDREN_NOT_ALLOWED" | "AGENT_UI_COMPONENT_NOT_ON_SURFACE"
    | "AGENT_UI_COMPONENT_UNKNOWN" | "AGENT_UI_ELEMENT_CYCLE" | "AGENT_UI_ELEMENT_NOT_FOUND"
    | "AGENT_UI_ELEMENT_REPEATED" | "AGENT_UI_EVENT_UNKNOWN" | "AGENT_UI_FORM_NOT_ON_SURFACE"
    | "AGENT_UI_FORM_UNKNOWN" | "AGENT_UI_PROP_INVALID" | "AGENT_UI_PROP_UNKNOWN"
    | "AGENT_UI_SPEC_INVALID" | "AGENT_UI_TOO_DEEP" | "AGENT_UI_TOO_MANY_ELEMENTS"
    | "AGENT_UI_VERSION_UNSUPPORTED"

/** One problem in a spec. It is plain JSON, so an app can send it back to the Agent that wrote the spec as it is. */
export interface CatalogDiagnostic {
  code: CatalogDiagnosticCode
  message: string
  fix: string
  docs: string
  /** JSON Pointer to the part of the spec with the problem, such as `/elements/invite/props/form`. */
  path: string
}

/** The parameters of each code. */
interface DiagnosticParams {
  AGENT_UI_ACTION_UNKNOWN: { action: string, known: string }
  AGENT_UI_CHILDREN_NOT_ALLOWED: { type: string }
  AGENT_UI_COMPONENT_NOT_ON_SURFACE: { type: string, surface: string, known: string }
  AGENT_UI_COMPONENT_UNKNOWN: { type: string, known: string }
  AGENT_UI_ELEMENT_CYCLE: { id: string }
  AGENT_UI_ELEMENT_NOT_FOUND: { id: string }
  AGENT_UI_ELEMENT_REPEATED: { id: string }
  AGENT_UI_EVENT_UNKNOWN: { type: string, event: string, known: string }
  AGENT_UI_FORM_NOT_ON_SURFACE: { form: string, surface: string, problem: string }
  AGENT_UI_FORM_UNKNOWN: { form: string, known: string }
  AGENT_UI_PROP_INVALID: { type: string, prop: string, problem: string }
  AGENT_UI_PROP_UNKNOWN: { type: string, prop: string, known: string }
  AGENT_UI_SPEC_INVALID: { problem: string }
  AGENT_UI_TOO_DEEP: { limit: number }
  AGENT_UI_TOO_MANY_ELEMENTS: { count: number, limit: number }
  AGENT_UI_VERSION_UNSUPPORTED: { version: string }
}

/** Builds the plain diagnostic of `code` at `path`. */
export function diagnostic<Code extends CatalogDiagnosticCode>(code: Code, params: DiagnosticParams[Code], path: string): CatalogDiagnostic {
  // SAFETY: `code` picks one handle, and `params` has the parameter type of that handle.
  const create = uiDiagnostics[code] as unknown as (params: DiagnosticParams[Code]) => Diagnostic<unknown>
  const built = create(params)
  return { code, message: built.message, fix: built.fix ?? "", docs: built.docs ?? "", path }
}

/** The error that catalog definition throws for an invalid entry. */
export function invalidEntry(entry: string, problem: string): Error {
  return uiDiagnostics.AGENT_UI_ENTRY_INVALID({ entry, problem })
}

/** The error that catalog definition throws for a repeated entry name. */
export function duplicateEntry(entry: string): Error {
  return uiDiagnostics.AGENT_UI_ENTRY_DUPLICATE({ entry })
}

/** The error that spec validation throws when a props schema is asynchronous. */
export function asyncProps(entry: string): Error {
  return uiDiagnostics.AGENT_UI_PROPS_ASYNC({ entry })
}

/** The error that `checkSpecForm()` throws for an element that is not a Form of a known form. */
export function notAForm(id: string, problem: string): Error {
  return uiDiagnostics.AGENT_UI_NOT_A_FORM({ id, problem })
}

/** Escapes one JSON Pointer segment. */
export function pointerSegment(segment: string | number): string {
  return String(segment).replaceAll("~", "~0").replaceAll("/", "~1")
}
