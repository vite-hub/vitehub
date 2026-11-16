import { cmsConsoleAuthorize } from "vite-hub/cms/access"
import { defineConsoleAuthorize } from "vite-hub/console/auth"

// Admins see every Console section. Publishers, editors, and commenters see Content and Comments.
export default defineConsoleAuthorize(cmsConsoleAuthorize)
