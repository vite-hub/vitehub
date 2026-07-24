import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { resolveBox, trustedHost } from "@vite-hub/box"
import { afterEach, describe, expect, it } from "vitest"

import { decodeColocatedAgentHome, withColocatedAgentHome } from "../src/internal/colocated-agent-home.ts"
import { readColocatedAgentHome } from "../src/vite/colocated-agent-home.ts"

const roots: string[] = []

async function createAgentRoot() {
  const root = await mkdtemp(join(tmpdir(), "vitehub-agent-home-"))
  roots.push(root)
  await writeFile(join(root, "agent.ts"), "export default {}\n", "utf8")
  return root
}

describe("colocated Agent Home", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
  })

  it("recursively embeds dotfiles and binary files", async () => {
    const root = await createAgentRoot()
    const binary = Uint8Array.from([0, 255, 128, 13, 10, 42])
    await mkdir(join(root, "home", ".codex"), { recursive: true })
    await writeFile(join(root, "home", ".gitconfig"), "[user]\nname = ViteHub\n", "utf8")
    await writeFile(join(root, "home", ".codex", "fixture.bin"), binary)

    const files = readColocatedAgentHome(join(root, "agent.ts"))

    expect(Object.keys(files || {})).toEqual([".codex/fixture.bin", ".gitconfig"])
    expect(files?.[".codex/fixture.bin"]).toEqual({
      contents: Buffer.from(binary).toString("base64"),
      encoding: "base64",
    })
    expect(decodeColocatedAgentHome(files)?.[".codex/fixture.bin"].contents).toEqual(binary)
  })

  it("only discovers Home owned by folder Agent Definitions", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-home-"))
    roots.push(root)
    await mkdir(join(root, "review", "home"), { recursive: true })
    await writeFile(join(root, "review.ts"), "export default {}\n", "utf8")
    await writeFile(join(root, "review", "home", ".gitconfig"), "[user]\n", "utf8")

    expect(readColocatedAgentHome(join(root, "review.ts"))).toBeUndefined()
    await writeFile(join(root, "review", "index.ts"), "export default {}\n", "utf8")
    expect(readColocatedAgentHome(join(root, "review", "index.ts"))).toBeDefined()
  })

  it("rejects symlinks and bounded generated output", async () => {
    const symlinkRoot = await createAgentRoot()
    await mkdir(join(symlinkRoot, "home"), { recursive: true })
    await writeFile(join(symlinkRoot, "home", "config.toml"), "model = 'codex'\n", "utf8")
    await symlink("config.toml", join(symlinkRoot, "home", "linked.toml"))
    expect(() => readColocatedAgentHome(join(symlinkRoot, "agent.ts"))).toThrow(
      "Colocated Agent Home supports regular files and directories only: linked.toml",
    )

    const fileRoot = await createAgentRoot()
    await mkdir(join(fileRoot, "home"), { recursive: true })
    await writeFile(join(fileRoot, "home", "large.bin"), Buffer.alloc(1024 * 1024 + 1))
    expect(() => readColocatedAgentHome(join(fileRoot, "agent.ts"))).toThrow(
      "Colocated Agent Home file exceeds 1 MiB: large.bin",
    )

    const totalRoot = await createAgentRoot()
    await mkdir(join(totalRoot, "home"), { recursive: true })
    for (let index = 0; index < 4; index += 1) {
      await writeFile(join(totalRoot, "home", `${index}.bin`), Buffer.alloc(1024 * 1024))
    }
    await writeFile(join(totalRoot, "home", "overflow.bin"), "x")
    expect(() => readColocatedAgentHome(join(totalRoot, "agent.ts"))).toThrow(
      "Colocated Agent Home exceeds 4 MiB",
    )

    const countRoot = await createAgentRoot()
    await mkdir(join(countRoot, "home"), { recursive: true })
    await Promise.all(Array.from({ length: 1025 }, (_, index) =>
      writeFile(join(countRoot, "home", `${index}.txt`), "")))
    expect(() => readColocatedAgentHome(join(countRoot, "agent.ts"))).toThrow(
      "Colocated Agent Home exceeds 1024 files",
    )
  })

  it("merges Home without hiding Agent settings or explicit collisions", () => {
    const runtime = trustedHost()
    const box = { home: { files: { "explicit.txt": { contents: "explicit" } } }, runtime }
    const settings = { box, driver: { harness: {} } }
    const agent = {
      __vitehubWorkspaceAgentOptions: { ...settings, workspace: {} },
      box,
      name: "review",
    }
    Object.defineProperty(agent, "__vitehubAgentSettings", { value: settings })

    const resolved = withColocatedAgentHome(agent, {
      ".gitconfig": { contents: new TextEncoder().encode("[user]\n") },
    })
    const resolvedRecord = resolved as typeof agent & {
      __vitehubAgentSettings: typeof settings
    }

    expect(resolved).not.toBe(agent)
    expect(resolvedRecord.box.home.files).toMatchObject({
      ".gitconfig": { contents: new TextEncoder().encode("[user]\n") },
      "explicit.txt": { contents: "explicit" },
    })
    expect(resolvedRecord.__vitehubAgentSettings.box).toBe(resolvedRecord.box)
    expect(resolvedRecord.__vitehubWorkspaceAgentOptions.box).toBe(resolvedRecord.box)
    expect(Object.getOwnPropertyDescriptor(resolved, "__vitehubAgentSettings")).toMatchObject({
      enumerable: false,
      writable: false,
    })
    expect(() => withColocatedAgentHome(agent, {
      "explicit.txt": { contents: new Uint8Array() },
    })).toThrow("Colocated Agent Home conflicts with box.home.files: explicit.txt")
    expect(() => withColocatedAgentHome(
      { name: "review" },
      {
        ".gitconfig": { contents: new Uint8Array() },
      },
    )).toThrow("A colocated Agent Home requires defineAgent({ box })")
  })

  it("materializes discovered files through the existing Box Home plan", async () => {
    const root = await createAgentRoot()
    await mkdir(join(root, "home", ".codex"), { recursive: true })
    await writeFile(join(root, "home", ".codex", "config.toml"), "model = 'codex'\n", "utf8")
    await writeFile(join(root, "home", ".gitconfig"), "[user]\nname = ViteHub\n", "utf8")
    const files = decodeColocatedAgentHome(readColocatedAgentHome(join(root, "agent.ts")))
    const agent = withColocatedAgentHome({ box: { runtime: trustedHost() } }, files)
    const box = await resolveBox(agent.box, {})
    const session = await box.open()

    try {
      const result = await session.exec(process.execPath, [
        "-e",
        "const fs=require('node:fs');const path=require('node:path');process.stdout.write(fs.readFileSync(path.join(process.env.HOME,'.codex/config.toml'),'utf8')+'|'+fs.readFileSync(path.join(process.env.HOME,'.gitconfig'),'utf8'))",
      ])
      expect(result).toMatchObject({
        code: 0,
        stdout: "model = 'codex'\n|[user]\nname = ViteHub\n",
      })
    }
    finally {
      await session.close()
    }
  })
})
