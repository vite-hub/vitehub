import { createBirpc } from "birpc"

import { isRecord } from "./object.ts"

import type { OperationFailure } from "./operations.ts"

/** Path of the operation RPC under the app. Dev servers and deployed apps serve it the same way, one birpc call per POST. */
export const operationRpcPath = "/_vitehub/rpc"

/**
 * One operation call as a birpc request message. `m` names the operation, `a` holds its input or nothing, and `i` is
 * the id that the reply repeats. Over HTTP, one POST carries one call and its response carries one reply.
 */
export interface OperationRpcCall {
  t: "q"
  i: string
  m: string
  a: [] | [unknown]
}

/**
 * The birpc response message to one call: `r` holds the value, or `e` holds the diagnostic of the failure. A refusal
 * of a request that the server could not read, such as a body over the limit, has no `i`.
 */
export type OperationRpcReply =
  | { t: "s", i: string, r: unknown }
  | { t: "s", i?: string, e: OperationFailure }

/** What a transport gives back for one request: the parsed JSON body of the answer, next to anything the caller keeps, such as the Response. */
export interface OperationRpcAnswer {
  body: unknown
}

/**
 * The result of one call. `error` is the diagnostic of a refused call. `error: undefined` means that the answer is not
 * a reply to the call, such as an HTML page or a JSON failure of host middleware; read `answer` to explain it.
 */
export type OperationRpcOutcome<Answer extends OperationRpcAnswer> =
  | { ok: true, value: unknown, answer: Answer }
  | { ok: false, error: OperationFailure | undefined, answer: Answer }

const maximumIdLength = 128

function text(value: unknown): string | undefined {
  return String(value) === value && value ? value : undefined
}

/** Read an untrusted failure body. It keeps only the diagnostic fields, so a stack never passes through. */
export function readOperationRpcError(value: unknown): OperationFailure | undefined {
  if (!isRecord(value)) return undefined
  const code = text(value.code)
  const message = text(value.message)
  const status = value.status
  if (!code || !message || !Number.isInteger(status)) return undefined
  const failure: OperationFailure = { code, message, status: Number(status) }
  if (text(value.fix)) failure.fix = text(value.fix)
  if (text(value.docs)) failure.docs = text(value.docs)
  if (isRecord(value.details)) failure.details = value.details
  return failure
}

/** Read one request message. Events without an id, the `o` flag of optional calls, and more than one argument are refused. */
export function readOperationRpcCall(value: unknown): OperationRpcCall | undefined {
  if (!isRecord(value) || value.t !== "q") return undefined
  const { a: args, i: id, m: name } = value
  if (Object.keys(value).some(key => key !== "t" && key !== "i" && key !== "m" && key !== "a")) return undefined
  if (!text(id) || String(id).length > maximumIdLength || String(name) !== name) return undefined
  if (!Array.isArray(args) || args.length > 1) return undefined
  return { t: "q", i: String(id), m: name, a: args.length ? [args[0]] : [] }
}

/** Read one response message. */
export function readOperationRpcReply(value: unknown): OperationRpcReply | undefined {
  if (!isRecord(value) || value.t !== "s") return undefined
  const id = text(value.i)
  if (Object.hasOwn(value, "e")) {
    const error = readOperationRpcError(value.e)
    return error ? { t: "s", ...(id ? { i: id } : {}), e: error } : undefined
  }
  // JSON drops `r: undefined`, so a reply without `r` is an operation that returned nothing.
  return id ? { t: "s", i: id, r: value.r } : undefined
}

/** A refusal of a request that the server could not read as a call. */
export function operationRpcRefusal(failure: OperationFailure): OperationRpcReply {
  return { t: "s", e: failure }
}

/** How a server answers calls. */
export interface OperationRpcServer<Operation> {
  /** The operations by name. Only own keys resolve, so `toString`, `constructor`, or `__proto__` never reach a prototype. */
  operations: Readonly<Record<string, Operation>>
  /** Run one operation with the input of the call. */
  run: (operation: Operation, input: unknown) => unknown
  /** The failure of a name that does not resolve. */
  unknown: (name: string) => unknown
  /** The diagnostic of a failure. It must not copy the stack. */
  failure: (error: unknown) => OperationFailure
}

/**
 * Answer one call with birpc. Its resolver returns only own entries of `operations`. birpc would otherwise look the name
 * up on a plain object and call `toString` or `constructor` from its prototype.
 */
export async function answerOperationRpc<Operation>(call: OperationRpcCall, server: OperationRpcServer<Operation>): Promise<OperationRpcReply> {
  // birpc types its listener as returning void, but it returns the promise of the answered call.
  let receive: ((message: OperationRpcCall) => unknown) | undefined
  let posted: { i: string, r?: unknown, e?: unknown } | undefined
  let resolved = false
  let rejection: { reason: unknown } | undefined
  createBirpc<Record<string, never>, Record<string, never>, false>({}, {
    on: (listener) => {
      receive = listener
    },
    post: (message: { i: string, r?: unknown, e?: unknown }) => {
      posted = message
    },
    resolver: (name) => {
      if (!Object.hasOwn(server.operations, name)) return undefined
      resolved = true
      const operation = server.operations[name]!
      return async (...args: unknown[]) => {
        try {
          return await server.run(operation, args[0])
        }
        catch (reason) {
          // birpc treats a falsy rejection as success. Keep the original reason for the diagnostic.
          rejection = { reason }
          throw rejection
        }
      }
    },
    proxify: false,
    // The server never calls the client, so no call waits for a timeout.
    timeout: -1,
  })
  await receive!(call)
  // Internal invariant: birpc posts one reply for each request message that it receives.
  if (!posted) throw new Error("birpc did not reply to the operation call.")
  if (!Object.hasOwn(posted, "e")) return { t: "s", i: call.i, r: posted.r }
  // birpc refuses a name that the resolver does not return with its own error. The caller names the failure.
  const error = rejection ? rejection.reason : resolved ? posted.e : server.unknown(call.m)
  return { t: "s", i: call.i, e: server.failure(error) }
}

/**
 * Call one operation with birpc over a request and answer transport, such as one HTTP POST per call. `send` posts the
 * JSON message and returns the parsed answer; its own failures, such as a network error or an abort, reject.
 */
export async function callOperationRpc<Answer extends OperationRpcAnswer>(name: string, input: unknown, send: (body: string) => Promise<Answer>): Promise<OperationRpcOutcome<Answer>> {
  let receive: ((message: OperationRpcReply) => unknown) | undefined
  let answer: Answer | undefined
  const notReply = new Error("The answer is not a reply to the operation call.")
  const rpc = createBirpc<Record<string, (input?: unknown) => unknown>, Record<string, never>, false>({}, {
    on: (listener) => {
      receive = listener
    },
    post: async (message: OperationRpcCall) => {
      // birpc puts `m` first, so the server can read the operation name, and its byte limit, from the first bytes.
      answer = await send(JSON.stringify(message))
      const reply = readOperationRpcReply(answer.body)
      if (!reply || (reply.i !== undefined && reply.i !== message.i)) throw notReply
      // birpc settles only the call with the id of the reply. A refusal without an id answers this call.
      await receive!({ ...reply, i: message.i })
    },
    proxify: false,
    // The answer arrives in the same request, so the transport owns the timeout, such as the signal of a fetch.
    timeout: -1,
  })
  try {
    const value = await rpc.$call(name, ...(input === undefined ? [] : [input]))
    return { ok: true, value, answer: answer! }
  }
  catch (error) {
    if (!answer) throw error
    if (error === notReply) return { ok: false, error: undefined, answer }
    return { ok: false, error: readOperationRpcError(error), answer }
  }
}
