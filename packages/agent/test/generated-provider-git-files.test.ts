import { execFile } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, expect, it } from "vitest"
import { protectGeneratedProviderGitFiles } from "../src/internal/generated-provider-git-files.ts"

const execute = promisify(execFile)
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

it("keeps generated instructions and Skills out of real Git commits and restores Git metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-generated-git-"))
  roots.push(root)
  const git = async (...args: string[]) => (await execute("git", ["-C", root, ...args], {
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  })).stdout
  await git("init", "-q")
  await git("config", "user.name", "Test")
  await git("config", "user.email", "test@localhost")
  await writeFile(join(root, "AGENTS.md"), "native instructions")
  await writeFile(join(root, "CLAUDE.md"), "native Claude instructions")
  await git("add", "-A")
  await git("commit", "-qm", "initial repository")
  await writeFile(join(root, "AGENTS.md"), "staged native instructions")
  await git("add", "AGENTS.md")
  await git("update-index", "--skip-worktree", "CLAUDE.md")
  const originalIndex = await git("ls-files", "-s")
  const originalFlags = await git("ls-files", "-v")
  const excludePath = join(root, ".git/info/exclude")
  const originalExclude = await readFile(excludePath, "utf8")
  const instruction = join(root, "AGENTS.md")
  const prompt = join(root, ".claude/vitehub-system-prompt.md")
  const skill = join(root, ".codex/skills/generated")
  const restore = await protectGeneratedProviderGitFiles(root, [instruction, prompt, skill, join(root, "CLAUDE.md")])
  await writeFile(instruction, "staged native instructions\n\ngenerated invocation provenance")
  await mkdir(join(root, ".claude"), { recursive: true })
  await writeFile(prompt, "generated secret prompt")
  await mkdir(skill, { recursive: true })
  await writeFile(join(skill, "SKILL.md"), "generated Skill")
  await writeFile(join(root, "result.txt"), "Agent repair")
  await git("add", "-A")
  expect(await git("show", ":AGENTS.md")).toBe("staged native instructions")
  expect(await git("ls-files", "--", ".claude", ".codex")).toBe("")
  await git("commit", "-qm", "Agent repair")
  expect(await git("show", "HEAD:AGENTS.md")).toBe("staged native instructions")
  expect(await git("show", "HEAD:result.txt")).toBe("Agent repair")
  expect(await git("ls-tree", "-r", "--name-only", "HEAD")).not.toContain(".codex")
  await writeFile(excludePath, `${await readFile(excludePath, "utf8")}# added during invocation\n`)
  await restore()
  expect(await readFile(excludePath, "utf8")).toBe(`${originalExclude}# added during invocation\n`)
  expect(await git("ls-files", "-v", "--", "AGENTS.md", "CLAUDE.md")).toBe(originalFlags)
  expect((await git("ls-files", "-s")).split("\n").filter(line => !line.endsWith("result.txt")).join("\n")).toBe(originalIndex)
  expect(await git("rev-list", "--count", "HEAD")).toBe("2\n")
})

it("restores the original Git exclude when a provider removes or replaces it", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-generated-git-"))
  roots.push(root)
  const git = async (...args: string[]) => (await execute("git", ["-C", root, ...args], {
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  })).stdout
  await git("init", "-q")
  const excludePath = join(root, ".git/info/exclude")
  const originalExclude = await readFile(excludePath, "utf8")
  const generated = join(root, "AGENTS.md")

  const restoreAfterDelete = await protectGeneratedProviderGitFiles(root, [generated])
  await rm(excludePath)
  await restoreAfterDelete()
  expect(await readFile(excludePath, "utf8")).toBe(originalExclude)

  const restoreAfterReplace = await protectGeneratedProviderGitFiles(root, [generated])
  await writeFile(excludePath, "provider replacement\n")
  await restoreAfterReplace()
  expect(await readFile(excludePath, "utf8")).toBe(originalExclude)
})
