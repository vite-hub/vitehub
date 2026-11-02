/** A failed answer, described for the reader, with the command that fixes it when there is one. */
export interface DocsAssistantProblem {
  /** Stable code from the server, such as `AGENT_R1016`, or `unknown`. */
  code: string
  title: string
  detail: string
  /** A shell command for the site owner, run from the app folder. */
  command?: string
}

const codePattern = /\b(AGENT_R\d{4}|AGENT_BUDGET_EXCEEDED|RATE_LIMIT_(?:REJECTED|UNAVAILABLE))\b/

/**
 * Maps a chat error to what the panel shows. The ChatGPT plan errors name their fix, so the panel shows the exact
 * command instead of a generic failure. `origin` is the site origin that the CLI connects to.
 */
export function docsAssistantProblem(error: Error | string, origin: string): DocsAssistantProblem {
  const message = typeof error === "string" ? error : error.message
  const code = codePattern.exec(message)?.[1] ?? "unknown"
  switch (code) {
    case "AGENT_R1016": {
      const connection = /vitehub connections connect ([\w-]+)/.exec(message)?.[1] ?? "chatgpt"
      return {
        code,
        title: "Connect ChatGPT",
        detail: "The assistant runs on the site owner's ChatGPT plan, and no plan is connected. Sign in once from the app folder, then ask again.",
        command: `pnpm vitehub connections connect ${connection} --url ${origin}`,
      }
    }
    case "AGENT_R1017":
      return { code, title: "ChatGPT plan limit reached", detail: "The site owner's ChatGPT plan reached its usage limit. Try again after it resets." }
    case "AGENT_R1018":
      return { code, title: "ChatGPT plan not eligible", detail: "The connected ChatGPT account cannot use its plan in apps. The site owner can check the plan at chatgpt.com." }
    case "RATE_LIMIT_REJECTED":
      return { code, title: "Too many questions", detail: "The assistant reached its limit of questions for now. Try again later." }
    default:
      return { code, title: "The assistant could not answer", detail: message || "Try again." }
  }
}
