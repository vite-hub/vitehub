import type { ConsoleNavigation } from "./sections.ts"

export interface ConsoleMcpCommand {
  label: string
  /** Where the text goes: a terminal or the client's configuration file. */
  where: string
  text: string
}

/** The commands and configuration that connect an MCP client to this Console, for the Connect an agent page. */
export function consoleMcpCommands(url: string, auth: ConsoleNavigation["auth"] = true): ConsoleMcpCommand[] {
  const cloudflare = auth === "cloudflare-access"
  const shellUrl = `'${url.replaceAll("'", "'\\''")}'`
  const commands: ConsoleMcpCommand[] = [
    { label: "Claude Code", where: "Terminal", text: `claude mcp add --transport http vitehub ${shellUrl}${cloudflare ? ' --header "CF-Access-Client-Id: ${CF_ACCESS_CLIENT_ID}" --header "CF-Access-Client-Secret: ${CF_ACCESS_CLIENT_SECRET}"' : ""}` },
    { label: "Codex", where: "~/.codex/config.toml", text: `[mcp_servers.vitehub]\nurl = "${url}"${cloudflare ? '\nenv_http_headers = { "CF-Access-Client-Id" = "CF_ACCESS_CLIENT_ID", "CF-Access-Client-Secret" = "CF_ACCESS_CLIENT_SECRET" }' : ""}` },
  ]
  // Cursor and VS Code sign in with OAuth. With Cloudflare Access they would need the service token in the file.
  if (!cloudflare) {
    commands.push(
      { label: "Cursor", where: ".cursor/mcp.json", text: JSON.stringify({ mcpServers: { vitehub: { url } } }, null, 2) },
      { label: "VS Code", where: ".vscode/mcp.json", text: JSON.stringify({ servers: { vitehub: { type: "http", url } } }, null, 2) },
    )
  }
  return commands
}
