import { useServerEnv } from "vite-hub/env"

export function sessionPassword() {
  return useServerEnv().sessionPassword
}
