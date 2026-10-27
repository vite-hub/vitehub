/** Source embedded in the runtime-owned provider launcher. No credentials are written to this file. */
export function chatgptProtocolSource(clientInfo: { name: string, title: string, version: string }): string {
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
