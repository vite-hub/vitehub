import { defineConsoleAuthorize } from "vite-hub/console/auth"

import { roleOf } from "./roles"

// Admins use the whole Console. Editors and writers only reach the Content section.
export default defineConsoleAuthorize(({ user }) => {
  const role = roleOf(user)
  if (role === "admin") return true
  if (role === "editor" || role === "writer") return { sections: ["content"] }
  return false
})
