import authHandler from "#vitehub/auth/server"
import scheduleRegistry from "#vitehub/schedule/registry"

export { authHandler }
export const scheduleNames = Object.keys(scheduleRegistry).sort()
