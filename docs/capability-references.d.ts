declare module "#vitehub-capability-references" {
  import type { AgentToolInspection } from "@vite-hub/ui";

  export const capabilityReferences: Record<string, { tools: AgentToolInspection[] }>;
  export default capabilityReferences;
}
