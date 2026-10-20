import { expectTypeOf, it } from "vitest"
import { forgejo, gitlab, pullRequest } from "../src/channels.ts"
import type { ForgeKind, PullRequestFilter, PullRequestOptions, ForgeChannelOptions } from "../src/channels.ts"

it("keeps Forge options neutral and infers message methods", () => {
  expectTypeOf<ForgeKind>().toEqualTypeOf<"github" | "gitlab" | "forgejo">()
  const channel = gitlab({ message: { methods: { label: (_context, name: string) => name } } })
  expectTypeOf(channel.kind).toEqualTypeOf<"gitlab">()
  expectTypeOf(forgejo().kind).toEqualTypeOf<"forgejo">()
  expectTypeOf(pullRequest.read({ context: { get: () => undefined } }).provider).toEqualTypeOf<ForgeKind>()
  const options: PullRequestOptions = { reconcile: { comments: { events: ["comment", "review", "review_comment"] } } }
  gitlab({ pullRequest: options })
  gitlab({ sync: { repositories: ["platform/team/api"] as const } })
  forgejo({ sync: { repositories: ["platform/api"] as const } })
  // @ts-expect-error Webhook sync requires repository names.
  gitlab({ sync: {} })
  // @ts-expect-error Repository names must be strings.
  forgejo({ sync: { repositories: [1] } })
  gitlab({ pullRequest: { reconcile: { events: ["ready_for_review"] } } })
  forgejo({ pullRequest: { reconcile: { events: ["opened", "synchronize"] } } })
  // @ts-expect-error Forgejo sends no ready for review event.
  forgejo({ pullRequest: { reconcile: { events: ["ready_for_review"] } } })
  // @ts-expect-error Forge Channels do not provide checkout.
  gitlab({ pullRequest: { workspace: true } })
  // @ts-expect-error Forge Channels always verify webhooks.
  forgejo({ webhookSecret: false })
  // @ts-expect-error Author association is specific to GitHub.
  const filter: PullRequestFilter = { authorAssociation: { allow: ["OWNER"] } }
  // @ts-expect-error Forge Channels do not publish artifacts.
  const artifacts: ForgeChannelOptions = { artifacts: true }
  void filter
  void artifacts
})
