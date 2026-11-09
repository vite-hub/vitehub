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
})
