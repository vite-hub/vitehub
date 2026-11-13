import { viteHubErrorDiagnostics } from "../error-diagnostics.ts"
export default function disabledRedisDriver(): never {
  throw viteHubErrorDiagnostics.VITE_HUB_R0001({ message: "[vitehub] The Redis KV driver is unavailable because this ViteHub build does not configure a store that can use Redis." })
}
