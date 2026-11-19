import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { afterAll, describe, expect, it } from "vitest"

import { detectCodemods, runCodemod, upgradeCodemods } from "../src/index.ts"

const scratch = fileURLToPath(new URL("../.tmp/auth-accessors-test/", import.meta.url))

afterAll(() => rm(scratch, { recursive: true, force: true }))

async function migrate(files: Record<string, string>) {
  await mkdir(scratch, { recursive: true })
  const cwd = await mkdtemp(join(scratch, "app-"))
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(dirname(join(cwd, path)), { recursive: true })
    await writeFile(join(cwd, path), contents)
  }
  const run = await runCodemod("auth-accessors", { cwd, dryRun: true })
  return { after: Object.fromEntries(run.result.edits.flatMap(edit => edit.after === null ? [] : [[edit.path, edit.after]])), cwd, run }
}

describe("auth-accessors", () => {
  it("keeps replacement bindings in scope across imports and shadowed parameters", async () => {
    const { after } = await migrate({
      "alias.ts": "import { useAuth as current } from '#vitehub/auth/server'\nimport { auth } from '#vitehub/auth/server'\nexport const run = () => auth.api\n",
      "shadow.ts": "import { auth } from 'vite-hub/auth/server'\nexport const run = (useAuth: Function) => auth.api\n",
    })
    expect(after["alias.ts"]).toBe("import { useAuth as current } from '#vitehub/auth/server'\nexport const run = () => current().api\n")
    expect(after["shadow.ts"]).toContain("useAuth as viteHubUseAuth")
    expect(after["shadow.ts"]).toContain("=> viteHubUseAuth().api")
  })

  it("leaves imports and their uses intact when a reference needs manual migration", async () => {
    const auth = "import { auth } from 'vite-hub/auth/server'\ntype Session = typeof auth.$Infer.Session\nexport const api = () => auth.api\n"
    const mixed = "import { isGitHubOrgMember } from 'vite-hub/auth'\nexport const both = async () => [await isGitHubOrgMember(token, 'org'), isGitHubOrgMember(token, 'org')]\n"
    const { after, run } = await migrate({ "auth.ts": auth, "mixed.ts": mixed, "server/utils/identity.ts": "export const user = () => auth.api\n" })
    expect(after).toEqual({})
    expect(run.result.followUps.map(entry => entry.file)).toEqual(["auth.ts", "mixed.ts", "server/utils/identity.ts"])
  })

  it("preserves grouped arguments and nested membership and accessor edits", async () => {
    const { after } = await migrate({
      "member.ts": "import { getAuth } from 'vite-hub/auth/server'\nimport { isGitHubOrgMember } from 'vite-hub/auth'\nexport const member = async () => await isGitHubOrgMember(await isGitHubOrgMember(getAuth().token, 'inner') ? token : null, (audit(), 'outer'))\n",
    })
    expect(after["member.ts"]).toContain("checkGitHubOrgMember((!(await checkGitHubOrgMember(useAuth().token, 'inner'))[0]) ? token : null, (audit(), 'outer'))")
  })

  it("reports membership calls whose organization may be empty", async () => {
    const { after, run } = await migrate({
      "empty.ts": "import { isGitHubOrgMember } from 'vite-hub/auth'\nexport const member = async () => await isGitHubOrgMember(token, '')\n",
      "dynamic.ts": "import { isGitHubOrgMember } from 'vite-hub/auth'\nexport const member = async () => await isGitHubOrgMember(token, org)\n",
    })
    expect(after).toEqual({})
    expect(run.result.followUps).toHaveLength(2)
  })

  it("runs in the release upgrade and is not detected after it", async () => {
    expect(upgradeCodemods.map(codemod => codemod.name)).toContain("auth-accessors")
    const { cwd } = await migrate({
      "server/api/roles.post.ts": "import { auth } from 'vite-hub/auth/server'\nexport default defineHandler(event => auth.api.listUsers({ query: {}, headers: event.req.headers }))\n",
    })
    expect((await detectCodemods(cwd)).map(entry => entry.codemod.name)).toContain("auth-accessors")
    await runCodemod("auth-accessors", { cwd, dryRun: false })
    expect(await readFile(join(cwd, "server/api/roles.post.ts"), "utf8")).toBe("import { useAuth } from 'vite-hub/auth/server'\nexport default defineHandler(event => useAuth().api.listUsers({ query: {}, headers: event.req.headers }))\n")
    expect((await detectCodemods(cwd)).map(entry => entry.codemod.name)).not.toContain("auth-accessors")
  })

  it("replaces auth and getAuth() with one useAuth import", async () => {
    const { after } = await migrate({
      "server/utils/users.ts": [
        "import { auth, getAuth, requireAuth } from \"@vite-hub/auth/server\"",
        "type Instance = typeof auth",
        "export const users = () => getAuth().api.listUsers({ query: {} })",
        "export const context = { auth }",
        "",
      ].join("\n"),
      "server/utils/both.ts": "import { useAuth, getAuth } from 'vite-hub/auth/server'\nexport const a = useAuth()\nexport const b = getAuth()\n",
    })
    expect(after).toEqual({
      "server/utils/users.ts": [
        "import { useAuth, requireAuth } from \"@vite-hub/auth/server\"",
        "type Instance = ReturnType<typeof useAuth>",
        "export const users = () => useAuth().api.listUsers({ query: {} })",
        "export const context = { auth: useAuth() }",
        "",
      ].join("\n"),
      "server/utils/both.ts": "import { useAuth } from 'vite-hub/auth/server'\nexport const a = useAuth()\nexport const b = useAuth()\n",
    })
  })

  it("reports possible server auto-imports without changing application code", async () => {
    const { after, run } = await migrate({
      "server/tasks/cleanup.ts": "export default defineTask({ run: async () => { await getAuth().$context; return auth.api.listUsers({ query: {} }) } })\n",
      "server/api/local.ts": "const auth = { api: {} }\nexport default () => auth.api\n",
      "app/utils/auth.ts": "export const read = () => auth.api\n",
    })
    expect(after).toEqual({})
    expect(run.result.followUps.map(entry => entry.file)).toEqual(["server/tasks/cleanup.ts", "server/tasks/cleanup.ts"])
  })

  it("replaces an awaited isGitHubOrgMember() and reports the other uses", async () => {
    const { after, run } = await migrate({
      "server/utils/team.ts": "import { defineAuth, isGitHubOrgMember } from 'vite-hub/auth'\nexport const member = async (token: string) => await isGitHubOrgMember(token, 'acme', { cacheMs: 300_000 })\n",
      "server/utils/team-later.ts": "import { isGitHubOrgMember } from 'vite-hub/auth'\nexport const member = (token: string) => isGitHubOrgMember(token, 'acme')\n",
    })
    expect(after).toEqual({
      "server/utils/team.ts": "import { defineAuth, checkGitHubOrgMember } from 'vite-hub/auth'\nexport const member = async (token: string) => (!(await checkGitHubOrgMember(token, 'acme', { cacheMs: 300_000 }))[0])\n",
    })
    expect(run.result.followUps).toEqual([expect.objectContaining({ file: "server/utils/team-later.ts", line: 2, message: expect.stringContaining("checkGitHubOrgMember()") })])
  })

  it("reports useSession() in app code, imported or auto-imported, and not H3's on the server", async () => {
    const { after, run } = await migrate({
      "app/components/UserMenu.vue": "<script setup lang=\"ts\">\nconst session = useSession()\n</script>\n<template><span>{{ session.data?.user.name }}</span></template>\n",
      "src/session.ts": "import { useSession } from 'vite-hub/auth/vue'\nexport const state = useSession()\n",
      "server/utils/session.ts": "import { useSession } from 'h3'\nexport const read = (event: never) => useSession(event, { password: 'x' })\n",
    })
    expect(after).toEqual({})
    expect(run.result.followUps.map(entry => [entry.file, entry.line])).toEqual([["app/components/UserMenu.vue", 2], ["src/session.ts", 1]])
  })
})
