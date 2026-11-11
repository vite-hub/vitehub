import { parseProjectUrl } from "../../../src/project-url.ts"
import { allowPrivateProjects, canManageProjects, consoleJson, consoleProblem, consoleTeamRoute } from "../../utils/console.ts"

// Link a project to the active team. The answer has the public key of the new key pair: set it in the project's
// `VITEHUB_CONSOLE_KEY_<NAME>`, named by `keyVariable`. The private key stays on the Console server.
export default consoleTeamRoute(async (request, caller) => {
  if (!canManageProjects(caller)) return consoleProblem(403, "CONSOLE_PROJECT_FORBIDDEN", "Only owners and admins of the team link projects.")
  const body: unknown = await request.json().catch(() => undefined)
  const url: unknown = body instanceof Object ? Reflect.get(body, "url") : undefined
  const label: unknown = body instanceof Object ? Reflect.get(body, "label") : undefined
  if (String(url) !== url || (label !== undefined && String(label) !== label)) {
    return consoleProblem(400, "CONSOLE_PROJECT_INVALID", "Send { \"url\": \"https://app.example.com\" }, with an optional \"label\".")
  }
  const parsed = parseProjectUrl(url, { allowPrivate: allowPrivateProjects() })
  if ("error" in parsed) return consoleProblem(400, "CONSOLE_PROJECT_URL", parsed.error)
  const project = await caller.projects.create({ url: parsed.url, label, createdBy: caller.authorization.user.id })
  if (!project) return consoleProblem(409, "CONSOLE_PROJECT_EXISTS", `This team already linked ${parsed.url}.`)
  return consoleJson({ project }, 201)
})
