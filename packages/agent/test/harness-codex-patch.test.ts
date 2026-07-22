import { createCodex } from "@ai-sdk/harness-codex"
import { execFile } from "node:child_process"
import { build } from "esbuild"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"

import { codexDriver } from "../src/harness/codex.ts"
import { createLocalHarnessSandbox } from "../src/harness/local-sandbox.ts"

import type { HarnessV1SandboxProvider } from "@ai-sdk/harness"

const exec = promisify(execFile)

describe("ViteHub Codex harness", () => {
  it("bootstraps inside the sandbox workspace with the supported bridge", async () => {
    const harness = codexDriver({ sandbox: false }).harness as ReturnType<typeof createCodex>
    const bootstrap = await harness.getBootstrap!()
    const bridgePackage = bootstrap.files.find(file => file.path.endsWith("package.json"))
    const bridge = bootstrap.files.find(file => file.path.endsWith("bridge.mjs"))

    expect(bootstrap.bootstrapDir).toBe("/tmp/harness/codex")
    expect(bootstrap.commands).toContainEqual({
      command: "if command -v corepack >/dev/null 2>&1 && corepack pnpm@10.33.2 --dir /tmp/harness/codex install --ignore-workspace --frozen-lockfile --store-dir /tmp/harness/codex/.pnpm-store; then :; else pnpm --dir /tmp/harness/codex install --ignore-workspace --frozen-lockfile --store-dir /tmp/harness/codex/.pnpm-store; fi",
    })
    expect(JSON.parse(bridgePackage!.content)).toMatchObject({
      dependencies: { "@openai/codex-sdk": "0.144.5" },
    })
    expect(bootstrap.files.map(file => file.path)).not.toContain("/tmp/harness/codex/host-tool-mcp.mjs")
    expect(bridge!.content).not.toContain("mcp_servers")
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
            import { codexDriver } from "../src/harness/codex.ts"
            export const bootstrap = await codexDriver({ sandbox: false }).harness.getBootstrap()
          `,
          resolveDir: import.meta.dirname,
        },
      })

      const bundled = await import(`${pathToFileURL(output).href}?${Date.now()}`)
      expect(bundled.bootstrap.files.map((file: { path: string }) => file.path)).toContain("/tmp/harness/codex/bridge.mjs")
    }
    finally {
      await rm(fixture, { force: true, recursive: true })
    }
  })

  it.each([
    { corepackExit: 0, expected: "corepack" },
    { corepackExit: 1, expected: "pnpm" },
  ])("uses pinned Corepack first and falls back to ambient pnpm", async ({ corepackExit, expected }) => {
    const fixture = await mkdtemp(join(import.meta.dirname, ".codex-install-"))
    const bin = join(fixture, "bin")
    const marker = join(fixture, "installer.txt")

    try {
      await mkdir(bin)
      await writeFile(join(bin, "corepack"), `#!/bin/sh\nprintf corepack > "$INSTALLER_MARKER"\nexit ${corepackExit}\n`)
      await writeFile(join(bin, "pnpm"), "#!/bin/sh\nprintf pnpm > \"$INSTALLER_MARKER\"\n")
      await Promise.all([chmod(join(bin, "corepack"), 0o755), chmod(join(bin, "pnpm"), 0o755)])

      const harness = codexDriver({ sandbox: false }).harness as ReturnType<typeof createCodex>
      const bootstrap = await harness.getBootstrap!()
      await exec("/bin/sh", ["-c", bootstrap.commands[1]!.command], {
        cwd: fixture,
        env: { INSTALLER_MARKER: marker, PATH: bin },
      })

      await expect(readFile(marker, "utf8")).resolves.toBe(expected)
    }
    finally {
      await rm(fixture, { force: true, recursive: true })
    }
  })

  it("maps absolute bootstrap commands only in the local sandbox", async () => {
    const root = await mkdtemp(join(import.meta.dirname, ".codex-local-"))
    const driver = codexDriver({ sandbox: { env: { PATH: process.env.PATH }, rootDir: root } })
    const provider = driver.sandbox as HarnessV1SandboxProvider
    let output = ""

    try {
      const session = await provider.createSession({
        onFirstCreate: async (session) => {
          await session.writeTextFile({ content: "ready", path: "/tmp/harness/codex/marker" })
          output = (await session.run({ command: "cat /tmp/harness/codex/marker" })).stdout
        },
      })
      expect(output).toBe("ready")
      await session.destroy?.()
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("adapts a Box sandbox for Codex paths and direct OpenAI auth", async () => {
    const root = await mkdtemp(join(import.meta.dirname, ".codex-box-"))
    const harness = codexDriver({ sandbox: false }).harness as Record<PropertyKey, unknown>
    const adapt = harness[Symbol.for("vitehub.harnessSandboxAdapter")] as (provider: HarnessV1SandboxProvider) => HarnessV1SandboxProvider
    const provider = adapt(createLocalHarnessSandbox({
      env: {
        AI_GATEWAY_API_KEY: "host-key",
        AI_GATEWAY_BASE_URL: "https://gateway.example",
        PATH: process.env.PATH,
      },
      rootDir: root,
    }))

    try {
      const session = await provider.createSession()
      await session.writeTextFile({ content: "ready", path: "/tmp/harness/codex/marker" })

      expect((session as unknown as { env: Record<string, string> }).env.AI_GATEWAY_API_KEY).toBeUndefined()
      expect((session as unknown as { env: Record<string, string> }).env.AI_GATEWAY_BASE_URL).toBeUndefined()
      await expect(session.run({ command: "cat /tmp/harness/codex/marker" })).resolves.toMatchObject({ stdout: "ready" })
      await session.destroy?.()
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})
