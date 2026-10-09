import type { Comment, ForgeEvent, ForgeProvider, Thread, WebhookDelivery } from "forges"
import type { GitHubIssueCommentPayload } from "../channels.ts"
import type { CodeHostTarget } from "./code-host-channel.ts"
import { codeHostPullRequest, codeHostPullRequestMetadata } from "./code-host-channel.ts"
import { AgentHttpError } from "../http-error.ts"
import { hasRuntimeType, isRuntimeRecord as isRecord } from "./runtime-type.ts"

function record(value: unknown): Record<string, unknown> { return isRecord(value) ? value : {} }

function threadPayload(thread: Thread): NonNullable<GitHubIssueCommentPayload["pull_request"]> {
  const branch = (value: NonNullable<Thread["branches"]>["head"] | undefined) => value && ({
    ref: value.ref, sha: value.sha,
    repo: value.repo ? { full_name: `${value.repo.owner}/${value.repo.name}` } : undefined,
  })
  return {
    body: thread.body, title: thread.title, number: Number(thread.ref.number),
    html_url: thread.url, draft: thread.isDraft, user: { login: thread.author?.login },
    labels: thread.labels.map(label => ({ name: label.name })),
    base: branch(thread.branches?.base), head: branch(thread.branches?.head),
  }
}

export async function codeHostChannelPullRequest(provider: ForgeProvider, target: CodeHostTarget) {
  const value = await codeHostPullRequest(provider, target)
  const raw = record(value.raw)
  if (!value.model) return raw
  const payload: ReturnType<typeof threadPayload> & { fork?: boolean } = threadPayload(value.model)
  if (provider.kind === "gitlab" && hasRuntimeType(raw.source_project_id, "number") && hasRuntimeType(raw.target_project_id, "number")) {
    payload.fork = raw.source_project_id !== raw.target_project_id
  }
  return payload
}

export async function codeHostChannelMetadata(provider: ForgeProvider, target: CodeHostTarget, limits: { maxComments: number, maxFiles: number }) {
  const value = await codeHostPullRequestMetadata(provider, target, limits)
  return {
    ...value,
    thread: { ...value.thread, raw: value.thread.model ? threadPayload(value.thread.model) : value.thread.raw },
    comments: value.comments.map(raw => {
      const comment = record(raw)
      const author = record(comment.author || comment.user)
      return { ...comment, html_url: comment.html_url || comment.web_url, user: { ...author, login: author.login || author.username } }
    }),
    files: value.files.map(raw => {
      const file = record(raw)
      return { ...file, filename: file.path, previous_filename: file.previousPath }
    }),
  }
}

/** Project native ownership fields into the existing activity ownership check. */
export function codeHostActivityComment(comment: Comment): unknown {
  const raw = record(comment.raw)
  const author = record(raw.author || raw.user)
  return { ...raw, id: Number(comment.ref.id), body: comment.body,
    user: { login: comment.author?.login || author.login || author.username } }
}

export async function codeHostIngest(provider: ForgeProvider, delivery: WebhookDelivery): Promise<ForgeEvent[]> {
  try { return await provider.webhooks.ingest(delivery) }
  catch (error) {
    if (error instanceof Error && error.name === "WebhookVerificationError") throw new AgentHttpError(401, "[vitehub] Webhook signature verification failed.")
    if (error instanceof SyntaxError) throw new AgentHttpError(400, "[vitehub] Invalid Code Host webhook body.")
    throw error
  }
}

/** Use the shared pull request trigger contract after the client verifies and translates the delivery. */
export async function codeHostWebhookInput(provider: ForgeProvider, delivery: WebhookDelivery) {
  const events = await codeHostIngest(provider, delivery)
  for (const event of events) {
    const thread = event.thread
    if (thread?.kind !== "pull_request" || !event.actor?.login) continue
    const native = record(event.payload)
    const attributes = record(native.object_attributes)
    const changes = record(native.changes)
    const ready = native.object_kind === "merge_request"
      && [record(changes.draft), record(changes.work_in_progress)].some(change => change.previous === true && change.current === false)
    const synchronized = event.action === "synchronised" || (native.object_kind === "merge_request" && attributes.action === "update" && Boolean(attributes.oldrev))
    const action = ready ? "ready_for_review" : synchronized ? "synchronize" : event.action
    const lifecycle = ["opened", "reopened", "ready_for_review", "synchronize"].includes(action)
    if (!lifecycle && !["comment", "review", "review_comment"].includes(event.kind)) continue
    const number = Number(thread.number)
    const repository = `${thread.repo.owner}/${thread.repo.name}`
    const url = provider.urlFor({ thread }) || ""
    const detail = event.detail
    const body = detail && (detail.type === "comment" || detail.type === "review_comment" || detail.type === "review") ? detail.body : undefined
    const nativeComment = record(native.comment)
    const nativeReview = record(native.review)
    const id = detail && (detail.type === "comment" || detail.type === "review_comment") ? Number(detail.comment?.id) : Number(nativeReview.id || attributes.id || number)
    const actor = { id: Number(event.actor.id) || undefined, login: event.actor.login, type: event.actor.isBotHint ? "Bot" : "User" }
    // GitLab notes carry merge_request. Forgejo comments carry issue. Pull request events carry pull_request.
    const rawPullRequest = record(native.merge_request || native.pull_request || native.issue || attributes)
    const payload: GitHubIssueCommentPayload = {
      action: lifecycle ? action : event.kind === "review" ? "submitted" : event.action,
      repository: { full_name: repository, name: thread.repo.name, owner: { login: thread.repo.owner } },
      sender: actor,
      comment: { body, id, user: actor, html_url: nativeComment.html_url || attributes.url, created_at: event.occurredAt.toISOString() },
      issue: { number, title: rawPullRequest.title, body: rawPullRequest.description || rawPullRequest.body,
        user: { login: record(rawPullRequest.author || rawPullRequest.user).username || record(rawPullRequest.user).login },
        labels: Array.isArray(rawPullRequest.labels) ? rawPullRequest.labels.map(label => hasRuntimeType(label, "string") ? { name: label } : { name: record(label).name || record(label).title }) : undefined,
        pull_request: { html_url: url, url: provider.kind === "gitlab"
          ? `${provider.baseUrl}/projects/${encodeURIComponent(repository)}/merge_requests/${number}`
          : `${provider.baseUrl}/repos/${repository}/pulls/${number}` }, html_url: url },
    }
    if (lifecycle || event.kind === "review" || event.kind === "review_comment") {
      payload.pull_request = { ...payload.issue, id: number, url: payload.issue?.pull_request?.url, html_url: url, number }
    }
    if (event.kind === "review") payload.review = {
      id, body: body || url, html_url: url, user: actor,
      state: detail?.type === "review" && detail.state !== "unknown" ? detail.state : "approved",
    }
    return {
      payload,
      github: { deliveryId: event.id, event: lifecycle ? "pull_request" : event.kind === "review" ? "pull_request_review" : event.kind === "review_comment" ? "pull_request_review_comment" : "issue_comment" },
    }
  }
  return { payload: undefined }
}
