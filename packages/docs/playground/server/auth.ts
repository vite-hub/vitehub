import { admin } from "better-auth/plugins"
import { defineAuth } from "vite-hub/auth"
import { authDatabase } from "vite-hub/auth/database"
import { cmsAccess } from "vite-hub/cms/access"

// The GitHub account id of onmax. It is the only account that gets the admin role here, so the demo does not set
// `VITEHUB_ADMIN_EMAILS`: an email and password sign-up does not prove that the person owns the email.
const adminGitHubId = "22072217"

// Users, sessions, and the Console MCP OAuth tables live in the `users` Database. Everyone except onmax gets `user`,
// which has no CMS role, until an admin gives them one in the Console Auth section.
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
    databaseHooks: {
      account: {
        create: {
          // Runs when onmax signs in with GitHub for the first time, or links GitHub to an account.
          after: async (account, context) => {
            if (account.providerId !== "github" || account.accountId !== adminGitHubId) return
            await context?.context.internalAdapter.updateUser(account.userId, { role: "admin" })
          },
        },
      },
    },
    plugins: [admin(cmsAccess)],
  }
})
