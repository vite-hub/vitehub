import { readOperationRpcCall } from "@vite-hub/internal/operation-rpc"

import type { OperationResult } from "@vite-hub/internal/operations"

// The CLI tsconfig keeps its root in this package, so it cannot import `packages/internal/test-utils`.

/** The operation and input of a birpc call body that the CLI sent. */
export function operationRpcRequest(body: unknown): { input: unknown, operation: string } {
  const call = readOperationRpcCall(JSON.parse(String(body)))
  if (!call) throw new TypeError(`Not a birpc call: ${String(body)}`)
  return { input: call.a[0], operation: call.m }
}

/** The birpc reply to a sent call body, with the failure status or 200. */
export function operationRpcResponse(body: unknown, result: OperationResult, init: ResponseInit = {}): Response {
  const call = readOperationRpcCall(JSON.parse(String(body)))
  if (!call) throw new TypeError(`Not a birpc call: ${String(body)}`)
  const { ok, ...rest } = result
  const reply = ok ? { t: "s", i: call.i, r: Reflect.get(rest, "value") } : { t: "s", i: call.i, e: rest }
  return Response.json(reply, { status: ok ? 200 : result.status, ...init })
}
