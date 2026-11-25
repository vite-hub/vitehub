export interface CommentsAgentPromptInput {
  url: string
  threadIds: readonly string[]
  mcp: string
  project: { id: string, teamId: string, url: string }
  resolve: boolean
}

export function commentsAgentPrompt({ mcp, project, resolve, threadIds, url }: CommentsAgentPromptInput): string {
  const threads = threadIds.length === 1 ? "the open ViteHub comment" : `the ${threadIds.length} open ViteHub comments`
  return [
    `Fix ${threads} on ${new URL(url).href}`,
    `In the ViteHub MCP (${mcp}), use list_apps to verify team ${project.teamId} and app ${project.url} (id: ${project.id}). If the team is different, ask me to switch to that team in the Console; if the app is missing, ask me to check the link. Only after both match, call read_operation with the app id, operation "comments.get", and input { threadId } for each ID in ${JSON.stringify(threadIds)}.`,
    resolve
      ? 'After each fix, use run_operation with the app id, operation "comments.resolve", and input { threadId, reply }. In the reply, say what changed.'
      : "Report the fixes to me without resolving the threads.",
  ].join("\n")
}
