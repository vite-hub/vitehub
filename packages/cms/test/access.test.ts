import { describe, expect, it } from "vitest"
import { z } from "zod"

import { defineContent } from "@vite-hub/content"
import { documents } from "@vite-hub/content/collections"

import { cmsAccess, cmsCan, cmsCommentsAuthorize, cmsConsoleAuthorize, cmsContentAuthorize, cmsRoles } from "../src/access.ts"
import { runCmsRoles } from "../src/cli.ts"
import cms from "../src/index.ts"

import type { CmsRoleName } from "../src/access.ts"

const contentActions = ["read", "write", "publish"] as const
const commentActions = ["read", "comment", "resolve"] as const

// What each role may do: the Content actions of `content.can()` and the live Comments actions.
const allowed: Record<CmsRoleName, { content: readonly string[], comments: readonly string[] }> = {
  user: { content: [], comments: [] },
  viewer: { content: ["read"], comments: [] },
  commenter: { content: ["read"], comments: ["read", "comment", "resolve"] },
  editor: { content: ["read", "write"], comments: ["read", "comment", "resolve"] },
  publisher: { content: ["read", "write", "publish"], comments: ["read", "comment", "resolve"] },
  admin: { content: ["read", "write", "publish"], comments: ["read", "comment", "resolve"] },
}

const contentCases = Object.entries(allowed).flatMap(([role, { content }]) =>
  contentActions.map(action => ({ role, action, expected: content.includes(action) })))
const commentCases = Object.entries(allowed).flatMap(([role, { comments }]) =>
  commentActions.map(action => ({ role, action, expected: comments.includes(action) })))

describe("CMS roles", () => {
  it.each(contentCases)("$role may $action content: $expected", ({ role, action, expected }) => {
    expect(cmsContentAuthorize({ user: { id: "u1", role }, collection: "posts", action })).toBe(expected)
    expect(cmsCan({ role }, { content: [action] })).toBe(expected)
  })

  it.each(commentCases)("$role may $action comments: $expected", ({ role, action, expected }) => {
    expect(cmsCommentsAuthorize({ user: { id: "u1", role }, action })).toBe(expected)
  })

  it("maps the actions of Operations Comments", () => {
    expect(cmsCommentsAuthorize({ user: { id: "u1", role: "commenter" }, action: "write" })).toBe(true)
    expect(cmsCommentsAuthorize({ user: { id: "u1", role: "commenter" }, action: "delete" })).toBe(false)
    expect(cmsCommentsAuthorize({ user: { id: "u1", role: "publisher" }, action: "delete" })).toBe(true)
    expect(cmsCommentsAuthorize({ user: { id: "u1", role: "viewer" }, action: "write" })).toBe(false)
  })

  it("denies a missing user, a user without a role, and unknown roles", () => {
    expect(cmsCan(null, { content: ["read"] })).toBe(false)
    expect(cmsCan(undefined, { content: ["read"] })).toBe(false)
    expect(cmsCan({ email: "a@vitehub.dev" }, { content: ["read"] })).toBe(false)
    expect(cmsCan({ role: null }, { content: ["read"] })).toBe(false)
    expect(cmsCan({ role: ["editor"] }, { content: ["read"] })).toBe(false)
    expect(cmsCan({ role: "owner" }, { content: ["read"] })).toBe(false)
    expect(cmsCan({ role: "constructor" }, { content: ["read"] })).toBe(false)
    expect(cmsCan({ role: "" }, { content: ["read"] })).toBe(false)
    expect(cmsCommentsAuthorize({ user: null, action: "read" })).toBe(false)
  })

  it("allows an action when any of several comma-separated roles has it", () => {
    expect(cmsCan({ role: "user,publisher" }, { content: ["publish"] })).toBe(true)
    expect(cmsCan({ role: "viewer, editor" }, { content: ["write"] })).toBe(true)
    expect(cmsCan({ role: "owner,viewer" }, { content: ["read"] })).toBe(true)
    expect(cmsCan({ role: "viewer,commenter" }, { content: ["write"] })).toBe(false)
  })

  it("needs every action of one request from one role", () => {
    expect(cmsCan({ role: "editor" }, { content: ["read", "write"] })).toBe(true)
    expect(cmsCan({ role: "editor" }, { content: ["write", "publish"] })).toBe(false)
    expect(cmsCan({ role: "editor" }, {})).toBe(false)
  })

  it("keeps the Better Auth admin permissions on admin and none on user", () => {
    expect(cmsCan({ role: "admin" }, { user: ["set-role", "ban"], session: ["revoke"] })).toBe(true)
    expect(cmsCan({ role: "publisher" }, { user: ["set-role"] })).toBe(false)
    expect(cmsCan({ role: "user" }, { user: ["list"] })).toBe(false)
    expect(cmsAccess).toMatchObject({ ac: { statements: { content: ["read", "write", "publish"], comment: ["read", "create", "resolve", "delete"] } }, defaultRole: "user", adminRoles: ["admin"] })
    expect(cmsAccess.roles).toBe(cmsRoles)
  })

  it("gives the Console sections of each role", () => {
    expect(cmsConsoleAuthorize({ user: { role: "admin" } })).toBe(true)
    expect(cmsConsoleAuthorize({ user: { role: "publisher" } })).toEqual({ sections: ["content", "comments"] })
    expect(cmsConsoleAuthorize({ user: { role: "commenter" } })).toEqual({ sections: ["content", "comments"] })
    expect(cmsConsoleAuthorize({ user: { role: "viewer" } })).toEqual({ sections: ["content"] })
    expect(cmsConsoleAuthorize({ user: { role: "user" } })).toEqual({ sections: [] })
    expect(cmsConsoleAuthorize({})).toEqual({ sections: [] })
  })
})

describe("the default policy of defineContent({ extends: cms })", () => {
  const collections = { posts: documents({ path: "posts/*.md", fields: { title: z.string() } }) }

  it("rejects unsupported access modes", () => {
    expect(() => defineContent({ extends: [cms, { access: "implicit" as never }], collections, logger: false })).toThrow('option "access" must be "roles"')
  })

  it("does not grant access from an unrelated application role", async () => {
    const content = defineContent({ extends: cms, collections, logger: false })
    try {
      expect(content.hasPolicy).toBe(false)
      for (const role of ["editor", "publisher", "admin"]) {
        expect(await content.can({ user: { id: "u1", role }, collection: "posts", action: "read" })).toBe(false)
      }
    }
    finally {
      content.dispose()
    }
  })

  it("applies the CMS roles only when the preset opts in", async () => {
    const content = defineContent({ extends: [cms, { access: "roles" }], collections, logger: false })
    try {
      expect(content.hasPolicy).toBe(true)
      expect(await content.can({ user: { id: "u1", role: "editor" }, collection: "posts", action: "write" })).toBe(true)
      expect(await content.can({ user: { id: "u1", role: "editor" }, collection: "posts", action: "publish" })).toBe(false)
      expect(await content.can({ user: { id: "u1", role: "publisher,viewer" }, collection: "posts", action: "publish" })).toBe(true)
      // Without the Better Auth admin plugin, users have no role, so everything is denied.
      expect(await content.can({ user: { id: "u1" }, collection: "posts", action: "read" })).toBe(false)
      expect(await content.can({ user: { id: "u1", role: "user" }, collection: "posts", action: "read" })).toBe(false)
      expect(await content.can({ collection: "posts", action: "read" })).toBe(false)
    }
    finally {
      content.dispose()
    }
  })

  it("uses the app's authorize instead", async () => {
    const content = defineContent({ extends: [cms, { workspace: "site", access: "roles" }], collections, logger: false, authorize: ({ user }) => user?.id === "owner" })
    try {
      expect(await content.can({ user: { id: "owner" }, collection: "posts", action: "publish" })).toBe(true)
      expect(await content.can({ user: { id: "u1", role: "admin" }, collection: "posts", action: "read" })).toBe(false)
    }
    finally {
      content.dispose()
    }
  })

  it("is not set without the preset", async () => {
    const content = defineContent({ workspace: "site", collections, logger: false })
    try {
      expect(content.hasPolicy).toBe(false)
      expect(await content.can({ user: { id: "u1", role: "admin" }, collection: "posts", action: "read" })).toBe(false)
    }
    finally {
      content.dispose()
    }
  })
})

describe("vitehub cms roles", () => {
  function streams() {
    const output = { stdout: "", stderr: "" }
    return {
      output,
      streams: {
        stdout: { write: (chunk: string | Uint8Array) => { output.stdout += String(chunk) } },
        stderr: { write: (chunk: string | Uint8Array) => { output.stderr += String(chunk) } },
      },
    }
  }

  it("prints each role with its permissions", async () => {
    const { output, streams: io } = streams()
    expect(await runCmsRoles([], io)).toBe(0)
    expect(output.stdout.split("\n").slice(0, 7)).toEqual([
      "Role       Content               Comments",
      "user       -                     -",
      "viewer     read                  -",
      "commenter  read                  read, create, resolve",
      "editor     read, write           read, create, resolve",
      "publisher  read, write, publish  read, create, resolve, delete",
      "admin      read, write, publish  read, create, resolve, delete",
    ])
    expect(output.stdout).toContain("admin(cmsAccess)")
  })

  it("prints JSON and rejects unknown arguments", async () => {
    const json = streams()
    expect(await runCmsRoles(["--json"], json.streams)).toBe(0)
    expect(JSON.parse(json.output.stdout).roles[2]).toEqual({ name: "commenter", content: ["read"], comment: ["read", "create", "resolve"] })
    const unknown = streams()
    expect(await runCmsRoles(["--all"], unknown.streams)).toBe(1)
    expect(unknown.output.stderr).toContain("Usage: vitehub cms roles [--json]")
  })
})
