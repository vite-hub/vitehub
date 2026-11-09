import { internalErrorDiagnostics } from "./error-diagnostics.ts"
import { standardJsonSchema } from "./standard-schema.ts"
import { withValibotJsonSchema } from "./valibot.ts"

import type { StandardSchemaV1 } from "@standard-schema/spec"

// The definition contract of an operation. `@vite-hub/runtime/operations` publishes it, so it must not import Node
// or build code. The registry, the RPC, and the CLI live in `./operations.ts`.

/** `read` never changes state. `write` changes state. `destructive` deletes or publishes. */
export type OperationKind = "read" | "write" | "destructive"

/** The signed-in user of a call. */
export interface OperationUser {
  id: string
  name?: string
  email?: string
  image?: string
  [key: string]: unknown
}

/** The Agent Actor when an agent calls through a capability or MCP on behalf of a user. */
export interface OperationActor {
  id: string
  kind?: string
  label?: string
  meta?: object
}

/** The checked Console access of a call. `vite-hub` issues it. `ConsoleAccess` has this shape. */
export interface OperationAccess {
  readonly mode: string
  /**
   * The sections that the call may use. `"all"` when no section filter applies. An entry is a section id (`"kv"`, every
   * operation of the section), `"<section>:read"` (only the operations that read), or `"<section>:<scope>"` (only the
   * calls of a scoped operation for that scope, such as `"blob:media"` for one Blob store). `"<section>:<scope>:read"`
   * allows only the reads of that scope.
   */
  readonly sections: "all" | readonly string[]
  readonly user?: OperationUser
}

export interface OperationContext {
  /** The checked Console access of the call. */
  access: OperationAccess
  /** The signed-in user, or null. */
  user: OperationUser | null
  /** The Agent Actor when an agent calls on behalf of `user`. */
  actor?: OperationActor
  surface: "console" | "cli" | "mcp" | "agent"
  /** Set by the host from generated build identity, never from request input or runtime NODE_ENV. */
  development?: boolean
  env?: Record<string, unknown>
  waitUntil?: (task: Promise<unknown>) => void
  request?: Request
  /**
   * The server event of the HTTP request that carries the call, such as an H3 event, when there is one. Operations
   * hand it to app hooks that read the request's own session, such as `identify` of Comments.
   */
  event?: unknown
  /** Operations set a success status here, such as 202 for an accepted call. */
  response?: { status?: number }
  /**
   * An agent or an MCP client may pass `lease: "override"` to `content.save`, `content.remove`, and `content.restore`
   * only when the developer allowed it. Defaults to false, so a model cannot take over a document that a person is editing.
   */
  overrideLeases?: boolean
  /**
   * What an Agent may read of the Channel conversations, set by `operations({ conversations })`. `participant`: only the
   * threads that the Actor takes part in. `all`: every thread. Unset: none.
   */
  conversations?: "all" | "participant"
}

export interface OperationDefinition<Input, Output> {
  /** `<section>.<verb>`, such as `content.publish`. Unique per app. */
  name: string
  /** One sentence. Becomes the CLI help line and the MCP tool description. */
  description: string
  /**
   * Console section that grants access, such as `content`. `false`: any Console user. A function reads the section
   * from the input, for operations that serve several sections. Section ids cannot contain `:`; it is reserved for
   * scope and read-only grants. A function that returns an invalid id denies the call.
   */
  section: string | false | ((input: Input) => string | undefined)
  /**
   * The part of a string `section` that one call uses, such as the Blob store that the input names. The call then needs
   * the section (every scope) or `"<section>:<scope>"` (only this scope). A scope that is empty, is `read`, or has a
   * `:` needs the whole section.
   */
  scope?: (input: Input) => string | undefined
  /** `read` never changes state. `write` changes state. `destructive` deletes or publishes; the CLI asks for `--yes`, MCP marks `destructiveHint`, agents require approval by default. */
  kind: OperationKind
  /** Standard Schema (valibot in this repo). Its Standard JSON Schema builds CLI flags and the MCP input schema. */
  input: StandardSchemaV1<unknown, Input>
  output?: StandardSchemaV1<unknown, Output>
  cli?: {
    /** Defaults: namespace = section, command = verb. */
    namespace?: string
    /** A space groups commands: `jobs list` and `jobs show` run as `vitehub <namespace> jobs list` and `jobs show`. */
    command?: string
    /** Input keys read from positional arguments, in order. */
    positional?: string[]
    /** Human output, written verbatim. Without it the CLI prints JSON. `--json` always prints JSON. */
    format?: (output: Output) => string
    /** `vitehub <namespace>` runs this command when no command is named, such as `vitehub usage`. */
    default?: boolean
    /**
     * Route of the app that takes a signed dispatch of this operation, such as `/_vitehub/schedules/run`. With `--url`
     * and a dispatch key in the environment (`VITEHUB_DISPATCH_KEY`), the command signs the input and posts it there, so
     * a CI job needs no Console credentials. Without a key it calls the RPC.
     */
    dispatch?: string
  }
  /** Largest request body in bytes. It can raise the 64 KiB default but not lower it. */
  maxRequestBytes?: number
  /**
   * Returns true when this call only reads, such as a dry run of a `destructive` operation. The CLI then skips the
   * confirmation, and agents run it without approval. Without it, every call of a `destructive` operation asks.
   */
  readOnlyWhen?: (input: Input) => boolean
  /** `false`: MCP does not offer the operation as a tool, such as an editor transport that only the Console uses. */
  mcp?: false
  /** `false`: the operation never reads `context.user`, so the Console skips the session lookup for it. */
  user?: false
  /**
   * The operation runs code of the app, such as a workflow, a job, a task, or a schedule. The Console registers it only
   * when `console.invoke` is on, which is the default in development and off in a production build.
   */
  invoke?: true
  run: (input: Input, context: OperationContext) => Output | Promise<Output>
}

/** An operation of any input and output, as a registry holds it. */
export interface AnyOperation extends Omit<OperationDefinition<unknown, unknown>, "cli" | "input" | "output" | "readOnlyWhen" | "run" | "scope" | "section"> {
  readOnlyWhen?: (input: never) => boolean
  cli?: { namespace?: string, command?: string, default?: boolean, dispatch?: string, positional?: string[], format?: (output: never) => string }
  input: StandardSchemaV1
  output?: StandardSchemaV1
  run: (input: never, context: OperationContext) => unknown
  scope?: (input: never) => string | undefined
  section: string | false | ((input: never) => string | undefined)
}

/** The fields every surface reports for a failed call. */
export interface OperationFailure {
  code: string
  message: string
  fix?: string
  docs?: string
  details?: Record<string, unknown>
  status: number
}

export type OperationResult<Output = unknown> =
  | { ok: true, value: Output }
  | ({ ok: false } & OperationFailure)

const nameFormat = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/
const kinds: ReadonlySet<string> = new Set<OperationKind>(["read", "write", "destructive"])

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && Object(value) === value && !Array.isArray(value)
}

export function invalidDefinition(name: unknown, reason: string): Error {
  return internalErrorDiagnostics.INTERNAL_R0020({ message: `[vitehub] Operation ${JSON.stringify(name)} is invalid: ${reason}` })
}

function checkDefinition(definition: unknown): void {
  if (!isObject(definition)) throw invalidDefinition(undefined, "defineOperation() takes an object.")
  const { name } = definition
  if (String(name) !== name || !nameFormat.test(name)) throw invalidDefinition(name, "the name must look like `section.verb`, in lower case.")
  if (String(definition.description) !== definition.description || !definition.description) throw invalidDefinition(name, "add a one sentence description.")
  const { section } = definition
  if (section !== false && !(section instanceof Function) && !isSectionId(section)) throw invalidDefinition(name, "section must be a Console section id, a function, or false; section ids cannot contain ':'.")
  if (definition.scope !== undefined && (!(definition.scope instanceof Function) || String(section) !== section)) throw invalidDefinition(name, "scope must be a function, and it needs a section id.")
  if (!kinds.has(String(definition.kind))) throw invalidDefinition(name, 'kind must be "read", "write", or "destructive".')
  const input = definition.input
  if (!isObject(input) || !isObject(input["~standard"]) || !(input["~standard"].validate instanceof Function)) throw invalidDefinition(name, "input must be a Standard Schema, such as a valibot object.")
  if (!(definition.run instanceof Function)) throw invalidDefinition(name, "run must be a function.")
  const { maxRequestBytes } = definition
  if (maxRequestBytes !== undefined && (!Number.isInteger(maxRequestBytes) || Number(maxRequestBytes) < defaultRequestBytes)) {
    throw invalidDefinition(name, `maxRequestBytes can only raise the limit above ${defaultRequestBytes} bytes (64 KiB).`)
  }
  if (definition.readOnlyWhen !== undefined && !(definition.readOnlyWhen instanceof Function)) throw invalidDefinition(name, "readOnlyWhen must be a function.")
}

/** The default limit of a call, in bytes. */
export const defaultRequestBytes: number = 64 * 1_024

/** Input keys that the generated CLI commands read themselves. */
export const reservedOperationFlags: readonly string[] = ["input", "json", "timeout", "url", "yes"]

/**
 * Define one operation. The Console, the CLI, MCP, and agent tools call the same definition. Contribute it with
 * `vitehub: { operations: [{ module, export }] }` on a Vite plugin.
 */
export function defineOperation<Input, Output>(definition: OperationDefinition<Input, Output>): OperationDefinition<Input, Output> {
  checkDefinition(definition)
  // Valibot schemas carry no JSON Schema. Add it here, so the CLI and MCP read the fields of any definer's input.
  const defined = { ...definition, input: withValibotJsonSchema(definition.input) }
  const properties = operationInputJsonSchema(defined as unknown as AnyOperation).properties
  const clashes = isObject(properties) ? Object.keys(properties).filter(key => reservedOperationFlags.includes(key)) : []
  if (clashes.length) {
    throw invalidDefinition(definition.name, `the input key ${clashes.map(key => JSON.stringify(key)).join(", ")} is a CLI flag of every command (${reservedOperationFlags.join(", ")}). Rename it.`)
  }
  return defined
}

export function isOperation(value: unknown): value is AnyOperation {
  try {
    checkDefinition(value)
    return true
  }
  catch {
    return false
  }
}

/** The contribution of one plugin: operations, or a module that exports them. */
export interface OperationContributionEntry {
  /** Module the app imports, such as `@vite-hub/content/operations`. */
  module: string
  /** Named export that holds an operation or an array of operations. Defaults to `default`. */
  export?: string
  /** Loads the export in the tool process, for a module that the tool cannot resolve by name. */
  load?: () => Promise<unknown>
  /** `false`: the app already has these operations at runtime. Only tools such as the CLI and `vitehub inspect` read the entry. */
  runtime?: false
}

/** The contribution of a plugin: a list, or a function that returns it, for a plugin that reads the project first. */
export type OperationContributions = readonly OperationContributionEntry[] | (() => readonly OperationContributionEntry[] | Promise<readonly OperationContributionEntry[]>)

export interface OperationContributingPlugin {
  name?: string
  vitehub?: { operations?: OperationContributions }
}

export function isSectionId(section: unknown): section is string {
  return typeof section === "string" && section !== "" && !section.includes(":")
}

/** JSON Schema of the input, for CLI flags and MCP tool schemas. Falls back to an open object. */
export function operationInputJsonSchema(operation: AnyOperation): Record<string, unknown> {
  return standardJsonSchema(operation.input, "input") ?? { type: "object" }
}
