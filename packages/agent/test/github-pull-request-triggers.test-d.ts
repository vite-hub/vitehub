import { it } from "vitest"

import { githubPullRequestTrigger } from "../src/channels.ts"

it("takes the request as text", () => {
  githubPullRequestTrigger({
    events: ["issue_comment"],
    // @ts-expect-error The request line of the pull request prompt is text, not messages.
    invoke: () => ({ input: { prompt: [{ id: "request", role: "user" as const, parts: [{ type: "text" as const, text: "Only summarize this review." }] }] } }),
  })
})
