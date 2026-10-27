import type { ViteHubConsoleAuthSection } from "@vite-hub/internal/console";

export type * from "./console-types.ts";
export { authConsoleEventGroups } from "./console-types.ts";

/** The owner descriptor. The host supplies the navigation and renders the Auth views. */
export const authConsoleSection: ViteHubConsoleAuthSection = {
  id: "auth",
  label: "Auth",
  icon: "i-lucide-users-round",
  description: "Manage users, sessions, organizations, and approved OAuth clients.",
  view: {
    kind: "auth-management",
    notice: "Better Auth owns user data and runs each change through its APIs.",
  },
};
