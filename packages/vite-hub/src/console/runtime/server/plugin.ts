import { getConsoleInvocations } from "./invocations.ts"

export default function viteHubConsolePlugin(): void {
  getConsoleInvocations()
}
