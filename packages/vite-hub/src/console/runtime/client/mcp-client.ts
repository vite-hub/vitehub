import { requestConsoleOperation } from "./request"

import type { ConsoleMcpAuth, ConsoleMcpCandidate, ConsoleMcpConnection, ConsoleMcpConnectResult, ConsoleMcpOutcome, ConsoleMcpOverview, ConsoleMcpPage, ConsoleMcpStatus } from "../mcp-client"

type ConsoleMcpAnswer = ConsoleMcpOutcome & { connection: ConsoleMcpConnection }

/** What each operation of the MCP section returns (`runtime/server/mcp-client.ts`). */
export interface ConsoleMcpResults {
  "mcp-client.call": ConsoleMcpAnswer
  "mcp-client.complete": ConsoleMcpConnection
  "mcp-client.connect": ConsoleMcpConnectResult
  "mcp-client.disconnect": { revoked: boolean, sessionEnded: boolean }
  "mcp-client.items": ConsoleMcpPage & { connection: ConsoleMcpConnection }
  "mcp-client.list": ConsoleMcpOverview
  "mcp-client.prompt": ConsoleMcpAnswer
  "mcp-client.read": ConsoleMcpAnswer
  "mcp-client.reconnect": ConsoleMcpConnectResult
}

/**
 * Call one operation of the MCP client section. `base` is any Console API path of the app and only locates the application
 * mount, as in `requestConsoleOperation()`.
 */
export async function requestConsoleMcp<Operation extends keyof ConsoleMcpResults>(base: string, operation: Operation, input: Record<string, unknown> = {}, signal?: AbortSignal): Promise<ConsoleMcpResults[Operation]> {
  // SAFETY: The server operation of this name returns this shape. Console and server ship in one build.
  return await requestConsoleOperation(base, operation, input, signal ? { signal } : {}) as ConsoleMcpResults[Operation]
}

/** Status words and colors. The word always comes with the color, so the status never depends on color alone. */
export const consoleMcpStatus: Readonly<Record<ConsoleMcpStatus, { color: "error" | "info" | "success" | "warning", label: string }>> = {
  "authorizing": { color: "info", label: "Signing in" },
  "connected": { color: "success", label: "Connected" },
  "failed": { color: "error", label: "Failed" },
  "signed-out": { color: "warning", label: "Signed out" },
}

export const consoleMcpAuthLabels: Readonly<Record<ConsoleMcpAuth, string>> = {
  bearer: "Token",
  console: "Console session",
  none: "No sign-in",
  oauth: "OAuth",
}

/** The account to show for a connection: who the server knows it as, then how it signs in. */
export function consoleMcpAccount(connection: ConsoleMcpConnection): { primary: string, secondary?: string } {
  const identity = connection.identity
  if (identity?.name || identity?.email) {
    return { primary: identity.name ?? identity.email!, ...(identity.name && identity.email ? { secondary: identity.email } : {}) }
  }
  if (connection.auth === "bearer") return { primary: connection.label, secondary: `Token ••••${connection.grant?.hint ?? ""}` }
  if (identity?.subject) return { primary: connection.label, secondary: `Subject ${identity.subject}` }
  return { primary: connection.label, ...(connection.auth === "none" || connection.auth === "console" ? { secondary: consoleMcpAuthLabels[connection.auth] } : {}) }
}

/** Up to two initials of a name or an email, for an avatar. */
export function consoleMcpInitials(value: string): string {
  const words = value.replace(/@.*$/, "").split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  return (words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : (words[0] ?? "?").slice(0, 2)).toUpperCase()
}

/** A host and path without the scheme, such as `example.com/mcp`. */
export function consoleMcpEndpoint(url: string): string {
  const parsed = new URL(url)
  return `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`
}

export interface ConsoleMcpServerGroup {
  /** The server that the app announces, when it has one at this URL. */
  candidate?: ConsoleMcpCandidate
  connections: ConsoleMcpConnection[]
  sameOrigin: boolean
  title: string
  url: string
}

/**
 * Connections grouped by their MCP endpoint, in the order they were made. A server that the app announces comes first,
 * also when no one has connected to it yet.
 */
export function groupConsoleMcpConnections(overview: ConsoleMcpOverview, origin: string): ConsoleMcpServerGroup[] {
  const groups = new Map<string, ConsoleMcpServerGroup>()
  for (const candidate of overview.servers) {
    groups.set(candidate.url, { candidate, connections: [], sameOrigin: new URL(candidate.url).origin === origin, title: candidate.label, url: candidate.url })
  }
  for (const connection of overview.connections) {
    const group = groups.get(connection.url)
    if (group) {
      group.connections.push(connection)
      if (!group.candidate && connection.server) group.title = connection.server.title ?? connection.server.name
      continue
    }
    groups.set(connection.url, {
      connections: [connection],
      sameOrigin: connection.sameOrigin,
      title: connection.server?.title ?? connection.server?.name ?? consoleMcpEndpoint(connection.url),
      url: connection.url,
    })
  }
  return [...groups.values()]
}

/** Behavior hints of a tool, as short labels. A server can set them wrongly, so the Console treats them as hints. */
export function consoleMcpToolHints(tool: Record<string, unknown>): { label: string, tone: "error" | "neutral" }[] {
  const annotations = tool.annotations instanceof Object ? tool.annotations as Record<string, unknown> : {}
  const hints: { label: string, tone: "error" | "neutral" }[] = []
  if (annotations.readOnlyHint === true) hints.push({ label: "Read-only", tone: "neutral" })
  else if (annotations.destructiveHint === true) hints.push({ label: "Destructive", tone: "error" })
  if (annotations.openWorldHint === true) hints.push({ label: "Open world", tone: "neutral" })
  return hints
}

/** The JSON Schema of the arguments of a prompt, so the schema form can render them. */
export function consoleMcpPromptSchema(prompt: Record<string, unknown>): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const argument of Array.isArray(prompt.arguments) ? prompt.arguments : []) {
    if (!(argument instanceof Object)) continue
    const { description, name, required: isRequired } = argument as Record<string, unknown>
    if (typeof name !== "string" || !name) continue
    properties[name] = { type: "string", ...(typeof description === "string" ? { description } : {}) }
    if (isRequired === true) required.push(name)
  }
  return { properties, required, type: "object" }
}
