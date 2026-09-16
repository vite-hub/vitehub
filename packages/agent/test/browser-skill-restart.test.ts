import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"

import { browserSkillContent } from "../src/internal/browser-skill.ts"

const roots: string[] = []
const path = ".agents/skills/agent-browser/SKILL.md"
const original = "# Browser\nOriginal instructions.\n"
const updated = "# Browser\nUpdated instructions.\n"

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "vitehub-browser-skill-restart-"))
  roots.push(root)
  return root
}

async function invoke(root: string, content: string) {
  // Each invocation starts without the previous process's Workspace Store cache.
  const { stdout } = await promisify(execFile)(process.execPath, [
    "--experimental-transform-types",
    fileURLToPath(new URL("./fixtures/browser-skill-restart.mjs", import.meta.url)), root, content,
  ], { timeout: 10_000 })
  return JSON.parse(stdout)
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

describe("browser skill ownership across process restarts", () => {
  it("updates owned guidance after restart and retains the new ownership on the next restart", async () => {
    const root = await fixture()
    const unrelated = join(root, "notes.md")
    await writeFile(unrelated, "User notes")
    expect((await invoke(root, original)).content).toBe(browserSkillContent(original))

    const expected = browserSkillContent(updated)
    const result = await invoke(root, updated)
    expect(result).toEqual({
      content: expected,
      ownership: { capabilityId: "browser", path, digest: createHash("sha256").update(expected).digest("hex") },
    })
    expect(await invoke(root, updated)).toEqual(result)
    await expect(readFile(unrelated, "utf8")).resolves.toBe("User notes")
  }, 30_000)

  it("rejects a direct edit after restart without overwriting the file", async () => {
    const root = await fixture()
    await invoke(root, original)
    await writeFile(join(root, path), "User browser instructions")

    await expect(invoke(root, updated)).rejects.toThrow("AGENT_R0331")
    await expect(readFile(join(root, path), "utf8")).resolves.toBe("User browser instructions")
  }, 20_000)

  it("does not adopt different legacy guidance without ownership metadata", async () => {
    const root = await fixture()
    await mkdir(join(root, ".agents/skills/agent-browser"), { recursive: true })
    await writeFile(join(root, path), browserSkillContent(original))

    await expect(invoke(root, updated)).rejects.toThrow("AGENT_R0331")
    await expect(readFile(join(root, path), "utf8")).resolves.toBe(browserSkillContent(original))
  }, 15_000)
})
