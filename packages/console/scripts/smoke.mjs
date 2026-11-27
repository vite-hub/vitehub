import { pathToFileURL } from "node:url"

export class SmokeError extends Error {}

export function check(condition, message) {
  if (!condition) throw new SmokeError(message)
}

export async function request(base, path, init = {}) {
  const response = await fetch(new URL(path, base), { redirect: "manual", signal: AbortSignal.timeout(30_000), ...init })
  return { response, text: await response.text() }
}

export function json(text, path) {
  try {
    return JSON.parse(text)
  }
  catch {
    throw new SmokeError(`${path} did not answer JSON: ${text.slice(0, 200)}`)
  }
}

export const post = (base, path, body, headers = {}) => request(base, path, {
  method: "POST",
  headers: { "content-type": "application/json", origin: new URL(base).origin, ...headers },
  body: JSON.stringify(body),
})

const checks = [
  ["serves the Console page, not the placeholder", async (base) => {
    const { response, text } = await request(base, "/", { headers: { accept: "text/html" } })
    check(response.status === 200, `GET / answered ${response.status}`)
    check(response.headers.get("content-type")?.startsWith("text/html"), `GET / answered ${response.headers.get("content-type")}`)
    check(!text.includes("Build the Console page"), "GET / serves the placeholder. Build the page with `vp run --filter vite-hub build:console-account` before the app.")
    check(text.includes("data-vitehub-boot="), "GET / has no data-vitehub-boot attribute, so it is not the Console page")
    const script = /<script[^>]+type="module"[^>]+src="(\/assets\/[^"]+\.js)"/.exec(text)?.[1]
    check(script, "GET / loads no script from /assets/")
    const asset = await request(base, script)
    check(asset.response.status === 200, `GET ${script} answered ${asset.response.status}`)
    check(/javascript/.test(asset.response.headers.get("content-type") ?? ""), `GET ${script} answered ${asset.response.headers.get("content-type")}`)
  }],
  ["answers a client route with the page", async (base) => {
    const { response, text } = await request(base, "/device", { headers: { accept: "text/html" } })
    check(response.status === 200 && text.includes("<html"), `GET /device answered ${response.status}`)
  }],
  ["keeps unknown API paths as JSON 404", async (base) => {
    const { response, text } = await request(base, "/api/no-such-route")
    check(response.status === 404, `GET /api/no-such-route answered ${response.status}`)
    check(json(text, "/api/no-such-route").status === 404, "GET /api/no-such-route answered no Console 404")
  }],
  ["answers the signed-out account read", async (base) => {
    const { response } = await request(base, "/api/account")
    check(response.status === 401, `GET /api/account without a session answered ${response.status}`)
    const methods = await request(base, "/api/sign-in-methods")
    check(methods.response.status === 200, `GET /api/sign-in-methods answered ${methods.response.status}`)
    check(typeof json(methods.text, "/api/sign-in-methods").github === "boolean", "GET /api/sign-in-methods has no github flag")
  }],
  ["writes and reads a CLI sign-in code in the database", async (base) => {
    const started = await post(base, "/api/auth/device/code", { client_id: "vitehub-cli", client_name: "host smoke" })
    check(started.response.status === 200, `POST /api/auth/device/code answered ${started.response.status}: ${started.text.slice(0, 300)}`)
    const code = json(started.text, "/api/auth/device/code")
    check(typeof code.device_code === "string" && typeof code.user_code === "string", "POST /api/auth/device/code answered no device_code and user_code")
    check(new URL(code.verification_uri).pathname === "/device", `verification_uri is ${code.verification_uri}`)
    const poll = await post(base, "/api/auth/cli/token", { client_id: "vitehub-cli", device_code: code.device_code })
    check(json(poll.text, "/api/auth/cli/token").error === "authorization_pending", `POST /api/auth/cli/token for the new code answered ${poll.response.status}: ${poll.text.slice(0, 300)}`)
    const unknown = await post(base, "/api/auth/cli/token", { client_id: "vitehub-cli", device_code: `${code.device_code}-unknown` })
    const unknownError = json(unknown.text, "/api/auth/cli/token").error
    check(unknownError && unknownError !== "authorization_pending", `POST /api/auth/cli/token for an unknown code answered ${unknownError}, so the read did not find the stored code`)
  }],
  ["lists the public MCP tools", async (base) => {
    const { response, text } = await post(base, "/mcp", { id: 1, jsonrpc: "2.0", method: "tools/list" }, { accept: "application/json, text/event-stream" })
    check(response.status === 200, `POST /mcp tools/list answered ${response.status}: ${text.slice(0, 300)}`)
    const names = (json(text, "/mcp").result?.tools ?? []).map(tool => tool.name).sort()
    check(names.includes("get-page") && names.includes("list-pages"), `POST /mcp tools/list listed ${JSON.stringify(names)}`)
  }],
]

export function smoke(base, log = console.log) {
  return runChecks(checks, [base], log)
}

export async function runChecks(list, args, log = console.log) {
  const failures = []
  for (const [name, run] of list) {
    try {
      await run(...args)
      log(`ok    ${name}`)
    }
    catch (error) {
      failures.push(name)
      log(`FAIL  ${name}: ${error instanceof SmokeError ? error.message : error}`)
    }
  }
  return failures
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const base = process.argv[2]
  if (!base) {
    console.error("Usage: node scripts/smoke.mjs <base URL>")
    process.exit(2)
  }
  const failures = await smoke(base)
  if (failures.length) process.exitCode = 1
}
