import authHandler from "#vitehub/auth/server"
import scheduleRegistry from "#vitehub/schedule/registry"
import { email } from "vite-hub/email/server"

export { authHandler, email }
export const scheduleNames = Object.keys(scheduleRegistry).sort()
