import { createCodex } from "@ai-sdk/harness-codex"
import { execFile } from "node:child_process"
import { build } from "esbuild"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"

import { codexDriver } from "../src/harness/codex.ts"

const exec = promisify(execFile)

describe("ViteHub Codex harness", () => {
  it("bootstraps inside the sandbox workspace with the supported bridge", async () => {
    const harness = codexDriver({ sandbox: false }).harness as ReturnType<typeof createCodex>
    const bootstrap = await harness.getBootstrap!()
    const bridgePackage = bootstrap.files.find(file => file.path.endsWith("package.json"))

    expect(bootstrap.bootstrapDir).toBe("tmp/harness/codex")
    expect(bootstrap.commands).toContainEqual({
      command: "if command -v corepack >/dev/null 2>&1 && corepack pnpm@10.33.2 --dir tmp/harness/codex install --ignore-workspace --frozen-lockfile --store-dir tmp/harness/codex/.pnpm-store; then :; else pnpm --dir tmp/harness/codex install --ignore-workspace --frozen-lockfile --store-dir tmp/harness/codex/.pnpm-store; fi",
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
            import { codexDriver } from "../src/harness/codex.ts"
            export const bootstrap = await codexDriver({ sandbox: false }).harness.getBootstrap()
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

  it("anchors the bridge command to the sandbox root", async () => {
    const commands: string[] = []
    const session = {
      defaultWorkingDirectory: "/sandbox/root",
      getPortUrl: async () => "ws://127.0.0.1:3000",
      id: "sandbox",
      ports: [3000],
      readTextFile: async () => null,
      restricted() {
        return this
      },
      run: async () => ({ exitCode: 0, stderr: "", stdout: "" }),
      spawn: async ({ command }: { command: string }) => {
        commands.push(command)
        throw new Error("captured bridge command")
      },
      stop: async () => {},
      writeTextFile: async () => {},
    }
    const harness = codexDriver({ sandbox: false }).harness as ReturnType<typeof createCodex>

    await expect(harness.doStart({
      permissionMode: "allow-all",
      sandboxSession: session,
      sessionId: "review",
      sessionWorkDir: "/sandbox/root/codex-review",
    } as never)).rejects.toThrow("captured bridge command")

    expect(commands).toEqual([
      expect.stringContaining("node /sandbox/root/tmp/harness/codex/bridge.mjs"),
    ])
    expect(commands[0]).not.toContain("/sandbox/root/codex-review/tmp/harness/codex")
  })
})
