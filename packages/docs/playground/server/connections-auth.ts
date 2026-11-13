import { useAuth } from "vite-hub/auth/server"
import { cmsCan } from "vite-hub/cms/access"

// Only admins may replace the shared ChatGPT grant used by the docs assistant.
export default async (request: Request) => {
  const session = await useAuth(request).api.getSession({ headers: request.headers })
  if (!session || !cmsCan(session.user, { user: ["list"] })) return undefined
  return `user:${session.user.id}`
}
