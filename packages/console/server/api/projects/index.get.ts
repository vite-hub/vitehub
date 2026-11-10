import { consoleAdminRoute, consoleJson, useConsoleProjects } from "../../utils/console.ts"

export default consoleAdminRoute(async () => {
  const projects = useConsoleProjects()
  if (projects instanceof Response) return projects
  return consoleJson({ projects: await projects.list() })
})
