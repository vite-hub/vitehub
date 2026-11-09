import { defineAbilities, deny, guest } from "../../src/abilities.ts"

export interface Post {
  authorId: string
  published: boolean
}

// The rules that the ability tests register, at runtime through `#vitehub/auth/abilities` and in the types through
// `ViteHub.AuthRegistry` (see abilities.test-d.ts).
export default defineAbilities({
  "posts.create": user => Boolean(user.emailVerified) || "unverified",
  "posts.edit": (user, post: Post) => user.id === post.authorId || "not-author",
  "posts.delete": (user, post: Post) => user.id === post.authorId || deny("not-found", { status: 404 }),
  "posts.read": guest((user, post: Post) => post.published || user?.id === post.authorId),
  "posts.move": (user, from: string, to: string) => from !== to,
  "billing.upgrade": () => deny("plan-limit", { status: 402, details: { limit: 3 } }),
  "admin.open": user => user.name === "Admin",
  // A default, a rest, and an optional parameter: `Function.length` counts none of them.
  "posts.review": (user, post: Post, mode: "edit" | "read" = "edit") => mode === "read" || user.id === post.authorId || "not-author",
  "posts.tag": (_user, ...tags: string[]) => tags.length > 0 && tags.length <= 2 || deny("tags", { status: 422 }),
  "posts.draft": (user, post?: Post) => !post || user.id === post.authorId,
})
