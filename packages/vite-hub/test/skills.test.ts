import { createHash } from "node:crypto"

import { parseTarGzip } from "nanotar"
import { describe, expect, it, vi } from "vitest"

import { defineSkill, defineSkills, isSkillSettings, serveSkills, skillArchive, skillDigest, skillSettings, skillsMcp } from "../src/skills.ts"

import type { Skill, SkillSettingsStore } from "../src/skills.ts"

const releaseMd = "---\nname: release\ndescription: Ship a release.\nlicense: MIT\n---\n\n# Release\n"
const handoffMd = "---\nname: handoff\ndescription: Hand work to the next agent.\n---\n\n# Handoff\n"
const checklist = "# Checklist\n"

const release = defineSkill({ "references/checklist.md": checklist, "SKILL.md": releaseMd, "assets/logo.png": new Uint8Array([137, 80, 78, 71]) })
const handoff = defineSkill({ "SKILL.md": handoffMd })

const get = (path: string, init?: RequestInit) => new Request(`https://app.example.com${path}`, init)
const sha256 = (bytes: Uint8Array | string) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`

async function json(response: Response | undefined): Promise<unknown> {
  expect(response?.status).toBe(200)
  return JSON.parse(await response!.text())
}

describe("defineSkill", () => {
  it("normalizes UTF-8 SKILL.md bytes without changing their digest", async () => {
    const markdown = `\uFEFF${releaseMd}`
    const bytes = new TextEncoder().encode(markdown)
    const skill = defineSkill({ "SKILL.md": bytes })
    expect(skill.files[0]?.text).toBe(markdown)
    expect(await skillDigest(skill)).toBe(sha256(bytes))
    expect(await skillsMcp([skill]).read("skill://release/SKILL.md")).toMatchObject([undefined, { contents: [{ text: markdown }] }])
    expect(() => defineSkill({ "SKILL.md": new Uint8Array([...bytes, 0xff]) })).toThrow(expect.objectContaining({ code: "SKILL_INVALID_FRONTMATTER" }))
  })

  it("accepts frontmatter boundaries and preserves unknown fields", () => {
    const skill = defineSkill({ "SKILL.md": `---\nname: release\ndescription: ${"x".repeat(1024)}\ncompatibility: ${"x".repeat(500)}\nmetadata:\n  version: "1"\nallowed-tools: Read Bash(git:*)\nfuture: [value]\n---\n` })
    expect(skill.frontmatter).toMatchObject({ "allowed-tools": "Read Bash(git:*)", future: ["value"], metadata: { version: "1" } })
  })

  it.each([
    `description: ${"x".repeat(1025)}`,
    "description: [x]",
    "compatibility: 1",
    "compatibility: ''",
    `compatibility: ${"x".repeat(501)}`,
    "metadata: null",
    "metadata: [x]",
    "metadata: text",
    "metadata: { version: 1 }",
    "allowed-tools: [Read]",
    "license: [MIT]",
  ])("rejects invalid frontmatter field %s", (field) => {
    const description = field.startsWith("description:") ? "" : "description: Release.\n"
    expect(() => defineSkill({ "SKILL.md": `---\nname: release\n${description}${field}\n---\n` })).toThrow(expect.objectContaining({ code: "SKILL_INVALID_FRONTMATTER" }))
  })

  it("reads the frontmatter and puts SKILL.md first, then the files by path", () => {
    expect(release.name).toBe("release")
    expect(release.description).toBe("Ship a release.")
    expect(release.frontmatter).toEqual({ description: "Ship a release.", license: "MIT", name: "release" })
    expect(release.files.map(file => [file.path, file.mimeType, file.text !== undefined])).toEqual([
      ["SKILL.md", "text/markdown", true],
      ["assets/logo.png", "image/png", false],
      ["references/checklist.md", "text/markdown", true],
    ])
  })

  it.each([
    [{ "README.md": "# No skill" }, "SKILL_FILE_MISSING"],
    [{ "SKILL.md": "# No frontmatter" }, "SKILL_INVALID_FRONTMATTER"],
    [{ "SKILL.md": "---\nname: Release Notes\ndescription: x\n---\n" }, "SKILL_INVALID_FRONTMATTER"],
    [{ "SKILL.md": `---\nname: ${"a".repeat(65)}\ndescription: x\n---\n` }, "SKILL_INVALID_FRONTMATTER"],
    [{ "SKILL.md": "---\nname: release\n---\n" }, "SKILL_INVALID_FRONTMATTER"],
    [{ "SKILL.md": "---\nname: release\ndescription: [unclosed\n---\n" }, "SKILL_INVALID_FRONTMATTER"],
    [{ "SKILL.md": releaseMd, "../secret.md": "x" }, "SKILL_INVALID_PATH"],
    [{ "SKILL.md": releaseMd, "/etc/passwd": "x" }, "SKILL_INVALID_PATH"],
    [{ "SKILL.md": releaseMd, "references\\a.md": "x" }, "SKILL_INVALID_PATH"],
    [{ "SKILL.md": releaseMd, "references//a.md": "x" }, "SKILL_INVALID_PATH"],
  ])("rejects %j with %s", (files, code) => {
    expect(() => defineSkill(files)).toThrow(expect.objectContaining({ code, docs: `https://vitehub.dev/docs/development/diagnostics/${code.toLowerCase()}` }))
  })
})

describe("defineSkills", () => {
  it("groups glob keys by the folder of each SKILL.md and leaves other files out", () => {
    const skills = defineSkills({
      "../../skills/README.md": "# Skills",
      "../../skills/release/SKILL.md": releaseMd,
      "../../skills/release/references/checklist.md": checklist,
      "../../skills/handoff/SKILL.md": handoffMd,
    })
    expect(skills.map(skill => [skill.name, skill.files.map(file => file.path)])).toEqual([
      ["handoff", ["SKILL.md"]],
      ["release", ["SKILL.md", "references/checklist.md"]],
    ])
  })

  it("keeps nested files in both skills with shared MCP resource URIs", async () => {
    const nestedMd = "---\nname: nested\ndescription: A nested skill.\n---\n"
    const skills = defineSkills({ "release/SKILL.md": releaseMd, "release/nested/SKILL.md": nestedMd, "release/nested/a.md": "a", "release/b.md": "b" })
    expect(skills.map(skill => [skill.name, skill.files.map(file => file.path)])).toEqual([
      ["nested", ["SKILL.md", "a.md"]],
      ["release", ["SKILL.md", "b.md", "nested/SKILL.md", "nested/a.md"]],
    ])
    const mcp = skillsMcp(skills)
    const { skills: listed } = await mcp.list()
    expect(listed.map(skill => skill.uri)).toEqual(["skill://release/nested/SKILL.md", "skill://release/SKILL.md"])
    expect(listed[1]?.resources.map(file => file.uri)).toContain(listed[0]?.uri)
    expect((await mcp.get("skill://release/nested"))[1]?.skill).toEqual(listed[0])
    expect((await mcp.get("skill://release/nested/SKILL.md"))[1]?.skill).toEqual(listed[0])
    expect((await mcp.read("skill://release/nested/a.md"))[1]?.contents).toEqual([{ mimeType: "text/markdown", text: "a", uri: "skill://release/nested/a.md" }])
    const resources = await mcp.resources()
    expect(resources).toHaveLength(4)
    expect(resources.find(file => file.uri === listed[0]?.uri)?.description).toBe("A nested skill.")
    expect((await parseTarGzip(await skillArchive(skills[1]!))).map(file => file.name)).toEqual(["SKILL.md", "b.md", "nested/SKILL.md", "nested/a.md"])
    expect(await (await serveSkills(get("/.well-known/skills/release/nested/a.md"), skills))?.text()).toBe("a")
  })

  it("requires the folder to match the name, and unique names", () => {
    expect(() => defineSkills({ "notes/SKILL.md": releaseMd })).toThrow(expect.objectContaining({ code: "SKILL_INVALID_FRONTMATTER" }))
    expect(() => defineSkills({ "a/release/SKILL.md": releaseMd, "b/release/SKILL.md": releaseMd })).toThrow(expect.objectContaining({ code: "SKILL_DUPLICATE_NAME" }))
  })
})

describe("serveSkills", () => {
  const skills = [release, handoff]

  it("returns undefined for paths outside the discovery folders", async () => {
    expect(await serveSkills(get("/"), skills)).toBeUndefined()
    expect(await serveSkills(get("/.well-known/skills"), skills)).toBeUndefined()
    expect(await serveSkills(get("/.well-known/oauth-protected-resource"), skills)).toBeUndefined()
  })

  it("serves the v0.2.0 index with a SKILL.md or an archive per skill, and digests of those bytes", async () => {
    const response = await serveSkills(get("/.well-known/agent-skills/index.json"), skills)
    expect(response?.headers.get("content-type")).toBe("application/json")
    expect(response?.headers.get("cache-control")).toBe("public, max-age=60")
    const index = await json(response)
    const archive = await serveSkills(get("/.well-known/agent-skills/release.tar.gz"), skills)
    expect(archive?.headers.get("content-type")).toBe("application/gzip")
    const archiveBytes = new Uint8Array(await archive!.arrayBuffer())
    const skillMd = await serveSkills(get("/.well-known/agent-skills/handoff/SKILL.md"), skills)
    expect(skillMd?.headers.get("content-type")).toBe("text/markdown; charset=utf-8")

    expect(index).toEqual({
      $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
      skills: [
        { description: "Ship a release.", digest: sha256(archiveBytes), name: "release", type: "archive", url: "/.well-known/agent-skills/release.tar.gz" },
        { description: "Hand work to the next agent.", digest: sha256(await skillMd!.text()), name: "handoff", type: "skill-md", url: "/.well-known/agent-skills/handoff/SKILL.md" },
      ],
    })
  })

  it("archives a skill with SKILL.md at the root and the same bytes every time", async () => {
    const entries = await parseTarGzip(await skillArchive(release))
    expect(entries.map(entry => [entry.name, [...entry.data ?? []]])).toEqual([
      ["SKILL.md", [...new TextEncoder().encode(releaseMd)]],
      ["assets/logo.png", [137, 80, 78, 71]],
      ["references/checklist.md", [...new TextEncoder().encode(checklist)]],
    ])
    // A tar archive ends with two zero blocks, also when the files fill a 10240-byte record exactly.
    const full = defineSkill({ "SKILL.md": releaseMd, "x.txt": "x".repeat(8704) })
    const tar = new Uint8Array(await new Response(new Response(await skillArchive(full)).body!.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer())
    expect(tar.subarray(-1024).every(byte => byte === 0)).toBe(true)
    expect((await parseTarGzip(await skillArchive(full))).map(entry => entry.name)).toEqual(["SKILL.md", "x.txt"])
    const copy = defineSkill({ "SKILL.md": releaseMd, "assets/logo.png": new Uint8Array([137, 80, 78, 71]), "references/checklist.md": checklist })
    expect(await skillDigest(copy)).toBe(await skillDigest(release))
  })

  it("serves the v0.1.0 index that npx skills reads, with a version that follows the files", async () => {
    expect(await json(await serveSkills(get("/.well-known/skills/index.json"), skills))).toEqual({
      skills: [
        { description: "Ship a release.", files: ["SKILL.md", "assets/logo.png", "references/checklist.md"], name: "release", version: (await skillDigest(release)).slice(7, 19) },
        { description: "Hand work to the next agent.", files: ["SKILL.md"], name: "handoff", version: (await skillDigest(handoff)).slice(7, 19) },
      ],
    })
    const reference = await serveSkills(get("/.well-known/skills/release/references/checklist.md"), skills)
    expect(await reference?.text()).toBe(checklist)
    const logo = await serveSkills(get("/.well-known/skills/release/assets/logo.png"), skills)
    expect(logo?.headers.get("content-type")).toBe("image/png")
    expect(new Uint8Array(await logo!.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]))
  })

  it("answers 404 for unknown skills and files, 405 for other methods, and no body for HEAD", async () => {
    for (const path of ["/.well-known/skills/missing/SKILL.md", "/.well-known/skills/release/missing.md", "/.well-known/skills/release", "/.well-known/skills/handoff.tar.gz", "/.well-known/agent-skills/missing.tar.gz", "/.well-known/skills/%E0%A4%A"]) {
      expect((await serveSkills(get(path), skills))?.status, path).toBe(404)
    }
    const post = await serveSkills(get("/.well-known/skills/index.json", { method: "POST" }), skills)
    expect([post?.status, post?.headers.get("allow")]).toEqual([405, "GET, HEAD"])
    const head = await serveSkills(get("/.well-known/skills/release/SKILL.md", { method: "HEAD" }), skills)
    expect([head?.status, head?.headers.get("content-type"), await head?.text()]).toEqual([200, "text/markdown; charset=utf-8", ""])
  })

  it("reads a list function on every request, below a base path, with a custom Cache-Control", async () => {
    let enabled: Skill[] = [release, handoff]
    const options = { base: "/docs/", cacheControl: "no-store" }
    const names = async () => ((await json(await serveSkills(get("/docs/.well-known/skills/index.json"), () => enabled, options))) as { skills: Array<{ name: string }> }).skills.map(skill => skill.name)
    expect(await names()).toEqual(["release", "handoff"])
    enabled = [handoff]
    expect(await names()).toEqual(["handoff"])
    expect((await serveSkills(get("/docs/.well-known/skills/release/SKILL.md"), () => enabled, options))?.status).toBe(404)
    expect((await serveSkills(get("/.well-known/skills/index.json"), () => enabled, options))).toBeUndefined()
    const index = await json(await serveSkills(get("/docs/.well-known/agent-skills/index.json"), async () => [release], options))
    expect(index).toMatchObject({ skills: [{ url: "/docs/.well-known/agent-skills/release.tar.gz" }] })
    expect((await serveSkills(get("/docs/.well-known/skills/index.json"), [], options))?.headers.get("cache-control")).toBe("no-store")
  })

  it("serves only the first skill of each name in runtime discovery lists", async () => {
    const duplicate = defineSkill({ "SKILL.md": releaseMd.replace("Ship a release.", "Another release."), "other.md": "Only in the duplicate." })
    const current = async () => [release, duplicate, handoff]
    for (const root of ["/.well-known/agent-skills/", "/.well-known/skills/"]) {
      expect(await json(await serveSkills(get(`${root}index.json`), current))).toEqual(await json(await serveSkills(get(`${root}index.json`), [release, handoff])))
      expect(await (await serveSkills(get(`${root}release/SKILL.md`), current))?.text()).toBe(releaseMd)
      expect((await serveSkills(get(`${root}release/other.md`), current))?.status).toBe(404)
    }
    const index = await json(await serveSkills(get("/.well-known/agent-skills/index.json"), current)) as { skills: Array<{ digest: string, url: string }> }
    for (const skill of index.skills) {
      const artifact = await serveSkills(get(skill.url), current)
      expect(sha256(new Uint8Array(await artifact!.arrayBuffer()))).toBe(skill.digest)
    }
  })
})

describe("skillsMcp", () => {
  it("keeps the first skill of each name consistently across MCP methods", async () => {
    const duplicate = defineSkill({ "SKILL.md": releaseMd.replace("Ship a release.", "Another release."), "other.md": "Only in the duplicate." })
    let current = [release, duplicate, handoff]
    const mcp = skillsMcp(() => current)
    const expected = skillsMcp([release, handoff])
    expect(await mcp.list()).toEqual(await expected.list())
    expect(await mcp.resources()).toEqual(await expected.resources())
    expect(await mcp.get("skill://release")).toEqual(await expected.get("skill://release"))
    expect(await mcp.read("skill://release/SKILL.md")).toEqual(await expected.read("skill://release/SKILL.md"))
    expect((await mcp.read("skill://release/other.md"))[0]?.code).toBe("SKILL_NOT_FOUND")
    current = [duplicate, release, handoff]
    expect(await mcp.list()).toEqual(await skillsMcp([duplicate, handoff]).list())
    expect((await mcp.read("skill://release/other.md"))[1]?.contents).toEqual([{ mimeType: "text/markdown", text: "Only in the duplicate.", uri: "skill://release/other.md" }])
  })

  it("returns complete protocol results without caching runtime-selected skills", async () => {
    let enabled = [release]
    const mcp = skillsMcp(() => enabled)
    const [error, skill] = await mcp.get("skill://release/SKILL.md")
    expect(error).toBeUndefined()
    const metadata = { cacheScope: "private", resultType: "complete", ttlMs: 0 }
    expect(await mcp.list()).toEqual({ ...metadata, skills: [skill!.skill] })
    expect(skill).toEqual({ ...metadata, skill: skill!.skill })
    expect((await mcp.read("skill://release/SKILL.md"))[1]).toEqual({ ...metadata, contents: [{ mimeType: "text/markdown", text: releaseMd, uri: "skill://release/SKILL.md" }] })
    enabled = []
    expect(await mcp.list()).toEqual({ ...metadata, skills: [] })
    expect((await mcp.get("skill://release"))[0]?.code).toBe("SKILL_NOT_FOUND")
    expect((await mcp.read("skill://release/SKILL.md"))[0]?.code).toBe("SKILL_NOT_FOUND")
  })

  it("lists skills with a digest and size per file", async () => {
    const mcp = skillsMcp([release, handoff])
    expect(mcp.extension).toBe("io.modelcontextprotocol/skills")
    const { skills } = await mcp.list()
    expect(skills[1]).toEqual({
      frontmatter: { description: "Hand work to the next agent.", name: "handoff" },
      resources: [{ digest: sha256(handoffMd), size: new TextEncoder().encode(handoffMd).byteLength, uri: "skill://handoff/SKILL.md" }],
      uri: "skill://handoff/SKILL.md",
    })
    expect(skills[0]?.resources.map(resource => resource.uri)).toEqual(["skill://release/SKILL.md", "skill://release/assets/logo.png", "skill://release/references/checklist.md"])
  })

  it("gets a skill by its URI and returns SKILL_NOT_FOUND for others", async () => {
    const mcp = skillsMcp(() => [release])
    for (const uri of ["skill://release", "skill://release/SKILL.md"]) {
      const [error, data] = await mcp.get(uri)
      expect(error).toBeUndefined()
      expect(data?.skill.uri).toBe("skill://release/SKILL.md")
    }
    const [error, data] = await mcp.get("skill://handoff")
    expect(data).toBeUndefined()
    expect(error?.code).toBe("SKILL_NOT_FOUND")
    expect(error?.why).toBe("No skill or skill file at skill://handoff.")
  })

  it("lists every file as a resource and reads text and bytes", async () => {
    const mcp = skillsMcp([release])
    expect(await mcp.resources()).toEqual([
      { description: "Ship a release.", mimeType: "text/markdown", name: "release/SKILL.md", size: new TextEncoder().encode(releaseMd).byteLength, title: "release skill", uri: "skill://release/SKILL.md" },
      { mimeType: "image/png", name: "release/assets/logo.png", size: 4, title: "release: assets/logo.png", uri: "skill://release/assets/logo.png" },
      { mimeType: "text/markdown", name: "release/references/checklist.md", size: checklist.length, title: "release: references/checklist.md", uri: "skill://release/references/checklist.md" },
    ])
    expect(await mcp.read("skill://release/references/checklist.md")).toEqual([undefined, { cacheScope: "private", resultType: "complete", ttlMs: 0, contents: [{ mimeType: "text/markdown", text: checklist, uri: "skill://release/references/checklist.md" }] }])
    expect(await mcp.read("skill://release/assets/logo.png")).toEqual([undefined, { cacheScope: "private", resultType: "complete", ttlMs: 0, contents: [{ blob: "iVBORw==", mimeType: "image/png", uri: "skill://release/assets/logo.png" }] }])
    const [error] = await mcp.read("skill://release/missing.md")
    expect(error?.code).toBe("SKILL_NOT_FOUND")
  })
})

/** A KV-like store whose reads and writes the test counts and can make fail. */
function memoryStore(initial?: unknown) {
  const values = new Map<string, unknown>(initial === undefined ? [] : [["vitehub:skills:disabled", initial]])
  const state = { fail: false, reads: 0 }
  const failure = { code: "KV_OPERATION_FAILED", message: "KV is down." }
  const store: SkillSettingsStore = {
    get: async (key) => {
      state.reads++
      // SAFETY: The settings read only `code` and `message` of a store error.
      return state.fail ? [failure as never, undefined] : [undefined, values.get(key) ?? null]
    },
    set: async (key, value) => {
      if (state.fail) return [failure as never, undefined]
      values.set(key, value)
      return [undefined, undefined]
    },
  }
  return { state, store, values }
}

describe("skillSettings", () => {
  it("serves every skill until one is turned off, then leaves it out of discovery and MCP", async () => {
    const { store, values } = memoryStore()
    const settings = skillSettings([release, handoff], { store })
    expect(isSkillSettings(settings)).toBe(true)
    expect(isSkillSettings([release])).toBe(false)
    expect((await settings.enabled()).map(skill => skill.name)).toEqual(["release", "handoff"])

    expect(await settings.set("release", false)).toEqual([undefined, { enabled: false, skill: release }])
    expect(values.get("vitehub:skills:disabled")).toEqual(["release"])
    expect(await settings.list()).toEqual([undefined, [{ enabled: false, skill: release }, { enabled: true, skill: handoff }]])
    const index = await json(await serveSkills(get("/.well-known/skills/index.json"), settings.enabled)) as { skills: Array<{ name: string }> }
    expect(index.skills.map(skill => skill.name)).toEqual(["handoff"])
    expect((await serveSkills(get("/.well-known/skills/release/SKILL.md"), settings.enabled))?.status).toBe(404)
    expect((await skillsMcp(settings.enabled).read("skill://release/SKILL.md"))[0]?.code).toBe("SKILL_NOT_FOUND")

    await settings.set("release", true)
    expect(values.get("vitehub:skills:disabled")).toEqual([])
    expect((await settings.enabled()).map(skill => skill.name)).toEqual(["release", "handoff"])
  })

  it("refuses a name that is not in the list", async () => {
    const { store, values } = memoryStore()
    const [error] = await skillSettings([release], { store }).set("missing", false)
    expect(error?.code).toBe("SKILL_NOT_FOUND")
    expect(values.size).toBe(0)
  })

  it("reuses a read for ttlMs, and keeps changes that another instance wrote", async () => {
    vi.useFakeTimers()
    try {
      const { state, store } = memoryStore(["release"])
      const here = skillSettings([release, handoff], { store, ttlMs: 1000 })
      const there = skillSettings([release, handoff], { store, ttlMs: 1000 })
      expect((await here.enabled()).map(skill => skill.name)).toEqual(["handoff"])
      await there.set("handoff", false)
      // This instance still uses its read, then reads again after ttlMs.
      expect((await here.enabled()).map(skill => skill.name)).toEqual(["handoff"])
      expect(state.reads).toBe(2)
      vi.advanceTimersByTime(1000)
      expect(await here.enabled()).toEqual([])
      // A write reads the store first, so it keeps the other instance's change.
      await here.set("release", true)
      expect(await there.list()).toEqual([undefined, [{ enabled: true, skill: release }, { enabled: false, skill: handoff }]])
    }
    finally {
      vi.useRealTimers()
    }
  })

  it("fails with SKILL_SETTINGS_UNAVAILABLE when the store fails, and reads again on the next call", async () => {
    const { state, store } = memoryStore()
    const settings = skillSettings([release], { store })
    state.fail = true
    await expect(settings.enabled()).rejects.toMatchObject({ code: "SKILL_SETTINGS_UNAVAILABLE", cause: { code: "KV_OPERATION_FAILED" } })
    expect((await settings.set("release", false))[0]?.code).toBe("SKILL_SETTINGS_UNAVAILABLE")
    state.fail = false
    expect(await settings.enabled()).toEqual([release])
  })

  it("ignores a stored value that is not a list of names", async () => {
    const { store } = memoryStore({ release: false })
    expect(await skillSettings([release], { store }).enabled()).toEqual([release])
  })
})
