import { describe, expectTypeOf, it } from "vitest"

import { defineAbilities, deny, type AbilityName, type AbilityRefusal } from "../src/abilities.ts"
import { can, requireAbility } from "../src/server.ts"
import { AuthPermission, useAbility, type AuthPermissionProps } from "../src/vue.ts"

import type { AuthAnonymousAuthorization, AuthAuthorization, AuthOptions } from "../src/types.ts"
import type abilities from "./fixtures/abilities.ts"
import type { Post } from "./fixtures/abilities.ts"

// What `.vitehub/types/auth.d.ts` declares for an app with `shared/abilities.ts`.
declare global {
  namespace ViteHub {
    interface AuthRegistry {
      abilities: typeof abilities
    }
  }
}

declare const request: Request
declare const post: Post

describe("ability types", () => {
  it("infers the names from the rules", () => {
    expectTypeOf<AbilityName>().toEqualTypeOf<"posts.create" | "posts.edit" | "posts.delete" | "posts.read" | "posts.move" | "billing.upgrade" | "admin.open" | "posts.review" | "posts.tag" | "posts.draft">()
  })

  it("types the user of a rule from the Auth Definition", () => {
    defineAbilities({
      "profile.edit": (user) => {
        expectTypeOf(user.id).toEqualTypeOf<string>()
        expectTypeOf(user.email).toEqualTypeOf<string>()
        return true
      },
    })
  })

  it("rejects a rule that returns a Promise", () => {
    // @ts-expect-error Rules also run in the browser, so they return at once.
    defineAbilities({ "posts.slow": async () => true })
  })

  it("checks the name and the arguments on the server", async () => {
    expectTypeOf(await requireAbility(request, "posts.edit", post)).toEqualTypeOf<AuthAuthorization>()
    expectTypeOf(await requireAbility(request, "posts.read", post)).toEqualTypeOf<AuthAuthorization | AuthAnonymousAuthorization>()
    expectTypeOf(await can(request, "posts.move", "a", "b")).toEqualTypeOf<boolean>()
    await can(request, "posts.create")

    // @ts-expect-error There is no such ability.
    await requireAbility(request, "posts.publish", post)
    // @ts-expect-error The rule takes a Post.
    await requireAbility(request, "posts.edit", { id: "p1" })
    // @ts-expect-error The rule takes a Post.
    await can(request, "posts.edit")
    // @ts-expect-error The rule takes two strings.
    await can(request, "posts.move", "a")
    await can(request, "posts.review", post)
    await can(request, "posts.review", post, "read")
    await can(request, "posts.tag", "a", "b", "c")
    await can(request, "posts.draft")
  })

  it("checks the name and the arguments in the app", () => {
    const { can } = useAbility()
    expectTypeOf(can("posts.edit", post)).toEqualTypeOf<boolean | undefined>()
    can("posts.draft")
    can("posts.tag", "a", "b")
    // @ts-expect-error Load the post before you ask.
    can("posts.edit", undefined)
    // @ts-expect-error There is no such ability.
    can("posts.publish", post)
    // @ts-expect-error The rule takes a Post.
    can("posts.edit", "p1")
  })

  it("checks the name and the arguments of cannot() and authorize()", () => {
    const { authorize, cannot } = useAbility()
    expectTypeOf(cannot("posts.edit", post)).toEqualTypeOf<boolean | undefined>()
    expectTypeOf(authorize("posts.edit", post)).toEqualTypeOf<Promise<void>>()
    cannot("posts.draft")
    void authorize("posts.move", "a", "b")
    void authorize("posts.tag", "a", "b", "c")
    // @ts-expect-error There is no such ability.
    cannot("posts.publish", post)
    // @ts-expect-error The rule takes a Post.
    cannot("posts.edit", "p1")
    // @ts-expect-error There is no such ability.
    void authorize("posts.publish", post)
    // @ts-expect-error The rule takes a Post.
    void authorize("posts.edit")
    // @ts-expect-error The rule takes two strings.
    void authorize("posts.move", "a")
  })

  it("types rule names, argument tuples and denied slot details", () => {
    type Context<Name extends AbilityName> = NonNullable<ReturnType<typeof AuthPermission<Name>>["__ctx"]>
    expectTypeOf<Context<"posts.edit">["props"]>().toEqualTypeOf<AuthPermissionProps<"posts.edit">>()
    expectTypeOf<Parameters<NonNullable<Context<"billing.upgrade">["slots"]["denied"]>>[0]>()
      .toEqualTypeOf<AbilityRefusal<"billing.upgrade">>()
    AuthPermission({ check: "posts.edit", args: [post] })
    AuthPermission({ check: "posts.draft" })
    AuthPermission({ check: "posts.create" })
    AuthPermission({ check: "posts.move", args: ["a", "b"], pending: true })
    AuthPermission({ check: "posts.review", args: [post, "read"] })
    AuthPermission({ check: "posts.tag", args: ["a", "b"] })
    // @ts-expect-error Unknown rule.
    AuthPermission({ check: "posts.missing" })
    // @ts-expect-error Required argument is missing.
    AuthPermission({ check: "posts.edit" })
    // @ts-expect-error Arguments must match the rule tuple.
    AuthPermission({ check: "posts.move", args: [post] })
    // @ts-expect-error A single argument also uses args.
    AuthPermission({ check: "posts.edit", with: post })
    // @ts-expect-error The rule name uses check.
    AuthPermission({ do: "posts.create" })
    expectTypeOf<AbilityRefusal<"posts.edit">>().toEqualTypeOf<{ code: "not-author", details: undefined } | { code: "signed-out", details: undefined }>()
    expectTypeOf<AbilityRefusal<"billing.upgrade">>().toEqualTypeOf<{ code: "plan-limit", details: { readonly limit: 3 } } | { code: "signed-out", details: undefined }>()
    expectTypeOf(deny("x", { status: 429 }).status).toEqualTypeOf<400 | 401 | 402 | 403 | 404 | 405 | 409 | 410 | 422 | 423 | 429 | 451>()
    // @ts-expect-error A rule refuses with a 4xx status.
    deny("x", { status: 500 })
  })

  it("takes the Nuxt component prefix in the Auth options", () => {
    expectTypeOf<{ components: { prefix: "Auth" } }>().toExtend<AuthOptions>()
    // @ts-expect-error The prefix is a string.
    const numeric: AuthOptions = { components: { prefix: 1 } }
    void numeric
  })
})
