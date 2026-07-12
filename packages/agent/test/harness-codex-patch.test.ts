import { createCodex } from "@ai-sdk/harness-codex"
import { build } from "esbuild"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
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

  it("loads bridge assets after the adapter is bundled into another directory", async () => {
    const fixture = await mkdtemp(join(import.meta.dirname, ".codex-bundle-"))
    const output = join(fixture, "server", "_libs", "adapter.mjs")

    try {
      await build({
        bundle: true,
        format: "esm",
        outfile: output,
        platform: "node",
        stdin: {
          contents: `
            import { createCodex } from "@ai-sdk/harness-codex"
            export const bootstrap = await createCodex().getBootstrap()
          `,
          resolveDir: import.meta.dirname,
        },
      })

      const bundled = await import(`${pathToFileURL(output).href}?${Date.now()}`)
      expect(bundled.bootstrap.files.map((file: { path: string }) => file.path)).toContain("tmp/harness/codex/bridge.mjs")
    }
    finally {
      await rm(fixture, { force: true, recursive: true })
    }
  })
})
