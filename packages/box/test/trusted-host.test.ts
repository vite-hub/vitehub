import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { resolveBox, trustedHost } from "../src/index.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

describe("trustedHost", () => {
  it("resolves an authoritative workspace and portable Home without serializing auth", async () => {
    const root = await temporaryRoot()
    const workspace = join(root, "workspace")
    const home = join(root, "home")
    const bin = join(root, "bin")
    await Promise.all([mkdir(workspace), mkdir(home), mkdir(bin)])
    await executable(bin, "codex", "exit 0")
    await executable(bin, "gh", "exit 0")
    await executable(bin, "pnpm", "exit 0")

    const box = await withPath(bin, () => resolveBox({
        cwd: ({ worktree }: { worktree: string }) => worktree,
        home,
        requires: ["github", "pnpm"],
        runtime: trustedHost(),
      }, { worktree: workspace }, { requires: ["codex"] }))

    expect(box).toMatchObject({
      cache: { state: "disposable" },
      environment: {
        env: {
          CODEX_HOME: join(home, ".codex"),
          HOME: home,
          PATH: bin,
          XDG_CONFIG_HOME: join(home, ".config"),
        },
        home,
      },
      isolation: "none",
      requirements: [
        { command: "gh", name: "github" },
        { command: "pnpm", name: "pnpm" },
        { command: "codex", name: "codex" },
      ],
      runtime: "trusted-host",
      workspace: { path: workspace, state: "authoritative" },
    })
    expect(JSON.stringify(box)).not.toContain("token")
  })

  it("uses a disposable workspace and the ambient Home when paths are omitted", async () => {
    const box = await resolveBox({ runtime: trustedHost() }, {})

    expect(box.environment.home).toBe(process.env.HOME)
    expect(box.workspace).toEqual({ state: "disposable" })
  })

  it("names a missing requirement", async () => {
    await expect(withPath("", () => resolveBox({
        requires: ["missing-tool"],
        runtime: trustedHost(),
      }, {}))).rejects.toThrow('Box requirement "missing-tool" is unavailable')
  })

  it("fails when named authentication is not ready", async () => {
    const root = await temporaryRoot()
    const bin = join(root, "bin")
    await mkdir(bin)
    await executable(bin, "gh", 'echo "not logged in" >&2\nexit 1')

    await expect(withPath(bin, () => resolveBox({
        requires: ["github"],
        runtime: trustedHost(),
      }, {}))).rejects.toThrow('Box requirement "github" failed: not logged in')
  })
})

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), "vitehub-box-test-"))
  roots.push(root)
  return root
}

async function executable(bin: string, name: string, body: string) {
  const path = join(bin, name)
  await writeFile(path, `#!/bin/sh\n${body}\n`)
  await chmod(path, 0o755)
}

async function withPath<T>(path: string, run: () => Promise<T>) {
  const original = process.env.PATH
  process.env.PATH = path
  try {
    return await run()
  }
  finally {
    if (original === undefined) delete process.env.PATH
    else process.env.PATH = original
  }
}
