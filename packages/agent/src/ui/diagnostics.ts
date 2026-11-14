import { type Diagnostic, defineDiagnostics } from "nostics"

// Each code identifies one failure of an Agent UI spec. Keep published codes stable: Agents and apps match on them.
const uiDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: "https://vitehub.dev/docs/agents/diagnostics",
  codes: {
    // Configuration errors. `defineCatalogEntry()`, `defineCatalog()`, and `checkSpecForm()` throw them.
    /** A catalog entry is invalid. */
    AGENT_UI_C0001: {
      why: ({ entry, problem }: { entry: string, problem: string }) => `The catalog entry ${entry} is invalid: ${problem}`,
      fix: "Give the entry a PascalCase name, a description, an object props schema that implements Standard Schema and Standard JSON Schema (such as a Zod 4 object), camelCase event names, a positive integer version, and at least one surface out of web, mcp, chatCard, and chatModal.",
    },
    /** Two entries of one catalog have the same name. */
    AGENT_UI_C0002: {
      why: ({ entry }: { entry: string }) => `The catalog has two entries named ${entry}.`,
      fix: "Give each entry its own name. To replace a built-in entry, leave the built-in one out of the list that you pass to `defineCatalog()`.",
    },
    /** A props schema validated asynchronously. */
    AGENT_UI_C0003: {
      why: ({ entry }: { entry: string }) => `The props schema of ${entry} returned a Promise. Spec validation is synchronous.`,
      fix: "Use a props schema without async refinements or transforms.",
    },
    /** `checkSpecForm()` got an element that is not a Form of a known form. */
    AGENT_UI_C0004: {
      why: ({ id, problem }: { id: string, problem: string }) => `The spec element "${id}" is not a Form that the catalog can check: ${problem}`,
      fix: "Pass the id of a Form element of a spec that `validateSpec()` accepted, with the same catalog.",
    },
    // Runtime errors. `validateSpec()` returns them. Each one goes back to the Agent that wrote the spec.
    /** The spec, or one of its elements, has the wrong shape. */
    AGENT_UI_R0001: {
      why: ({ problem }: { problem: string }) => `The spec has the wrong shape: ${problem}`,
      fix: "Write `{ \"root\": \"<id>\", \"elements\": { \"<id>\": { \"type\": \"<Component>\", \"props\": {} } } }`. An element can also have `children` (a list of element ids) and `on` (`{ \"<event>\": { \"action\": \"event\", \"params\": { \"name\": \"<name>\" } } }`). The spec can also have `version` and `state`.",
    },
    /** The spec has a version that this catalog does not read. */
    AGENT_UI_R0002: {
      why: ({ version }: { version: string }) => `The spec has version ${version}. This catalog reads version 1.`,
      fix: "Set `version` to 1, or leave it out.",
    },
    /** The root or a child names an element that the spec does not have. */
    AGENT_UI_R0003: {
      why: ({ id }: { id: string }) => `The spec has no element "${id}".`,
      fix: "Add the element to `elements`, or remove its id from `root` or `children`.",
    },
    /** An element has a type that the catalog does not have. */
    AGENT_UI_R0004: {
      why: ({ type, known }: { type: string, known: string }) => `The catalog has no component "${type}". Use one of: ${known}.`,
      fix: "Use a component of the catalog. To ask for values, use a Form that names a form of the catalog. An app adds its own components with `defineCatalog()`.",
    },
    /** An element has a component that the surface does not support. */
    AGENT_UI_R0005: {
      why: ({ type, surface, known }: { type: string, surface: string, known: string }) => `${type} does not render on the ${surface} surface. Use one of: ${known}.`,
      fix: "Use only the components of the surface. A posted chat card (chatCard) has no inputs: put a Form in a chat modal (chatModal).",
    },
    /** An element has a prop that its component does not have. */
    AGENT_UI_R0006: {
      why: ({ type, prop, known }: { type: string, prop: string, known: string }) => `${type} has no prop "${prop}". Its props are: ${known}.`,
      fix: "Remove the prop, or use a prop of the component.",
    },
    /** A prop has a value that its component does not accept. */
    AGENT_UI_R0007: {
      why: ({ type, prop, problem }: { type: string, prop: string, problem: string }) => `${type} prop "${prop}" is invalid: ${problem}`,
      fix: "Give the prop a value of the type that the catalog lists for it.",
    },
    /** An element binds an event that its component does not emit. */
    AGENT_UI_R0008: {
      why: ({ type, event, known }: { type: string, event: string, known: string }) => `${type} has no event "${event}". Its events are: ${known}.`,
      fix: "Bind only the events of the component in `on`.",
    },
    /** An element without children support has children. */
    AGENT_UI_R0009: {
      why: ({ type }: { type: string }) => `${type} takes no children.`,
      fix: "Remove `children` from the element, or move the children into a component that takes them, such as Stack or Card.",
    },
    /** The spec has more elements than the limit. */
    AGENT_UI_R0010: {
      why: ({ count, limit }: { count: number, limit: number }) => `The spec has ${count} elements. The limit is ${limit}.`,
      fix: "Send fewer elements. Put long lists in one Table, or split the UI into more than one spec.",
    },
    /** The element tree is deeper than the limit. */
    AGENT_UI_R0011: {
      why: ({ limit }: { limit: number }) => `The element tree is more than ${limit} levels deep.`,
      fix: "Nest fewer containers.",
    },
    /** An element contains itself. */
    AGENT_UI_R0012: {
      why: ({ id }: { id: string }) => `The element "${id}" contains itself through its children.`,
      fix: "Make the elements a tree: an element cannot be its own child or the child of a child.",
    },
    /** An element appears in `children` more than once. */
    AGENT_UI_R0013: {
      why: ({ id }: { id: string }) => `The element "${id}" appears in children more than once.`,
      fix: "Use each element id once in `children`. To show the same content twice, add a second element with its own id.",
    },
    /** An event binds an action that the catalog does not have. */
    AGENT_UI_R0014: {
      why: ({ action, known }: { action: string, known: string }) => `The spec binds the action "${action}". Use one of: ${known}.`,
      fix: "Send an event to the Agent with `{ \"action\": \"event\", \"params\": { \"name\": \"<name>\", \"context\": {} } }`.",
    },
    /** A Form names a form that the catalog does not have. */
    AGENT_UI_R0015: {
      why: ({ form, known }: { form: string, known: string }) => `The catalog has no form "${form}". Use one of: ${known}.`,
      fix: "Name a form that the app passes to `defineCatalog(entries, { forms })`.",
    },
    /** A Form names a form that the surface cannot draw. */
    AGENT_UI_R0016: {
      why: ({ form, surface, problem }: { form: string, surface: string, problem: string }) => `The form "${form}" does not render on the ${surface} surface: ${problem}`,
      fix: "Send the form on a surface that can draw its fields, or give the form fields of text, numbers, true or false, and choices of text.",
    },
  },
})

/** A stable code of the Agent UI diagnostics that `validateSpec()` returns. */
export type CatalogDiagnosticCode
  = | "AGENT_UI_R0001" | "AGENT_UI_R0002" | "AGENT_UI_R0003" | "AGENT_UI_R0004" | "AGENT_UI_R0005" | "AGENT_UI_R0006"
    | "AGENT_UI_R0007" | "AGENT_UI_R0008" | "AGENT_UI_R0009" | "AGENT_UI_R0010" | "AGENT_UI_R0011" | "AGENT_UI_R0012"
    | "AGENT_UI_R0013" | "AGENT_UI_R0014" | "AGENT_UI_R0015" | "AGENT_UI_R0016"

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
  AGENT_UI_R0001: { problem: string }
  AGENT_UI_R0002: { version: string }
  AGENT_UI_R0003: { id: string }
  AGENT_UI_R0004: { type: string, known: string }
  AGENT_UI_R0005: { type: string, surface: string, known: string }
  AGENT_UI_R0006: { type: string, prop: string, known: string }
  AGENT_UI_R0007: { type: string, prop: string, problem: string }
  AGENT_UI_R0008: { type: string, event: string, known: string }
  AGENT_UI_R0009: { type: string }
  AGENT_UI_R0010: { count: number, limit: number }
  AGENT_UI_R0011: { limit: number }
  AGENT_UI_R0012: { id: string }
  AGENT_UI_R0013: { id: string }
  AGENT_UI_R0014: { action: string, known: string }
  AGENT_UI_R0015: { form: string, known: string }
  AGENT_UI_R0016: { form: string, surface: string, problem: string }
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
  return uiDiagnostics.AGENT_UI_C0001({ entry, problem })
}

/** The error that catalog definition throws for a repeated entry name. */
export function duplicateEntry(entry: string): Error {
  return uiDiagnostics.AGENT_UI_C0002({ entry })
}

/** The error that spec validation throws when a props schema is asynchronous. */
export function asyncProps(entry: string): Error {
  return uiDiagnostics.AGENT_UI_C0003({ entry })
}

/** The error that `checkSpecForm()` throws for an element that is not a Form of a known form. */
export function notAForm(id: string, problem: string): Error {
  return uiDiagnostics.AGENT_UI_C0004({ id, problem })
}

/** Escapes one JSON Pointer segment. */
export function pointerSegment(segment: string | number): string {
  return String(segment).replaceAll("~", "~0").replaceAll("/", "~1")
}
