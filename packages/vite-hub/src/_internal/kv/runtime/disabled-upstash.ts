import { viteHubErrorDiagnostics } from "../../../error-diagnostics.ts"
export default function disabledUpstashDriver(): never {
  throw viteHubErrorDiagnostics.VITE_HUB_R0001({ message: "[vitehub] The Upstash KV driver is unavailable because this ViteHub build does not configure an Upstash store." })
}
