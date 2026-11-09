import { describe, expectTypeOf, it } from "vitest"

import { defineAbilities, deny, type AbilityName, type AbilityRefusal } from "../src/abilities.ts"
import { can, requireAbility } from "../src/server.ts"
import { useAbility, type CanProps } from "../src/vue.ts"

import type { AuthAnonymousAuthorization, AuthAuthorization } from "../src/types.ts"
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
    expectTypeOf<AbilityName>().toEqualTypeOf<"posts.create" | "posts.edit" | "posts.delete" | "posts.read" | "posts.move" | "billing.upgrade" | "admin.open">()
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
  })

  it("checks the name and the arguments in the app, which can still be loading", () => {
    const { can } = useAbility()
    expectTypeOf(can("posts.edit", post)).toEqualTypeOf<boolean | undefined>()
    can("posts.edit", undefined)
    // @ts-expect-error There is no such ability.
    can("posts.publish", post)
    // @ts-expect-error The rule takes a Post.
    can("posts.edit", "p1")
  })

  it("types the props of <Can> and the refusals of #denied", () => {
    expectTypeOf<CanProps<"posts.edit">>().toEqualTypeOf<{ do: "posts.edit" } & { with: Post | undefined }>()
    expectTypeOf<CanProps<"posts.move">["with"]>().toEqualTypeOf<[string | undefined, string | undefined] | undefined>()
    expectTypeOf<AbilityRefusal<"posts.edit">>().toEqualTypeOf<{ code: "not-author", details: undefined } | { code: "signed-out", details: undefined }>()
    expectTypeOf<AbilityRefusal<"billing.upgrade">>().toEqualTypeOf<{ code: "plan-limit", details: { readonly limit: 3 } } | { code: "signed-out", details: undefined }>()
    expectTypeOf(deny("x", { status: 429 }).status).toEqualTypeOf<400 | 401 | 402 | 403 | 404 | 405 | 409 | 410 | 422 | 423 | 429 | 451>()
    // @ts-expect-error A rule refuses with a 4xx status.
    deny("x", { status: 500 })
  })
})
