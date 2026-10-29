interface McpConfiguration {
  url: string
  http_headers: { Authorization: string }
  tools?: Record<string, { approval_mode: "approve" }>
}

/**
 * The provider runtime's thread MCP configuration is its private stdin channel.
 * The launcher consumes this envelope before Codex can treat it as an MCP server.
 * Neither credential enters argv, a file, or a process's initial environment.
 */
export function chatgptSessionConfiguration(key: string, mcp?: McpConfiguration) {
  return {
    endpoint: "http://127.0.0.1/vitehub-chatgpt-configuration",
    authorizationHeader: JSON.stringify({ key, mcp }),
  }
}

/** Source embedded in the runtime-owned provider launcher. No credentials are written to this file. */
export function chatgptProtocolSource(clientInfo: { name: string, title: string, version: string }, stderrMaxBytes: number): string {
  return `
const clientInfo = ${JSON.stringify(clientInfo)}
let initialized = false
function protocolFailure() {
  recordDiagnostic({ spawnError: "Invalid Codex app-server protocol" })
  void terminateProcessGroup().finally(() => process.exit(1))
}
function redactValue(value) {
  if (typeof value === "string") return redactDiagnostic(value)
  if (Array.isArray(value)) return value.map(redactValue)
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item)]))
  return value
}
async function relayInput() {
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    let message
    try { message = JSON.parse(line) } catch { return protocolFailure() }
    if (!initialized) {
      if (message?.method !== "initialize" || !message.params || typeof message.params !== "object") return protocolFailure()
      message.params.clientInfo = clientInfo
      initialized = true
    }
    if (["thread/start", "thread/resume", "thread/fork"].includes(message?.method)) {
      const config = message.params?.config
      const envelope = config?.mcp_servers?.["t3-code"]
      if (envelope?.url !== "http://127.0.0.1/vitehub-chatgpt-configuration") return protocolFailure()
      let credentials
      try { credentials = JSON.parse(envelope.http_headers.Authorization) } catch { return protocolFailure() }
      if (typeof credentials?.key !== "string" || !/^[a-f0-9]{64}$/.test(credentials.key)) return protocolFailure()
      const secrets = [credentials.key, credentials.mcp?.http_headers?.Authorization].filter(value => typeof value === "string" && value.length > 0)
      for (const secret of secrets) {
        diagnosticSecrets.push(secret)
        diagnosticSecretBuffers.push(Buffer.from(secret))
        // Also redact an unlabelled bearer value echoed by Codex or an MCP error.
        if (secret.startsWith("Bearer ")) {
          diagnosticSecrets.push(secret.slice(7))
          diagnosticSecretBuffers.push(Buffer.from(secret.slice(7)))
        }
        stderrRetentionBytes = Math.max(stderrRetentionBytes, ${stderrMaxBytes} + Buffer.byteLength(secret))
      }
      config.mcp_servers = credentials.mcp ? { "t3-code": credentials.mcp } : {}
      config["model_providers.openai_chatgpt_plan.http_headers"] = { Authorization: "Bearer " + credentials.key }
    }
    if (!child.stdin.write(JSON.stringify(message) + "\\n")) await once(child.stdin, "drain")
  }
  child.stdin.end()
}
async function relayOutput() {
  for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
    let message
    try { message = JSON.parse(line) } catch { return protocolFailure() }
    if (!process.stdout.write(JSON.stringify(redactValue(message)) + "\\n")) await once(process.stdout, "drain")
  }
}
async function relayStderr() {
  for await (const line of createInterface({ input: child.stderr, crlfDelay: Infinity })) forwardStderr(Buffer.from(redactDiagnostic(line) + "\\n"))
}
void relayInput().catch(protocolFailure)
void relayOutput().catch(protocolFailure)
void relayStderr().catch(protocolFailure)
`
}
