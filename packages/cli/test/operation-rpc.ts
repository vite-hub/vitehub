import { readOperationRpcCall } from "@vite-hub/internal/operation-rpc"

import type { OperationResult } from "@vite-hub/internal/operations"

export function operationRpcRequest(body: unknown): { input: unknown, operation: string } {
  const call = readOperationRpcCall(JSON.parse(String(body)))
  if (!call) throw new TypeError(`Not a birpc call: ${String(body)}`)
  return { input: call.a[0], operation: call.m }
}

export function operationRpcResponse(body: unknown, result: OperationResult, init: ResponseInit = {}): Response {
  const call = readOperationRpcCall(JSON.parse(String(body)))
  if (!call) throw new TypeError(`Not a birpc call: ${String(body)}`)
  const { ok, ...rest } = result
  const reply = ok ? { t: "s", i: call.i, r: Reflect.get(rest, "value") } : { t: "s", i: call.i, e: rest }
  return Response.json(reply, { status: ok ? 200 : result.status, ...init })
}
