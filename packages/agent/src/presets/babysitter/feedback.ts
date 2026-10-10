import { createHash } from "node:crypto";
import * as v from "valibot";
import type { Snapshot, GitHubEvidence, GitHubReviewThread } from "../../server/github-inbox.ts";

const feedbackInputSchema = v.strictObject({
  kind: v.picklist(["comment", "review", "review-comment"]),
  id: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
  offset: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER)), 0),
  limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(16000)), 12000),
  version: v.optional(v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/))),
});

const identities = (item: GitHubEvidence) => [item.id, item.node_id, item.databaseId].filter(value => value !== undefined && value !== null).map(String);
const comments = (thread: GitHubReviewThread) => Array.isArray(thread.comments) ? thread.comments : thread.comments?.nodes ?? [];

/** Read bounded feedback from this claim's durable PR, fencing edits between continuation reads. */
export function readBabysitterFeedback(snapshot: Snapshot, input: unknown) {
  const request = v.parse(feedbackInputSchema, input);
  const matches = (item: GitHubEvidence) => identities(item).includes(request.id);
  const collection = request.kind === "comment" ? snapshot.comments : request.kind === "review" ? snapshot.reviews : snapshot.reviewComments;
  const item = Object.values(collection).find(matches) ?? (request.kind === "review-comment" ? snapshot.threads.flatMap(comments).find(matches) : undefined);
  if (!item || item.deleted) throw new Error("Feedback is absent or deleted from the assigned PR snapshot.");
  const thread = request.kind === "review-comment" ? snapshot.threads.find(value => comments(value).some(comment => identities(comment).some(id => identities(item).includes(id)))) : undefined;
  const body = item.body ?? "";
  const version = createHash("sha256").update(JSON.stringify([body, item.updated_at ?? item.updatedAt, thread?.isResolved])).digest("hex");
  if (request.offset && !request.version) throw new Error("Continue with the version returned by the first feedback read.");
  if (request.version && request.version !== version) throw new Error("Feedback changed during pagination. Read again from offset zero.");
  if (request.offset > body.length) throw new Error("Feedback offset exceeds the body length.");
  const end = Math.min(body.length, request.offset + request.limit);
  return {
    repository: snapshot.repository, number: snapshot.number, headSha: snapshot.pr?.head?.sha,
    generation: snapshot.generation, revision: snapshot.revision ?? 0,
    kind: request.kind, id: request.id, author: item.user?.login ?? item.author?.login,
    path: item.path, line: item.line, commit: item.commit_id ?? item.commit?.oid,
    resolution: thread?.isResolved === true ? "resolved" : thread?.isResolved === false ? "unresolved" : "unknown",
    body: body.slice(request.offset, end), offset: request.offset, totalLength: body.length,
    version, complete: end === body.length,
    next: end === body.length ? undefined : { offset: end, version },
  };
}
