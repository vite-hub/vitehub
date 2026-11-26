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

function steps(agent: CommentsAgentAccess | undefined, threadIds: readonly string[]): string[] {
  if (!agent) return ["When you are done, tell me what you changed."]
  const { mcp, project, resolve } = agent
  const read = threadIds.length === 1 ? `thread ${threadIds[0]}` : `each ID in ${JSON.stringify(threadIds)}`
  return [
    `In the ViteHub MCP (${mcp}), use list_apps to verify team ${project.teamId} and app ${project.url} (id: ${project.id}). If the team is different, ask me to switch to that team in the Console; if the app is missing, ask me to check the link. Only after both match, call read_operation with the app id, operation "comments.get", and input { threadId } for ${read}.`,
    resolve
      ? "When the fix is live, use run_operation with the app id, operation \"comments.resolve\", and input { threadId, reply }. In the reply, say what you changed."
      : "Report the fixes to me without resolving the threads.",
  ]
}

function render({ agent, threads, url }: CommentsAgentPromptInput, length: number): string {
  const page = new URL(url).href
  const ids = threads.map(thread => thread.id)
  if (threads.length === 1) return [`Fix this comment on ${page}`, ...threadLines(threads[0]!, length), ...steps(agent, ids)].join("\n")
  return [
    `Fix these ${threads.length} comments on ${page}`,
    ...threads.map((thread, index) => threadLines(thread, length).map((line, at) => at === 0 ? `${index + 1}. ${line}` : `   ${line}`).join("\n")),
    steps(agent, ids).join("\n"),
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
 * when it is a GitHub repository. The link is at most `t3CodeLinkLimit` characters: a long prompt keeps its steps and
 * gets shorter messages.
 */
export function commentsT3CodeLink(input: CommentsAgentPromptInput, repository?: string): string {
  const link = (prompt: string) => {
    const url = new URL(t3CodeNewThread)
    url.searchParams.set("prompt", prompt)
    const repo = gitHubRepositoryOf(repository)
    if (repo) url.searchParams.set("repo", repo)
    return url.href
  }
  let length = Number.POSITIVE_INFINITY
  let href = link(render(input, length))
  for (length = 2000; href.length > t3CodeLinkLimit && length >= shortest; length = Math.floor(length / 2)) href = link(render(input, length))
  let prompt = render(input, shortest)
  while (href.length > t3CodeLinkLimit) {
    prompt = cut(prompt, Math.floor(prompt.length * 0.9))
    href = link(prompt)
  }
  return href
}
