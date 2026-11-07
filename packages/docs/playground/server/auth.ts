import { admin } from "better-auth/plugins"
import { defineAuth } from "vite-hub/auth"
import { authDatabase } from "vite-hub/auth/database"
import { cmsAccess } from "vite-hub/cms/access"
import { consoleMcpOAuth } from "vite-hub/console/auth"

import { publicUrl } from "../site"

// Users, sessions, and the Console MCP OAuth tables live in the `users` Database. `VITEHUB_ADMIN_EMAILS` (a Worker secret)
// gives the admin role to a listed email on its first sign-up or GitHub sign-in. Everyone else gets `user`, which has no
// CMS role, until an admin gives them one in the Console Auth section.
export default defineAuth(() => {
  const github = process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET
    ? { clientId: process.env.GITHUB_CLIENT_ID, clientSecret: process.env.GITHUB_CLIENT_SECRET }
    : undefined
  return {
    appName: "Lumen docs",
    database: authDatabase("users"),
    emailAndPassword: { enabled: true },
    socialProviders: github ? { github } : {},
    // A GitHub sign-in with the email of an existing user signs in to that user.
    account: { accountLinking: { trustedProviders: ["github"] } },
    plugins: [
      admin(cmsAccess),
      // The OAuth server that MCP clients sign in with, for the Console MCP at /_vitehub/mcp.
      ...consoleMcpOAuth({ resource: `${publicUrl}/_vitehub/mcp` }),
    ],
  }
})
