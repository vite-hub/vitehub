import { betterAuth } from "better-auth"
import { admin } from "better-auth/plugins"
import { describe, expectTypeOf, it } from "vitest"

import { defineComments } from "@vite-hub/comments"
import { defineContent } from "@vite-hub/content"
import { documents } from "@vite-hub/content/collections"

import { cmsAccess, cmsCan, cmsCommentsAuthorize, cmsConsoleAuthorize, cmsContentAuthorize } from "../src/access.ts"

import type { InferAdminRolesFromOption } from "better-auth/plugins"
import type { CmsRoleName } from "../src/access.ts"

describe("CMS access types", () => {
  it("fits the Better Auth admin plugin without casts", () => {
    const auth = betterAuth({ plugins: [admin(cmsAccess)] })
    expectTypeOf(auth.api.setRole).toBeFunction()
    expectTypeOf<InferAdminRolesFromOption<typeof cmsAccess>>().toEqualTypeOf<CmsRoleName>()
  })

  it("fits defineContent, defineComments, and a Console policy", () => {
    defineContent({ workspace: "site", collections: { posts: documents({ path: "posts/*.md", fields: {} }) }, authorize: cmsContentAuthorize })
    defineComments({ authorize: cmsCommentsAuthorize })
    expectTypeOf(cmsConsoleAuthorize({ user: { role: "editor" } })).toEqualTypeOf<true | { sections: string[] }>()
  })

  it("checks only CMS and Better Auth admin permissions", () => {
    expectTypeOf(cmsCan({ role: "editor" }, { content: ["write"], comment: ["create"] })).toEqualTypeOf<boolean>()
    // @ts-expect-error `delete` is not a content action.
    cmsCan(null, { content: ["delete"] })
    // @ts-expect-error `posts` is not a CMS resource.
    cmsCan(null, { posts: ["read"] })
  })
})
