export interface CommentsAgentPromptInput {
  /** The page with the comments, as a full URL. */
  url: string
  /** The open threads on the page. */
  count: number
  /** The ViteHub MCP that reads the app for the person, such as `https://console.vitehub.dev/mcp/account`. */
  mcp: string
}

/**
 * The prompt of **Copy prompt** in the comment pill: three lines that send the person's agent to the open threads of a
 * page through the ViteHub MCP of the Console, and ask it to resolve each thread with a reply.
 */
export function commentsAgentPrompt({ count, mcp, url }: CommentsAgentPromptInput): string {
  const page = new URL(url)
  const threads = count === 1 ? "the open ViteHub comment" : `the ${count} open ViteHub comments`
  return [
    `Fix ${threads} on ${page.href}`,
    `Read them with the ViteHub MCP (${mcp}): list_apps finds the app ${page.origin}, then read_operation comments.threads with page "${page.pathname}".`,
    "After each fix, resolve the thread with run_operation comments.resolve and a reply that says what changed.",
  ].join("\n")
}
