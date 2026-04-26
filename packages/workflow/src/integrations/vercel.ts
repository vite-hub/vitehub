import { encodeNameHex } from "@vitehub/internal/integrations/hex"

export function getVercelWorkflowName(name: string): string {
  return `workflow--${encodeNameHex(name)}`
}
