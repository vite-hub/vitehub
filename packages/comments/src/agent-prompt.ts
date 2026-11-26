import type { CommentAnchor } from "./types.ts"

/** One thread in a prompt: its messages, where it is on the page, and the URLs of its files. */
export interface CommentsAgentPromptThread {
  id: string
  anchor: CommentAnchor
  /** Oldest first. The first message is the comment. */
  messages: readonly { author: string, body: string }[]
  /** The version of the subject that the thread was started on. */
  revision?: number
  /** The URLs of the files of the comment, such as its screenshot. */
  files?: readonly string[]
}

/** The ViteHub MCP of a Console member, and the linked app that the agent checks before it reads the threads. */
export interface CommentsAgentAccess {
  mcp: string
  project: { id: string, teamId: string, url: string }
  /** `true` when the member's MCP access may resolve the threads. */
  resolve: boolean
}

export interface CommentsAgentPromptInput {
  /** The page of the threads. */
  url: string
  threads: readonly CommentsAgentPromptThread[]
  /** Without it, the prompt has no ViteHub MCP steps and asks the agent to report the fixes. */
  agent?: CommentsAgentAccess
}

/** The longest link that `commentsT3CodeLink()` makes. */
export const t3CodeLinkLimit = 8000

const t3CodeNewThread = "https://app.t3.codes/new"
const githubRepository = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/(?!\.+$)[A-Za-z0-9._-]{1,100}$/
const shortest = 40

/** `value` when it names a GitHub repository as `owner/name`. */
export function gitHubRepositoryOf(value: string | undefined): string | undefined {
  return value && githubRepository.test(value) ? value : undefined
}

function cut(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length).trimEnd()}…` : text
}

function where(anchor: CommentAnchor): string {
  if (anchor.kind === "page") return "on the whole page"
  if (anchor.kind === "text") return `on the text "${anchor.exact}" in ${anchor.selector}`
  return `on ${anchor.selector}`
}

function threadLines(thread: CommentsAgentPromptThread, length: number): string[] {
  const [comment, ...replies] = thread.messages
  const version = thread.revision === undefined ? "" : ` (version ${thread.revision})`
  return [
    `"${cut(comment?.body ?? "", length)}" — ${comment?.author ?? "Someone"}, ${where(thread.anchor)}${version}`,
    ...replies.map(reply => `Reply: "${cut(reply.body, length)}" — ${reply.author}`),
    ...(thread.files?.length ? [`Files: ${thread.files.join(" ")}`] : []),
  ]
}

type ThreadsToRead = { ids: readonly string[] } | { page: string }

function steps(agent: CommentsAgentAccess | undefined, toRead: ThreadsToRead): string[] {
  if (!agent) return ["When you are done, tell me what you changed."]
  const { mcp, project, resolve } = agent
  const read = "ids" in toRead
    ? `operation "comments.get", and input { threadId } for ${toRead.ids.length === 1 ? `thread ${toRead.ids[0]}` : `each ID in ${JSON.stringify(toRead.ids)}`}`
    : `operation "comments.list", and input { page: "${toRead.page}", status: "open", limit: 500 } to read the open threads of the page. Pass the last thread as \`before\` for the next page`
  return [
    `In the ViteHub MCP (${mcp}), use list_apps to verify team ${project.teamId} and app ${project.url} (id: ${project.id}). If the team is different, ask me to switch to that team in the Console; if the app is missing, ask me to check the link. Only after both match, call read_operation with the app id, ${read}.`,
    resolve
      ? "When the fix is live, use run_operation with the app id, operation \"comments.resolve\", and input { threadId, reply }. In the reply, say what you changed."
      : "Report the fixes to me without resolving the threads.",
  ]
}

type Detail = number | "titles" | "ids" | "count"

function title(thread: CommentsAgentPromptThread): string {
  return `${thread.id}: "${cut(thread.messages[0]?.body ?? "", shortest)}"`
}

function render({ agent, threads, url }: CommentsAgentPromptInput, detail: Detail): string {
  const page = new URL(url).href
  const one = threads.length === 1
  if (detail === "count") {
    const count = `${threads.length} open ${one ? "comment" : "comments"}`
    const read = agent ? [] : ["Read them in the Comments panel of the page."]
    return [`Fix the ${count} on ${page}`, ...read, ...steps(agent, { page })].join("\n\n")
  }
  const toRead = { ids: threads.map(thread => thread.id) }
  const heading = one ? `Fix this comment on ${page}` : `Fix these ${threads.length} comments on ${page}`
  if (detail === "ids") return [heading, ...steps(agent, toRead)].join("\n\n")
  if (detail === "titles") return [heading, threads.map((thread, index) => one ? title(thread) : `${index + 1}. ${title(thread)}`).join("\n"), ...steps(agent, toRead)].join("\n\n")
  if (one) return [heading, ...threadLines(threads[0]!, detail), ...steps(agent, toRead)].join("\n")
  return [
    heading,
    ...threads.map((thread, index) => threadLines(thread, detail).map((line, at) => at === 0 ? `${index + 1}. ${line}` : `   ${line}`).join("\n")),
    steps(agent, toRead).join("\n"),
  ].join("\n\n")
}

/**
 * The prompt that sends an agent to fix comments: the text of each thread, where it is, and its files. With `agent`, it
 * also tells the agent to read the threads, and to resolve them when the member may, through the ViteHub MCP.
 */
export function commentsAgentPrompt(input: CommentsAgentPromptInput): string {
  return render(input, Number.POSITIVE_INFINITY)
}

/**
 * A link that opens a new T3 Code thread with the prompt of `commentsAgentPrompt()`, in `repository` (`owner/name`)
 * when it is a GitHub repository. The link is at most `t3CodeLinkLimit` characters. A long prompt always keeps its steps:
 * first its messages get shorter, then each thread keeps only its ID and a short title, then only the IDs in the read
 * step. When the IDs do not fit, the prompt names the count, and its read step lists the open threads of the page.
 */
export function commentsT3CodeLink(input: CommentsAgentPromptInput, repository?: string): string {
  const repo = gitHubRepositoryOf(repository)
  const link = (detail: Detail) => {
    const url = new URL(t3CodeNewThread)
    url.searchParams.set("prompt", render(input, detail))
    if (repo) url.searchParams.set("repo", repo)
    return url.href
  }
  const lengths: Detail[] = [Number.POSITIVE_INFINITY]
  for (let length = 2000; length >= shortest; length = Math.floor(length / 2)) lengths.push(length)
  for (const detail of [...lengths, "titles", ...(input.agent ? ["ids" as const] : [])] satisfies Detail[]) {
    const href = link(detail)
    if (href.length <= t3CodeLinkLimit) return href
  }
  return link("count")
}
