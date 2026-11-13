import { defineErrors } from "@vite-hub/runtime"
import { parseYAML } from "confbox/yaml"
import { createTar } from "nanotar"

import type { Result } from "@vite-hub/runtime"

/**
 * Agent Skills that an app gives to coding agents. One list feeds every surface:
 *
 * - Agent Skills Discovery v0.2.0 at `/.well-known/agent-skills/`: an index with digests, and an archive for a skill
 *   with more than one file.
 * - Discovery v0.1.0 at `/.well-known/skills/`, which `npx skills add <origin>` reads.
 * - The MCP Skills extension (`io.modelcontextprotocol/skills`): `skills/list`, `skills/get`, and `skill://` resources.
 */

// Keep published codes stable. Each code has a heading on the docs page.
const skillErrors = /*#__PURE__*/ defineErrors({
  docs: "https://vitehub.dev/docs/development/diagnostics",
  codes: {
    // Definition errors. `defineSkill()` and `defineSkills()` throw them.
    SKILL_FILE_MISSING: {
      why: ({ root }: { root: string }) => `The skill${root ? ` in ${JSON.stringify(root)}` : ""} has no \`SKILL.md\`.`,
      fix: "Add a `SKILL.md` file with `name` and `description` in its frontmatter.",
    },
    SKILL_INVALID_FRONTMATTER: {
      why: ({ problem }: { problem: string }) => `The frontmatter of \`SKILL.md\` is not valid: ${problem}`,
      fix: "Start `SKILL.md` with `---`, a `name` of lowercase letters, digits, and single hyphens (at most 64 characters) that matches the folder, a `description`, and `---`.",
    },
    SKILL_INVALID_PATH: {
      why: ({ path }: { path: string }) => `The skill file path ${JSON.stringify(path)} is not a relative path inside the skill.`,
      fix: "Use paths such as `SKILL.md` or `references/api.md`, without `..`, `.`, empty segments, a leading `/`, or `\\`.",
    },
    SKILL_DUPLICATE_NAME: {
      why: ({ name }: { name: string }) => `Two skills are named ${JSON.stringify(name)}.`,
      fix: "Give each skill a unique `name` in its frontmatter and folder.",
    },

    // Runtime errors. `skillsMcp()` returns them as `[error, undefined]`.
    SKILL_NOT_FOUND: {
      why: ({ uri }: { uri: string }) => `No skill or skill file at ${uri}.`,
      fix: "Read `skills/list` or `resources/list` for the current URIs, or run `vitehub served-skills list` for the names. A skill that the list function leaves out is not readable.",
    },
    SKILL_SETTINGS_UNAVAILABLE: {
      why: ({ action }: { action: "read" | "write" }) => `The skill settings store failed to ${action} which skills are off.`,
      fix: "Check the store that `skillSettings()` got, such as the KV binding of the app, and try again. The error cause has the store error.",
    },
  },
})

/** The codes of `vite-hub/skills`. Each has a heading on https://vitehub.dev/docs/development/skills. */
export type SkillErrorCode = "SKILL_DUPLICATE_NAME" | "SKILL_FILE_MISSING" | "SKILL_INVALID_FRONTMATTER" | "SKILL_INVALID_PATH" | "SKILL_NOT_FOUND" | "SKILL_SETTINGS_UNAVAILABLE"

/** One file of a skill. */
export interface SkillFile {
  /** Path inside the skill folder, such as `SKILL.md` or `references/api.md`. */
  readonly path: string
  readonly mimeType: string
  readonly bytes: Uint8Array<ArrayBuffer>
  /** Text supplied as a string, or decoded from UTF-8 bytes for a `SKILL.md`. */
  readonly text: string | undefined
}

/** An Agent Skill: a `SKILL.md` with `name` and `description` frontmatter, and the files next to it. */
export interface Skill {
  readonly name: string
  /** MCP directory path, such as `release/nested`. Defaults to `name` for custom skills. */
  readonly path?: string
  readonly description: string
  /** Every field of the `SKILL.md` frontmatter. */
  readonly frontmatter: Readonly<Record<string, unknown>>
  /** `SKILL.md` first, then the other files by path. */
  readonly files: readonly SkillFile[]
}

/** Files by path. A string is UTF-8 text, such as a `?raw` import. */
export type SkillFiles = Readonly<Record<string, string | Uint8Array>>

/** The skills to serve, or a function that returns the current ones on each request. */
export type SkillList<TSkill extends Skill = Skill> = readonly TSkill[] | (() => readonly TSkill[] | Promise<readonly TSkill[]>)

const skillFile = "SKILL.md"
const namePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const encoder = new TextEncoder()

const mimeTypes: Readonly<Record<string, string>> = {
  css: "text/css",
  csv: "text/csv",
  gif: "image/gif",
  html: "text/html",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  js: "text/javascript",
  json: "application/json",
  md: "text/markdown",
  mjs: "text/javascript",
  pdf: "application/pdf",
  png: "image/png",
  svg: "image/svg+xml",
  txt: "text/plain",
  webp: "image/webp",
  yaml: "application/yaml",
  yml: "application/yaml",
}

function mimeTypeOf(path: string, text: boolean): string {
  const extension = /\.([^./]+)$/.exec(path)?.[1]?.toLowerCase()
  return (extension && mimeTypes[extension]) ?? (text ? "text/plain" : "application/octet-stream")
}

function isSafePath(path: string): boolean {
  return path !== "" && !path.includes("\\") && !path.includes("\0") && path.split("/").every(segment => segment !== "" && segment !== "." && segment !== "..")
}

function toFile(path: string, content: string | Uint8Array): SkillFile {
  if (!isSafePath(path)) throw skillErrors.SKILL_INVALID_PATH({ path })
  let text = typeof content === "string" ? content : undefined
  // Copied into a plain ArrayBuffer, which Response and crypto.subtle take.
  const bytes = typeof content === "string" ? encoder.encode(content) : new Uint8Array(content)
  if (text === undefined && (path === skillFile || path.endsWith(`/${skillFile}`))) {
    try {
      // Preserve a BOM so the text encodes to the same bytes as the manifest digest.
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
    }
    catch (error) {
      throw skillErrors.SKILL_INVALID_FRONTMATTER({ cause: error, problem: "`SKILL.md` must be valid UTF-8 text." })
    }
  }
  return Object.freeze({ bytes, mimeType: mimeTypeOf(path, text !== undefined), path, text })
}

function frontmatterOf(markdown: string): Record<string, unknown> {
  const block = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown.replace(/^﻿/, ""))?.[1]
  if (block === undefined) throw skillErrors.SKILL_INVALID_FRONTMATTER({ problem: "`SKILL.md` does not start with a `---` block." })
  let parsed: unknown
  try {
    parsed = parseYAML(block)
  }
  catch (error) {
    throw skillErrors.SKILL_INVALID_FRONTMATTER({ cause: error, problem: "the YAML does not parse." })
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw skillErrors.SKILL_INVALID_FRONTMATTER({ problem: "the block is not a YAML mapping." })
  }
  // SAFETY: A YAML mapping parses to a plain object with string keys.
  return parsed as Record<string, unknown>
}

function createSkill(files: SkillFiles, folder: string | undefined, path?: string): Skill {
  const entries = Object.entries(files).map(([path, content]) => toFile(path, content))
  const main = entries.find(entry => entry.path === skillFile)
  if (!main) throw skillErrors.SKILL_FILE_MISSING({ root: folder ?? "" })
  const frontmatter = frontmatterOf(main.text ?? new TextDecoder().decode(main.bytes))
  const { compatibility, description, metadata, name } = frontmatter
  if (typeof name !== "string" || name.length > 64 || !namePattern.test(name)) {
    throw skillErrors.SKILL_INVALID_FRONTMATTER({ problem: `\`name\` must be lowercase letters, digits, and single hyphens, at most 64 characters. It is ${JSON.stringify(name)}.` })
  }
  if (folder !== undefined && folder !== name) {
    throw skillErrors.SKILL_INVALID_FRONTMATTER({ problem: `\`name\` is ${JSON.stringify(name)}, but the folder is ${JSON.stringify(folder)}.` })
  }
  if (typeof description !== "string" || !description.trim() || description.length > 1024) {
    throw skillErrors.SKILL_INVALID_FRONTMATTER({ problem: "`description` must be a non-empty string of at most 1024 characters." })
  }
  if (compatibility !== undefined && (typeof compatibility !== "string" || !compatibility.trim() || compatibility.length > 500)) {
    throw skillErrors.SKILL_INVALID_FRONTMATTER({ problem: "`compatibility` must be a non-empty string of at most 500 characters." })
  }
  if (metadata !== undefined && (metadata === null || typeof metadata !== "object" || Array.isArray(metadata) || Object.values(metadata).some(value => typeof value !== "string"))) {
    throw skillErrors.SKILL_INVALID_FRONTMATTER({ problem: "`metadata` must map string keys to string values." })
  }
  for (const field of ["license", "allowed-tools"]) {
    if (frontmatter[field] !== undefined && typeof frontmatter[field] !== "string") {
      throw skillErrors.SKILL_INVALID_FRONTMATTER({ problem: `\`${field}\` must be a string.` })
    }
  }
  const others = entries.filter(entry => entry !== main).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  return Object.freeze({ description, files: Object.freeze([main, ...others]), frontmatter: Object.freeze(frontmatter), name, path: path ?? name })
}

/**
 * One skill from its files by path inside the skill folder. Throws when `SKILL.md`, its `name`, or its `description` is
 * missing, or when a path leaves the folder.
 *
 * ```ts
 * import skillMd from "./skills/release/SKILL.md?raw"
 * import checklist from "./skills/release/references/checklist.md?raw"
 *
 * export const release = defineSkill({ "SKILL.md": skillMd, "references/checklist.md": checklist })
 * ```
 */
export function defineSkill(files: SkillFiles): Skill {
  return createSkill(files, undefined)
}

/**
 * Every skill in a set of files, such as an `import.meta.glob()` result. Each `SKILL.md` starts a skill, and the files
 * below its folder belong to it. Files outside every skill folder are left out. The folder name must equal the `name`.
 *
 * ```ts
 * export const skills = defineSkills(import.meta.glob("./skills/**", { query: "?raw", import: "default", eager: true }))
 * ```
 */
export function defineSkills(files: SkillFiles): Skill[] {
  // Visit enclosing roots first; nested files also belong to every enclosing skill.
  const roots = Object.keys(files)
    .filter(key => key === skillFile || key.endsWith(`/${skillFile}`))
    .map(key => key.slice(0, -skillFile.length))
    .sort((a, b) => a.length - b.length)
  const grouped = new Map<string, Record<string, string | Uint8Array>>(roots.map(root => [root, {}]))
  for (const [key, content] of Object.entries(files)) {
    for (const root of roots) {
      if (key.startsWith(root)) grouped.get(root)![key.slice(root.length)] = content
    }
  }
  const byRoot = new Map<string, Skill>()
  for (const [root, entries] of grouped) {
    const enclosing = roots.find(candidate => candidate !== root && root.startsWith(candidate))
    const parent = enclosing === undefined ? undefined : byRoot.get(enclosing)
    const path = parent ? `${parent.path ?? parent.name}/${root.slice(enclosing!.length, -1)}` : undefined
    byRoot.set(root, createSkill(entries, root ? /([^/]+)\/$/.exec(root)?.[1] : undefined, path))
  }
  const skills = [...byRoot.values()]
  const names = new Set<string>()
  for (const skill of skills) {
    if (names.has(skill.name)) throw skillErrors.SKILL_DUPLICATE_NAME({ name: skill.name })
    names.add(skill.name)
  }
  return skills.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
}

const digests = new WeakMap<object, Promise<string>>()
const archives = new WeakMap<Skill, Promise<Uint8Array<ArrayBuffer>>>()

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
  return `sha256:${Array.from(hash, byte => byte.toString(16).padStart(2, "0")).join("")}`
}

function fileDigest(file: SkillFile): Promise<string> {
  let digest = digests.get(file)
  if (!digest) digests.set(file, digest = sha256(file.bytes))
  return digest
}

async function tarGzip(skill: Skill): Promise<Uint8Array<ArrayBuffer>> {
  const tar = createTar(skill.files.map(file => ({ attrs: { mode: "644", mtime: 0 }, data: file.bytes, name: file.path })))
  // nanotar 0.3 sizes its buffer without the two zero blocks that end a tar archive, so add them.
  const archive = new Uint8Array(tar.byteLength + 1024)
  archive.set(tar)
  return new Uint8Array(await new Response(new Response(archive).body!.pipeThrough(new CompressionStream("gzip"))).arrayBuffer())
}

/**
 * A multi-file skill as one `.tar.gz`: the files of the folder with `SKILL.md` at the root of the archive and no wrapper
 * folder. Fixed modification times keep the bytes, and so the digest, the same on every server.
 */
export function skillArchive(skill: Skill): Promise<Uint8Array<ArrayBuffer>> {
  let archive = archives.get(skill)
  if (!archive) archives.set(skill, archive = tarGzip(skill))
  return archive
}

/** `sha256:<hex>` of what Discovery v0.2.0 serves for the skill: the `SKILL.md` of a one-file skill, else its archive. */
export function skillDigest(skill: Skill): Promise<string> {
  if (skill.files.length === 1) return fileDigest(skill.files[0]!)
  let digest = digests.get(skill)
  if (!digest) digests.set(skill, digest = skillArchive(skill).then(sha256))
  return digest
}

async function resolveSkills<TSkill extends Skill>(skills: SkillList<TSkill>): Promise<readonly TSkill[]> {
  const list = typeof skills === "function" ? await skills() : skills
  const names = new Set<string>()
  return list.filter((skill) => {
    if (names.has(skill.name)) return false
    names.add(skill.name)
    return true
  })
}

/** Options of {@link serveSkills}. */
export interface ServeSkillsOptions {
  /** Path below the origin where the `/.well-known/` folders start, such as `/docs`. Defaults to the origin root. */
  base?: string
  /** `Cache-Control` of every answer. Defaults to `public, max-age=60`, so a change of the list reaches clients within a minute. */
  cacheControl?: string
}

const discoveryV2 = "/.well-known/agent-skills/"
const discoveryV1 = "/.well-known/skills/"
const schemaV2 = "https://schemas.agentskills.io/discovery/0.2.0/schema.json"

/**
 * Answer an Agent Skills Discovery request, or return `undefined` when the request is for another path. Serves the
 * v0.2.0 index, files, and archives at `/.well-known/agent-skills/`, and the v0.1.0 index and files at
 * `/.well-known/skills/`. A path below them that names no skill or file gets `404`, and a method other than `GET` or
 * `HEAD` gets `405`.
 *
 * ```ts [server/middleware/skills.ts]
 * import { defineHandler } from "h3"
 * import { serveSkills } from "vite-hub/skills"
 * import { skills } from "../skills"
 *
 * export default defineHandler(event => serveSkills(event.req, skills))
 * ```
 */
export async function serveSkills(request: Request, skills: SkillList, options: ServeSkillsOptions = {}): Promise<Response | undefined> {
  const base = (options.base ?? "").replace(/\/+$/, "")
  const pathname = new URL(request.url).pathname
  const v2 = pathname.startsWith(`${base}${discoveryV2}`)
  if (!v2 && !pathname.startsWith(`${base}${discoveryV1}`)) return undefined

  const headers = { "cache-control": options.cacheControl ?? "public, max-age=60", "x-content-type-options": "nosniff" }
  const head = request.method === "HEAD"
  const respond = (body: string | Uint8Array<ArrayBuffer>, type: string) => new Response(head ? null : body, { headers: { ...headers, "content-type": type } })
  if (request.method !== "GET" && !head) return new Response(null, { headers: { ...headers, allow: "GET, HEAD" }, status: 405 })

  let path: string
  try {
    path = decodeURIComponent(pathname.slice(base.length + (v2 ? discoveryV2 : discoveryV1).length))
  }
  catch {
    return new Response(null, { headers, status: 404 })
  }
  const list = await resolveSkills(skills)

  if (path === "index.json") {
    const root = `${base}${discoveryV2}`
    const index = v2
      ? {
          $schema: schemaV2,
          skills: await Promise.all(list.map(async skill => ({
            description: skill.description,
            digest: await skillDigest(skill),
            name: skill.name,
            type: skill.files.length === 1 ? "skill-md" : "archive",
            url: skill.files.length === 1 ? `${root}${skill.name}/${skillFile}` : `${root}${skill.name}.tar.gz`,
          }))),
        }
      : {
          skills: await Promise.all(list.map(async skill => ({
            description: skill.description,
            files: skill.files.map(file => file.path),
            name: skill.name,
            // Changes whenever a file does, so a client such as Executor reloads the files only then.
            version: (await skillDigest(skill)).slice("sha256:".length, "sha256:".length + 12),
          }))),
        }
    return respond(`${JSON.stringify(index, null, 2)}\n`, "application/json")
  }

  const archive = v2 ? /^([^/]+)\.tar\.gz$/.exec(path)?.[1] : undefined
  const archived = archive === undefined ? undefined : list.find(skill => skill.name === archive)
  if (archived) return respond(await skillArchive(archived), "application/gzip")

  const slash = path.indexOf("/")
  const name = path.slice(0, slash)
  const file = slash > 0 ? list.find(skill => skill.name === name)?.files.find(entry => entry.path === path.slice(slash + 1)) : undefined
  if (!file) return new Response(null, { headers, status: 404 })
  return respond(file.bytes, file.text === undefined ? file.mimeType : `${file.mimeType}; charset=utf-8`)
}

/** A skill in `skills/list` and `skills/get` of the MCP Skills extension. */
export interface McpSkill {
  /** `skill://<skill-path>/SKILL.md` */
  uri: string
  frontmatter: Readonly<Record<string, unknown>>
  resources: Array<{ uri: string, digest: string, size: number }>
}

/** A skill file in `resources/list`. */
export interface McpSkillResource {
  uri: string
  name: string
  title: string
  description?: string
  mimeType: string
  size: number
}

/** Completion and cache metadata for MCP skill results. Runtime selections are never cached. */
export interface McpSkillResult {
  resultType: "complete"
  ttlMs: number
  cacheScope: "private"
}

/** The answer of `resources/read` for a skill file: `text` for a text file, else base64 `blob`. */
export interface McpSkillContents extends McpSkillResult {
  contents: [{ uri: string, mimeType: string, text: string } | { uri: string, mimeType: string, blob: string }]
}

/** The MCP Skills extension, for any MCP server library. See {@link skillsMcp}. */
export interface SkillsMcp {
  /** The extension id that the server announces in its capabilities. */
  readonly extension: "io.modelcontextprotocol/skills"
  /** The result of `skills/list`. */
  list: () => Promise<McpSkillResult & { skills: McpSkill[] }>
  /** The result of `skills/get` for `skill://<skill-path>` or `skill://<skill-path>/SKILL.md`. */
  get: (uri: string) => Promise<Result<McpSkillResult & { skill: McpSkill }, "SKILL_NOT_FOUND">>
  /** Every skill file, for `resources/list`. */
  resources: () => Promise<McpSkillResource[]>
  /** The result of `resources/read` for `skill://<skill-path>/<path>`. */
  read: (uri: string) => Promise<Result<McpSkillContents, "SKILL_NOT_FOUND">>
}

const uriOf = (skill: Skill, path: string) => `skill://${skill.path ?? skill.name}/${path}`
const mcpResult = { cacheScope: "private", resultType: "complete", ttlMs: 0 } as const

async function mcpSkill(skill: Skill): Promise<McpSkill> {
  return {
    frontmatter: skill.frontmatter,
    resources: await Promise.all(skill.files.map(async file => ({ digest: await fileDigest(file), size: file.bytes.byteLength, uri: uriOf(skill, file.path) }))),
    uri: uriOf(skill, skillFile),
  }
}

function base64(bytes: Uint8Array): string {
  let binary = ""
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return btoa(binary)
}

/**
 * The MCP Skills extension (`io.modelcontextprotocol/skills`) as plain results, so any MCP server library can answer
 * `skills/list`, `skills/get`, `resources/list`, and `resources/read` for `skill://<skill-path>/<path>`. Each call reads the
 * list again, serving only entries and files belonging to the current skills.
 */
export function skillsMcp(skills: SkillList): SkillsMcp {
  return {
    extension: "io.modelcontextprotocol/skills",
    async get(uri) {
      const skill = (await resolveSkills(skills)).find(entry => uri === uriOf(entry, skillFile) || uri === uriOf(entry, "").slice(0, -1))
      if (!skill) return [skillErrors.SKILL_NOT_FOUND({ uri }), undefined]
      return [undefined, { ...mcpResult, skill: await mcpSkill(skill) }]
    },
    async list() {
      return { ...mcpResult, skills: await Promise.all((await resolveSkills(skills)).map(mcpSkill)) }
    },
    async read(uri) {
      let file: SkillFile | undefined
      for (const skill of await resolveSkills(skills)) {
        file = skill.files.find(entry => uriOf(skill, entry.path) === uri)
        if (file) break
      }
      if (!file) return [skillErrors.SKILL_NOT_FOUND({ uri }), undefined]
      return [undefined, { ...mcpResult, contents: [file.text === undefined ? { blob: base64(file.bytes), mimeType: file.mimeType, uri } : { mimeType: file.mimeType, text: file.text, uri }] }]
    },
    async resources() {
      const resources = new Map<string, McpSkillResource>()
      for (const skill of await resolveSkills(skills)) {
        for (const file of skill.files) {
          const uri = uriOf(skill, file.path)
          // Prefer a nested skill's own metadata over its enclosing skill's supporting file.
          if (resources.has(uri) && file.path !== skillFile) continue
          resources.set(uri, {
            ...(file.path === skillFile ? { description: skill.description } : {}),
            mimeType: file.mimeType,
            name: `${skill.path ?? skill.name}/${file.path}`,
            size: file.bytes.byteLength,
            title: file.path === skillFile ? `${skill.name} skill` : `${skill.name}: ${file.path}`,
            uri,
          })
        }
      }
      return [...resources.values()]
    },
  }
}

/**
 * Where {@link skillSettings} keeps the names of the skills that are off. The `kv` store of `vite-hub/kv` fits as it
 * is. Another store, such as a Database table, needs only these two methods.
 */
export interface SkillSettingsStore {
  get: (key: string) => Promise<Result<unknown, string>>
  set: (key: string, value: string[]) => Promise<Result<void, string>>
}

/** Options of {@link skillSettings}. */
export interface SkillSettingsOptions {
  store: SkillSettingsStore
  /** The key of the list of names that are off. Defaults to `vitehub:skills:disabled`. */
  key?: string
  /**
   * How long, in milliseconds, a server instance reuses what it read. A change on this instance applies at once; other
   * instances read it within this time. Defaults to `60_000`, the `Cache-Control` time of {@link serveSkills}.
   */
  ttlMs?: number
}

/** A skill and whether it is on. */
export interface SkillState<TSkill extends Skill = Skill> {
  skill: TSkill
  enabled: boolean
}

const settingsBrand: unique symbol = Symbol.for("vitehub.skills.settings")

/** Runtime switches for a skill list. See {@link skillSettings}. */
export interface SkillSettings<TSkill extends Skill = Skill> {
  readonly [settingsBrand]: true
  /** Every skill, on or off. */
  readonly skills: SkillList<TSkill>
  /**
   * The skills that are on, as a list function for {@link serveSkills} and {@link skillsMcp}. It rejects with
   * `SKILL_SETTINGS_UNAVAILABLE` when the store fails, so a request fails instead of serving a skill that is off.
   */
  enabled: () => Promise<TSkill[]>
  /** Every skill with its state, for a catalog or an admin page of the app. */
  list: () => Promise<Result<SkillState<TSkill>[], "SKILL_SETTINGS_UNAVAILABLE">>
  /** Turns one skill on or off for every server instance. */
  set: (name: string, enabled: boolean) => Promise<Result<SkillState<TSkill>, "SKILL_NOT_FOUND" | "SKILL_SETTINGS_UNAVAILABLE">>
}

/** True for the result of {@link skillSettings}. */
export function isSkillSettings(value: unknown): value is SkillSettings {
  return typeof value === "object" && value !== null && Reflect.get(value, settingsBrand) === true
}

/**
 * Lets someone turn skills on and off while the app runs, without a deploy. Every skill is on until someone turns it
 * off, so a new skill ships on. The store keeps only the names that are off.
 *
 * ```ts [server/skills.ts]
 * import { defineSkills, skillSettings } from "vite-hub/skills"
 * import { kv } from "vite-hub/kv"
 *
 * export default skillSettings(defineSkills(import.meta.glob("../skills/**", { query: "?raw", import: "default", eager: true })), { store: kv })
 * ```
 *
 * Pass `settings.enabled` to {@link serveSkills} and {@link skillsMcp}. With the file at `server/skills.ts`, the
 * Console section **Served skills** and `vitehub served-skills` show and change the switches.
 */
export function skillSettings<TSkill extends Skill>(skills: SkillList<TSkill>, options: SkillSettingsOptions): SkillSettings<TSkill> {
  const { store } = options
  const key = options.key ?? "vitehub:skills:disabled"
  const ttlMs = options.ttlMs ?? 60_000
  let cached: { at: number, disabled: Promise<Result<Set<string>, "SKILL_SETTINGS_UNAVAILABLE">> } | undefined

  async function read(): Promise<Result<Set<string>, "SKILL_SETTINGS_UNAVAILABLE">> {
    const [error, value] = await store.get(key)
    if (error) return [skillErrors.SKILL_SETTINGS_UNAVAILABLE({ action: "read", cause: error }), undefined]
    return [undefined, new Set(Array.isArray(value) ? value.filter(name => typeof name === "string") : [])]
  }

  function disabled(): Promise<Result<Set<string>, "SKILL_SETTINGS_UNAVAILABLE">> {
    if (cached && Date.now() - cached.at < ttlMs) return cached.disabled
    const current = { at: Date.now(), disabled: read() }
    cached = current
    // A failed read must not stay for `ttlMs`: the next call tries again.
    void current.disabled.then(([error]) => {
      if (error && cached === current) cached = undefined
    })
    return current.disabled
  }

  async function list(): Promise<Result<SkillState<TSkill>[], "SKILL_SETTINGS_UNAVAILABLE">> {
    const [error, off] = await disabled()
    if (error) return [error, undefined]
    return [undefined, (await resolveSkills(skills)).map(skill => ({ enabled: !off.has(skill.name), skill }))]
  }

  return {
    [settingsBrand]: true,
    enabled: async () => {
      const [error, states] = await list()
      if (error) throw error
      return states.filter(state => state.enabled).map(state => state.skill)
    },
    list,
    async set(name, enabled) {
      const skill = (await resolveSkills(skills)).find(entry => entry.name === name)
      if (!skill) return [skillErrors.SKILL_NOT_FOUND({ uri: `skill://${name}` }), undefined]
      // Read the store, not the cache, so a change from another instance in the last `ttlMs` stays.
      const [readError, off] = await read()
      if (readError) return [readError, undefined]
      if (enabled) off.delete(name)
      else off.add(name)
      const [writeError] = await store.set(key, [...off].sort())
      if (writeError) return [skillErrors.SKILL_SETTINGS_UNAVAILABLE({ action: "write", cause: writeError }), undefined]
      cached = { at: Date.now(), disabled: Promise.resolve([undefined, off]) }
      return [undefined, { enabled, skill }]
    },
    skills,
  }
}
