import type { ViteHubCliCommand } from "@vite-hub/internal/cli"

/** `vitehub drain MAINPID [STATUS_URL]`, for a service manager that stops a Node server. It needs no project. */
export const drainCommand: ViteHubCliCommand = {
  description: "Drain a running Node server before it stops, for systemd ExecStop. Needs no project.",
  name: "drain",
  run: async (args, context) => {
    const { runDrain } = await import("@vite-hub/runtime/internal/drain")
    return await runDrain(args, context)
  },
  usage: "vitehub drain MAINPID [STATUS_URL]",
}
