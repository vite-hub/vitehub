import { forwardProjectRequest } from "../../../../../src/forward.ts"
import { consoleCallerOf, consoleDiagnosticProblem, consoleProblem, consoleTeamRoute, projectIdOf, spendForwardBudget } from "../../../../utils/console.ts"

export default consoleTeamRoute(async (request, caller) => {
  const { projects } = caller
  const id = projectIdOf(request, "/p/")
  const target = await projects.target(id)
  if (!target) return consoleProblem(404, "CONSOLE_PROJECT_NOT_FOUND", "There is no such project, or VITEHUB_CONSOLE_SECRET changed since it was linked.")
  const spent = await spendForwardBudget(caller, id)
  if (spent) return consoleDiagnosticProblem(429, spent.diagnostic, { "retry-after": String(spent.retryAfter) })
  const url = new URL(request.url)
  const app = url.pathname.slice(url.pathname.indexOf("/_vitehub/"))
  return forwardProjectRequest(request, { caller: consoleCallerOf(caller), key: target.key, url: target.project.url }, `${app}${url.search}`)
})
