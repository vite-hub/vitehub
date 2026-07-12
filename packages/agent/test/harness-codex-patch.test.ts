import { createCodex } from "@ai-sdk/harness-codex"
import { describe, expect, it } from "vitest"

describe("patched Codex harness", () => {
  it("bootstraps inside the sandbox workspace with the supported bridge", async () => {
    const bootstrap = await createCodex().getBootstrap!()
    const bridgePackage = bootstrap.files.find(file => file.path.endsWith("package.json"))

    expect(bootstrap.bootstrapDir).toBe("tmp/harness/codex")
    expect(bootstrap.commands).toContainEqual({
      command: "if command -v corepack >/dev/null 2>&1; then corepack pnpm@10.33.2 --dir tmp/harness/codex install --ignore-workspace --frozen-lockfile --store-dir tmp/harness/codex/.pnpm-store; else pnpm --dir tmp/harness/codex install --ignore-workspace --frozen-lockfile --store-dir tmp/harness/codex/.pnpm-store; fi",
    })
    expect(JSON.parse(bridgePackage!.content)).toMatchObject({
      dependencies: { "@openai/codex-sdk": "0.144.1" },
    })
  })
})
