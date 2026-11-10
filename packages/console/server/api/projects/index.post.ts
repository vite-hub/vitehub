import { parseProjectUrl } from "../../../src/project-url.ts"
import { allowPrivateProjects, consoleAdminRoute, consoleJson, consoleProblem, useConsoleProjects } from "../../utils/console.ts"

// Link a project. The answer has the SHA-256 of the new token: set it in the project's `VITEHUB_CONSOLE_TOKEN_SHA256`.
// The token itself stays on the Console server.
export default consoleAdminRoute(async (request, { user }) => {
  const projects = useConsoleProjects()
  if (projects instanceof Response) return projects
  const body: unknown = await request.json().catch(() => undefined)
  const url: unknown = body instanceof Object ? Reflect.get(body, "url") : undefined
  const label: unknown = body instanceof Object ? Reflect.get(body, "label") : undefined
  if (String(url) !== url || (label !== undefined && String(label) !== label)) {
    return consoleProblem(400, "CONSOLE_PROJECT_INVALID", "Send { \"url\": \"https://app.example.com\" }, with an optional \"label\".")
  }
  const parsed = parseProjectUrl(url, { allowPrivate: allowPrivateProjects() })
  if ("error" in parsed) return consoleProblem(400, "CONSOLE_PROJECT_URL", parsed.error)
  const project = await projects.create({ url: parsed.url, label, createdBy: user.id })
  if (!project) return consoleProblem(409, "CONSOLE_PROJECT_EXISTS", `${parsed.url} is already linked.`)
  return consoleJson({ project }, 201)
})
