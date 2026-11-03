import type { ConsoleNavigation } from "./sections.ts"

export interface ConsoleMcpCommand {
  label: string
  text: string
}

/** The commands that connect an MCP client to this Console, for the "Connect an agent" panel. */
export function consoleMcpCommands(url: string, auth: ConsoleNavigation["auth"] = true): ConsoleMcpCommand[] {
  const cloudflare = auth === "cloudflare-access"
  const shellUrl = `'${url.replaceAll("'", "'\\''")}'`
  return [
    { label: "Claude Code", text: `claude mcp add --transport http vitehub ${shellUrl}${cloudflare ? ' --header "CF-Access-Client-Id: ${CF_ACCESS_CLIENT_ID}" --header "CF-Access-Client-Secret: ${CF_ACCESS_CLIENT_SECRET}"' : ""}` },
    { label: "Codex", text: `[mcp_servers.vitehub]\nurl = "${url}"${cloudflare ? '\nenv_http_headers = { "CF-Access-Client-Id" = "CF_ACCESS_CLIENT_ID", "CF-Access-Client-Secret" = "CF_ACCESS_CLIENT_SECRET" }' : ""}` },
  ]
}
