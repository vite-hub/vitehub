export const consoleUrl = "https://console.example.com"
export const consoleToken = `vhk_${"S".repeat(43)}`
export const consoleEnv = (home: string): NodeJS.ProcessEnv => ({ VITEHUB_CONSOLE_TOKEN: consoleToken, VITEHUB_CONSOLE_URL: consoleUrl, XDG_CONFIG_HOME: home })

export interface FakeApp { id: string, teamId: string, url: string, label: string | null, createdBy: string, createdAt: number, publicKey: string | null, keyVariable: string | null }

export function fakeConsole(options: { role?: string, appKnowsKey?: boolean } = {}) {
  const apps: FakeApp[] = []
  const requests: { method: string, path: string, search: string, body: unknown }[] = []
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? "GET"
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined
    requests.push({ body, method, path: url.pathname, search: url.search })
    if (new Headers(init?.headers).get("authorization") !== `Bearer ${consoleToken}`) return Response.json({ code: "CONSOLE_API_KEY_INVALID" }, { status: 401 })
    if (url.pathname === "/api/whoami") return Response.json({ key: { expiresAt: 0, id: "key-1" }, projectIds: null, roles: [options.role ?? "owner"], team: { id: "t1", name: "Acme" }, user: { email: "", id: "u1", name: "Ada" } })
    if (url.pathname === "/api/projects" && method === "GET") return Response.json({ projects: apps })
    if (url.pathname === "/api/projects" && method === "POST") {
      if (options.role === "member") return Response.json({ code: "CONSOLE_PROJECT_FORBIDDEN", message: "Only owners and admins of the team link projects.", ok: false, status: 403 }, { status: 403 })
      const input = body as { url: string, label?: string, kind?: "site" }
      const found = apps.find(app => app.url === input.url.replace(/\/$/, ""))
      if (found) return Response.json({ project: found })
      const id = `a1b2c3d4-${apps.length}`
      const app: FakeApp = { createdAt: 1, createdBy: "u1", id, label: input.label ?? null, teamId: "t1", url: input.url.replace(/\/$/, ""), ...(input.kind === "site" ? { keyVariable: null, publicKey: null } : { keyVariable: "VITEHUB_CONSOLE_KEY_CONSOLE_A1B2C3D4", publicKey: "pk" }) }
      apps.push(app)
      return Response.json({ project: app }, { status: 201 })
    }
    const check = /^\/api\/projects\/([^/]+)\/check$/.exec(url.pathname)
    if (check && method === "POST") {
      return options.appKnowsKey
        ? Response.json({ answer: { name: "app" }, linked: true, status: 200 })
        : Response.json({ answer: { code: "CONSOLE_KEY_UNKNOWN", message: "The app has no key for this Console." }, linked: false, status: 401 })
    }
    const project = /^\/api\/projects\/([^/]+)$/.exec(url.pathname)
    if (project && method === "DELETE") {
      const index = apps.findIndex(app => app.id === decodeURIComponent(project[1]!))
      if (index < 0) return Response.json({ code: "CONSOLE_PROJECT_NOT_FOUND", message: "There is no such project." }, { status: 404 })
      apps.splice(index, 1)
      return new Response(null, { status: 204 })
    }
    return Response.json({ code: "NOT_FOUND" }, { status: 404 })
  }) as typeof globalThis.fetch
  return { apps, fetch, requests }
}
