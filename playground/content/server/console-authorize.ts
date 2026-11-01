import { defineConsoleAuthorize } from "vite-hub/console/auth"
import { cmsConsoleAuthorize } from "vite-hub/cms/access"

// Admins use the whole Console. Other CMS roles reach the Content and Comments sections that their role can read.
export default defineConsoleAuthorize(cmsConsoleAuthorize)
