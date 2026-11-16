import type { ViteHubConsoleOperationSection } from "@vite-hub/internal/console"

/**
 * Console section for the skills of `server/skills.ts`: each skill with a switch. It lists `served-skills.list` and
 * flips a switch with `served-skills.set`, so `console.authorize` decides who may change them.
 */
export const servedSkillsConsoleSection: ViteHubConsoleOperationSection = {
  description: "Turn the Agent Skills that the app serves to coding agents on and off.",
  icon: "i-vitehub-skills",
  id: "served-skills",
  label: "Served skills",
  view: {
    columns: [
      { key: "name", label: "Skill" },
      { format: "excerpt", key: "description", label: "Description" },
      { key: "files", label: "Files" },
      { format: "switch", key: "enabled", label: "On", switch: { input: { name: "name" }, operation: "served-skills.set" } },
    ],
    kind: "operation-view",
    notice: "The skills of server/skills.ts. A skill that is off is missing from Agent Skills Discovery and MCP. Other server instances see a change within `ttlMs`, one minute by default. `vitehub served-skills` lists and sets the same switches.",
    operation: "served-skills.list",
  },
}
