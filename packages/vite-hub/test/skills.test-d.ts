import { expectTypeOf, it } from "vitest"

import { defineSkill, serveSkills, skillSettings, skillsMcp } from "../src/skills.ts"

import type { KVStorage } from "@vite-hub/kv"

import type { Skill } from "../src/skills.ts"

it("types the MCP results with the SKILL_NOT_FOUND code", async () => {
  const mcp = skillsMcp([])
  const listed = await mcp.list()
  expectTypeOf(listed.resultType).toEqualTypeOf<"complete">()
  expectTypeOf(listed.cacheScope).toEqualTypeOf<"private">()
  expectTypeOf(listed.ttlMs).toEqualTypeOf<number>()
  const [error] = await mcp.get("skill://release")
  if (error) expectTypeOf(error.code).toEqualTypeOf<"SKILL_NOT_FOUND">()
  const [readError, read] = await mcp.read("skill://release/SKILL.md")
  if (!readError) {
    expectTypeOf(read.contents[0].uri).toEqualTypeOf<string>()
    expectTypeOf(read.resultType).toEqualTypeOf<"complete">()
  }
})

it("accepts a list or a function that returns one", () => {
  const skill = defineSkill({ "SKILL.md": "" })
  expectTypeOf(serveSkills(new Request("https://a.test"), [skill])).toEqualTypeOf<Promise<Response | undefined>>()
  serveSkills(new Request("https://a.test"), async () => [{ ...skill, source: "https://example.com" }])
  // @ts-expect-error A list of names is not a list of skills.
  serveSkills(new Request("https://a.test"), ["release"])
  expectTypeOf<Skill["files"][number]["bytes"]>().toEqualTypeOf<Uint8Array<ArrayBuffer>>()
})

it("takes a ViteHub KV store and keeps the skill type", async () => {
  const kv = {} as KVStorage
  const skill = { ...defineSkill({ "SKILL.md": "" }), source: "https://example.com" }
  const settings = skillSettings([skill], { store: kv })
  expectTypeOf(await settings.enabled()).toEqualTypeOf<typeof skill[]>()
  serveSkills(new Request("https://a.test"), settings.enabled)
  skillsMcp(settings.enabled)
  const [error] = await settings.set("release", false)
  if (error) expectTypeOf(error.code).toEqualTypeOf<"SKILL_NOT_FOUND" | "SKILL_SETTINGS_UNAVAILABLE">()
  // @ts-expect-error A store needs `get` and `set`.
  skillSettings([skill], { store: { get: kv.get } })
})
