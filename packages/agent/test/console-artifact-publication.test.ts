import { expect, it, vi } from "vitest"
import { blob } from "../src/capabilities/storage/blob.ts"
import { setAgentWorkspaceDiff } from "../src/agent-workspace-runtime.ts"
import type { AgentCapabilityRuntimeContext, AgentOutputRenderer } from "../src/types.ts"

it.each([false, true])("publishes response image bytes before exposing links, failure=%s", async (fail) => {
  const bytes = new Uint8Array([137, 80, 78, 71])
  const put = vi.fn(async (_pathname: string, _bytes: Uint8Array) => {
    if (fail) throw new Error("storage offline")
    return [null, { url: "/blob/persistent.png" }]
  })
  let render!: AgentOutputRenderer
  // Only these public capability context fields participate in artifact publication.
  const context = {
    capabilities: { blob: { put } }, context: new Map(), driver: { kind: "provider" },
    output: { final(renderer: AgentOutputRenderer) { render = renderer } },
    request: new Request("http://vitehub.local/api/_vitehub/console/agents/test/invocations"),
    run: { runId: "test" },
    workspace: { fs: { stat: async () => ({ type: "file", mediaType: "image/png" }), readFile: async () => bytes } },
  } as unknown as AgentCapabilityRuntimeContext
  setAgentWorkspaceDiff(context.context, { to: "after", entries: [{ path: "artifacts/chart.png", type: "added", after: { type: "file" } }] })
  await blob({ mode: "write", assetPaths: ["artifacts"] }).output!(context)
  const result = render({ text: "![Chart](artifacts/chart.png)" }, context)
  if (fail) await expect(result).rejects.toThrow("storage offline")
  else {
    await expect(result).resolves.toMatchObject({ text: "![Chart](</blob/persistent.png>)", artifacts: [{ path: "artifacts/chart.png", url: "/blob/persistent.png" }] })
    expect(put.mock.calls[0]?.[1]).toEqual(bytes)
  }
})
