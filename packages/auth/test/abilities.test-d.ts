import { describe, expectTypeOf, it } from "vitest"

import { defineAbilities, deny, type AbilityName, type AbilityRefusal } from "../src/abilities.ts"
import { can, requireAbility } from "../src/server.ts"
import { Cannot, useAbility, type CanProps } from "../src/vue.ts"

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

  it("types <Cannot> with the props of <Can> and the refusal in its default slot", () => {
    type CannotContext<Name extends AbilityName> = NonNullable<ReturnType<typeof Cannot<Name>>["__ctx"]>
    expectTypeOf<CannotContext<"posts.edit">["props"]>().toEqualTypeOf<CanProps<"posts.edit">>()
    expectTypeOf<CannotContext<"posts.move">["props"]>().toEqualTypeOf<CanProps<"posts.move">>()
    expectTypeOf<Parameters<NonNullable<CannotContext<"billing.upgrade">["slots"]["default"]>>[0]>()
      .toEqualTypeOf<AbilityRefusal<"billing.upgrade">>()
    // @ts-expect-error There is no such ability.
    Cannot({ do: "posts.publish" })
    // @ts-expect-error A rule with one argument takes `with`, not `args`.
    Cannot({ do: "posts.edit", args: [post] })
    // @ts-expect-error A rule with two arguments takes `args`, not `with`.
    Cannot({ do: "posts.move", with: ["a", "b"] })
    Cannot({ do: "posts.move", args: ["a", "b"], pending: true })
  })

  it("types the props of <Can> and the refusals of #denied", () => {
    expectTypeOf<CanProps<"posts.edit">>().toEqualTypeOf<{ do: "posts.edit", pending?: boolean } & { with: Post, args?: never }>()
    expectTypeOf<CanProps<"posts.draft">>().toEqualTypeOf<{ do: "posts.draft", pending?: boolean } & { with?: Post, args?: never }>()
    expectTypeOf<CanProps<"posts.create">>().toEqualTypeOf<{ do: "posts.create", pending?: boolean } & { with?: never, args?: never }>()
    expectTypeOf<CanProps<"posts.move">>().toEqualTypeOf<{ do: "posts.move", pending?: boolean } & { with?: never, args: [from: string, to: string] }>()
    expectTypeOf<CanProps<"posts.review">["args"]>().toEqualTypeOf<[post: Post, mode?: "edit" | "read"]>()
    expectTypeOf<CanProps<"posts.tag">["args"]>().toEqualTypeOf<string[]>()
    // @ts-expect-error A rule with two arguments takes `args`, not `with`.
    const twoWith: CanProps<"posts.move"> = { do: "posts.move", with: ["a", "b"] }
    // @ts-expect-error A rule with one argument takes `with`, not `args`.
    const oneArgs: CanProps<"posts.edit"> = { do: "posts.edit", args: [post] }
    // @ts-expect-error A default parameter puts the rule in `args`.
    const defaultWith: CanProps<"posts.review"> = { do: "posts.review", with: post }
    void [twoWith, oneArgs, defaultWith]
    expectTypeOf<AbilityRefusal<"posts.edit">>().toEqualTypeOf<{ code: "not-author", details: undefined } | { code: "signed-out", details: undefined }>()
    expectTypeOf<AbilityRefusal<"billing.upgrade">>().toEqualTypeOf<{ code: "plan-limit", details: { readonly limit: 3 } } | { code: "signed-out", details: undefined }>()
    expectTypeOf(deny("x", { status: 429 }).status).toEqualTypeOf<400 | 401 | 402 | 403 | 404 | 405 | 409 | 410 | 422 | 423 | 429 | 451>()
    // @ts-expect-error A rule refuses with a 4xx status.
    deny("x", { status: 500 })
  })
})
