import { describe, expect, it } from "vitest";
import { readBabysitterFeedback } from "../src/presets/babysitter/feedback.ts";
import { PullRequestInbox } from "../src/server/github-inbox.ts";

async function snapshot() {
  const inbox = new PullRequestInbox({ path: ":memory:", repositories: ["acme/app"] });
  try {
    await inbox.seed("acme/app", { number: 1, state: "open", head: { sha: "a", ref: "fix" }, base: { ref: "main" } });
    return (await inbox.get("acme/app", 1))!;
  } finally { await inbox.close(); }
}

describe("Babysitter feedback retrieval", () => {
  it("retrieves a long body without losing characters and fences edits between pages", async () => {
    const s = await snapshot();
    const body = "a".repeat(20000) + "The actual finding is at the end.";
    s.reviews["12"] = { id: 12, body, user: { login: "reviewer" } };
    const first = readBabysitterFeedback(s, { kind: "review", id: "12" });
    expect(first.complete).toBe(false);
    const second = readBabysitterFeedback(s, { kind: "review", id: "12", ...first.next });
    expect(first.body + second.body).toBe(body);
    expect(second.complete).toBe(true);
    s.reviews["12"]!.body = "A new finding";
    expect(() => readBabysitterFeedback(s, { kind: "review", id: "12", ...first.next })).toThrow("Feedback changed");
  });

  it("retrieves GraphQL-only inline comments and retains unknown resolution", async () => {
    const s = await snapshot();
    s.threads = [{ id: "thread", comments: { nodes: [{ id: "node", databaseId: 12, body: "Finding", path: "source.ts" }] } }];
    expect(readBabysitterFeedback(s, { kind: "review-comment", id: "12" })).toMatchObject({ body: "Finding", resolution: "unknown", path: "source.ts", headSha: "a" });
    s.threads[0]!.isResolved = true;
    expect(readBabysitterFeedback(s, { kind: "review-comment", id: "node" }).resolution).toBe("resolved");
  });

  it("rejects deleted feedback, other PR selectors, and unversioned continuation", async () => {
    const s = await snapshot();
    s.comments["12"] = { id: 12, body: "deleted", deleted: true };
    expect(() => readBabysitterFeedback(s, { kind: "comment", id: "12" })).toThrow("absent or deleted");
    expect(() => readBabysitterFeedback(s, { kind: "review", id: "elsewhere", repository: "other/repo" })).toThrow();
    s.comments["13"] = { id: 13, body: "body" };
    expect(() => readBabysitterFeedback(s, { kind: "comment", id: "13", offset: 1 })).toThrow("version returned");
    expect(() => readBabysitterFeedback(s, { kind: "comment", id: "13", limit: 100000 })).toThrow();
  });
});
