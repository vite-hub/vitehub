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
  /** `name` is the app's name in the Console, such as `Acme Docs`. */
  project: { id: string, teamId: string, url: string, name?: string }
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

function where(anchor: CommentAnchor, length: number): string {
  if (anchor.kind === "page") return "on the whole page"
  if (anchor.kind === "text") return `on the text "${cut(anchor.exact, length)}" in ${cut(anchor.selector, length)}`
  return `on ${cut(anchor.selector, length)}`
}

function threadLines(thread: CommentsAgentPromptThread, length: number): string[] {
  const [comment, ...replies] = thread.messages
  const version = thread.revision === undefined ? "" : ` (version ${thread.revision})`
  return [
    `"${cut(comment?.body ?? "", length)}" — ${comment?.author ?? "Someone"}, ${where(thread.anchor, length)}${version}`,
    ...replies.map(reply => `Reply: "${cut(reply.body, length)}" — ${reply.author}`),
    ...(thread.files?.length ? [`Files: ${thread.files.join(" ")}`] : []),
  ]
}

function steps(agent: CommentsAgentAccess | undefined, ids: readonly string[]): string[] {
  if (!agent) return ["When you are done, tell me what you changed."]
  const { mcp, project, resolve } = agent
  const read = `operation "comments.get", and input { threadId } for ${ids.length === 1 ? `thread ${ids[0]}` : `each ID in ${JSON.stringify(ids)}`}`
  return [
    `In the ViteHub MCP (${mcp}), use list_apps to verify team ${project.teamId} and app ${project.url} (id: ${project.id}). If the team is different, ask me to switch to that team in the Console; if the app is missing, ask me to check the link. Only after both match, call read_operation with the app id, ${read}.`,
    resolve
      ? "When the fix is live, use run_operation with the app id, operation \"comments.resolve\", and input { threadId, reply }. In the reply, say what you changed."
      : "Report the fixes to me without resolving the threads.",
  ]
}

type Detail = number | "titles" | "ids"

function title(thread: CommentsAgentPromptThread): string {
  return `${thread.id}: "${cut(thread.messages[0]?.body ?? "", shortest)}"`
}

function render({ agent, threads, url }: CommentsAgentPromptInput, detail: Detail): string {
  const page = new URL(url).href
  const one = threads.length === 1
  const instructions = steps(agent, threads.map(thread => thread.id))
  const heading = one ? `Fix this comment on ${page}` : `Fix these ${threads.length} comments on ${page}`
  if (detail === "ids") return [heading, ...instructions].join("\n\n")
  if (detail === "titles") return [heading, threads.map((thread, index) => one ? title(thread) : `${index + 1}. ${title(thread)}`).join("\n"), ...instructions].join("\n\n")
  if (one) return [heading, ...threadLines(threads[0]!, detail), ...instructions].join("\n")
  return [
    heading,
    ...threads.map((thread, index) => threadLines(thread, detail).map((line, at) => at === 0 ? `${index + 1}. ${line}` : `   ${line}`).join("\n")),
    instructions.join("\n"),
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
 * first its messages and anchors get shorter, then each thread keeps only its ID and a short title. For an MCP prompt,
 * the last option is the thread IDs and instructions. Returns `undefined` if none of these fit.
 */
export function commentsT3CodeLink(input: CommentsAgentPromptInput, repository?: string): string | undefined {
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
  return undefined
}

/**
 * The prompt of **Copy prompt** in the pill, for the open threads of one page. With `agent`, it is three lines: the page,
 * the app in the Console to read the threads from, and what to do with them. Without it, the agent cannot read the
 * threads, so the prompt is `commentsAgentPrompt()` with their text.
 */
export function commentsPagePrompt(input: CommentsAgentPromptInput): string {
  const { agent, threads, url } = input
  if (!agent) return commentsAgentPrompt(input)
  const page = new URL(url)
  const count = threads.length === 1 ? "a comment" : `${threads.length} comments`
  const app = agent.project.name ? `"${agent.project.name}" (${new URL(agent.project.url).host})` : new URL(agent.project.url).host
  return [
    `I left ${count} on ${page.href}`,
    `In the ViteHub Console, open app ${app} through the ViteHub MCP (${agent.mcp}): find it with list_apps (id: ${agent.project.id}, team ${agent.project.teamId}; if it is missing, ask me to switch team), then call read_operation with operation "comments.threads" and input ${JSON.stringify({ page: page.pathname })}.`,
    agent.resolve
      ? "Fix each comment, then resolve it with run_operation, operation \"comments.resolve\", and a reply that says what you changed."
      : "Fix each comment and tell me what you changed.",
  ].join("\n")
}
