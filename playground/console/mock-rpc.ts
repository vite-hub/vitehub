import type { ConsoleRpcInput, ConsoleRpcMethod, ConsoleRpcResult } from "../../packages/vite-hub/src/console/runtime/rpc.ts"

// The playground serves synthetic HTTP responses instead of a live RPC host.
export async function connectDevframe() {
  return {
    async call(method: ConsoleRpcMethod, input: ConsoleRpcInput): Promise<ConsoleRpcResult> {
      let operation = method.replace("vitehub:console:", "")
      if (operation === "invocation") operation = `invocations/${encodeURIComponent(input.id ?? "")}`
      if (operation === "agent-invocations") operation = `agents/${encodeURIComponent(input.agent ?? "")}/invocations`
      const url = new URL(`/api/_vitehub/console/${operation}`, window.location.origin)
      for (const [key, value] of Object.entries(input.query ?? {})) {
        for (const entry of Array.isArray(value) ? value : [value]) url.searchParams.append(key, entry)
      }
      const response = await fetch(url, {
        body: input.body === undefined ? undefined : JSON.stringify(input.body),
        headers: { "content-type": "application/json" },
        method: input.method ?? "GET",
      })
      if (!response.ok) return { message: await response.text(), ok: false, status: response.status }
      return { ok: true, value: await response.json() }
    },
  }
}
