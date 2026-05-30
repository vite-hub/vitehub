import { encodeNameHex } from "@vite-hub/internal/integrations/hex"

export function getVercelWorkflowName(name: string): string {
  return `workflow--${encodeNameHex(name)}`
}
