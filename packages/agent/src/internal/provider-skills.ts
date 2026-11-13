import { cp, lstat, mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises"
import { dirname, join, posix, relative } from "node:path"
import { agentDiagnostics } from "../agent-diagnostics.ts"
import { isRuntimeRecord } from "./runtime-type.ts"

type SkillProvider = "claude-code" | "codex"

const skillRoots = [".agents/skills", ".codex/skills", ".claude/skills"] as const

/** The skill roots that each provider reads in its working directory. */
const nativeSkillRoots: Record<SkillProvider, readonly string[]> = {
  "claude-code": [".claude/skills"],
  codex: [".agents/skills", ".codex/skills"],
}

/** The skill root that each provider reads in its Home. */
const homeSkillRoots: Record<SkillProvider, string> = {
  "claude-code": ".claude/skills",
  codex: ".agents/skills",
}

/** One Skill folder: a Workspace directory to link, or Agent-owned files to write. */
export type ProviderSkill = { directory: string } | { files: Map<string, string | Uint8Array> }

/** True when every segment from `root` to `path` is a real directory, not a symbolic link. */
export async function hasSafeProviderPath(root: string, path: string): Promise<boolean> {
  let current = root
  const rootEntry = await lstat(root).catch(() => undefined)
  if (!rootEntry?.isDirectory() || rootEntry.isSymbolicLink()) return false
  for (const segment of relative(root, path).split(/[\\/]/).filter(Boolean)) {
    current = join(current, segment)
    const entry = await lstat(current).catch(() => undefined)
    if (!entry?.isDirectory() || entry.isSymbolicLink()) return false
  }
  return true
}

async function skillDirectories(root: string, skillRoot: string): Promise<string[]> {
  const directory = join(root, skillRoot)
  if (!await hasSafeProviderPath(root, directory)) return []
  const skills: string[] = []
  for (const child of await readdir(directory, { withFileTypes: true })) {
    if (!child.isDirectory() || child.isSymbolicLink()) continue
    const manifest = await lstat(join(directory, child.name, "SKILL.md")).catch(() => undefined)
    if (manifest?.isFile() && !manifest.isSymbolicLink()) skills.push(child.name)
  }
  return skills
}

/**
 * Selects the Skills that the provider cannot read in its working directory.
 * These are Workspace Skills under another provider's root, Agent-owned Skills,
 * and Skills of an outer Workspace root when the provider runs in a nested checkout.
 * A Skill name that the provider already reads natively is not added again.
 * Precedence by name: the working directory, then Agent-owned Skills, then the outer root.
 */
export async function selectProviderSkills(input: {
  colocated: unknown
  cwd: string
  provider: SkillProvider
  workspaceRoot: string
}): Promise<Map<string, ProviderSkill>> {
  const native = nativeSkillRoots[input.provider]
  const nativeNames = new Set<string>()
  for (const skillRoot of native) {
    for (const name of await skillDirectories(input.cwd, skillRoot)) nativeNames.add(name)
  }
  const skills = new Map<string, ProviderSkill>()
  const add = (name: string, skill: ProviderSkill) => {
    if (!nativeNames.has(name) && !skills.has(name)) skills.set(name, skill)
  }
  for (const skillRoot of skillRoots) {
    if (native.includes(skillRoot)) continue
    for (const name of await skillDirectories(input.cwd, skillRoot)) add(name, { directory: join(input.cwd, skillRoot, name) })
  }
  const owned = new Map<string, Map<string, string | Uint8Array>>()
  for (const source of Object.values(isRuntimeRecord(input.colocated) ? input.colocated : {})) {
    if (!isRuntimeRecord(source)
      || !(typeof source.content === "string" || source.content instanceof Uint8Array)
      || typeof source.workspacePath !== "string") continue
    const path = posix.normalize(source.workspacePath)
    const skillRoot = skillRoots.find(root => path.startsWith(`${root}/`))
    const [name, ...rest] = skillRoot ? path.slice(skillRoot.length + 1).split("/") : []
    if (!name || name === ".." || rest.includes("..")) {
      throw agentDiagnostics.AGENT_R0712({ message: "[vitehub] Colocated Skill path must stay inside a provider skill root." })
    }
    // Discovery includes root documentation, which does not belong to a Skill.
    if (!rest.length) continue
    const files = owned.get(name) ?? new Map<string, string | Uint8Array>()
    files.set(rest.join("/"), source.content)
    owned.set(name, files)
  }
  for (const [name, files] of owned) add(name, { files })
  if (input.workspaceRoot !== input.cwd) {
    for (const skillRoot of skillRoots) {
      for (const name of await skillDirectories(input.workspaceRoot, skillRoot)) add(name, { directory: join(input.workspaceRoot, skillRoot, name) })
    }
  }
  return skills
}

/**
 * Writes the selected Skills to one private folder outside the checkout.
 * Codex loads `directory` as an extra skill root. Claude Code reads
 * `<directory>/.claude/skills` when `directory` is an `--add-dir` directory.
 * Returns the folder that the provider receives, or `undefined` when there are no Skills.
 */
export async function materializeProviderSkills(skills: Map<string, ProviderSkill>, provider: SkillProvider, directory: string): Promise<string | undefined> {
  if (!skills.size) return
  const skillRoot = provider === "claude-code" ? join(directory, ".claude", "skills") : directory
  await mkdir(skillRoot, { mode: 0o700, recursive: true })
  for (const [name, skill] of skills) {
    const target = join(skillRoot, name)
    if ("files" in skill) {
      for (const [path, content] of skill.files) {
        await mkdir(dirname(join(target, path)), { recursive: true })
        await writeFile(join(target, path), content)
      }
      continue
    }
    try {
      await symlink(skill.directory, target, "dir")
    }
    catch (error) {
      // Windows may deny directory symlinks without Developer Mode or elevation.
      if (!isRuntimeRecord(error) || (error.code !== "EPERM" && error.code !== "EACCES")) throw error
      await cp(skill.directory, target, { recursive: true })
    }
  }
  return directory
}

async function readSkillFiles(directory: string, prefix = ""): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>()
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) for (const [child, content] of await readSkillFiles(directory, path)) files.set(child, content)
    else if (entry.isFile()) files.set(path, await readFile(join(directory, path)))
  }
  return files
}

/** Adds the selected Skills to Sandbox Home under the one skill root that the provider reads. */
export async function addProviderSandboxSkills(skills: Map<string, ProviderSkill>, provider: SkillProvider, files: Record<string, string | Uint8Array>): Promise<void> {
  const root = homeSkillRoots[provider]
  for (const [name, skill] of skills) {
    const skillFiles = "files" in skill ? skill.files : await readSkillFiles(skill.directory)
    for (const [path, content] of skillFiles) files[`${root}/${name}/${path}`] ??= content
  }
}
