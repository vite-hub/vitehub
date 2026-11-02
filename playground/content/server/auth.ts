import { admin } from "better-auth/plugins"
import { defineAuth } from "vite-hub/auth"
import { authDatabase } from "vite-hub/auth/database"
import { cmsAccess } from "vite-hub/cms/access"

import { playgroundRoleOf } from "./roles"

// Users and sessions live in the `content` Database. `authDatabase()` adds the Better Auth tables to it, and
// `server/databases/content/migrations/0006_auth.sql` creates them. Sign in at /login or /_vitehub/sign-in.
// `admin(cmsAccess)` keeps each user's CMS role in `user.role`. A playground user gets its role at sign-up; anyone else
// gets `user`, which has no CMS permission. Admins change roles in the Console Auth section.
export default defineAuth({
  appName: "Content playground",
  database: authDatabase("content"),
  emailAndPassword: { enabled: true },
  plugins: [admin(cmsAccess)],
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          const role = playgroundRoleOf(user.email)
          return { data: role ? { ...user, role } : user }
        },
      },
    },
  },
})
