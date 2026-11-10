import { ownModule } from "@vite-hub/internal/build/paths"
import type { ViteHubConsoleRuntimeRecordTableSection } from "@vite-hub/internal/console"

/**
 * Console section for the Email development outbox. It has no build-time records. The runtime reader lists the
 * messages that `email.send()` captured in `vite dev`, read on each request. `vitehub email outbox list` reads the
 * same outbox.
 */
export const emailConsoleSection: ViteHubConsoleRuntimeRecordTableSection = {
  description: "Inspect messages that the development outbox captured.",
  icon: "i-vitehub-email",
  id: "email",
  label: "Email",
  // Generated Console code imports the reader by path.
  runtime: { export: "readEmailOutboxConsoleRecords", module: ownModule(import.meta.url, "runtime/console") },
  view: {
    columns: [
      { key: "subject", label: "Subject" },
      { key: "to", label: "To" },
      { key: "provider", label: "Provider" },
      { filter: true, key: "delivery", label: "Delivery" },
      { key: "captured", label: "Captured" },
    ],
    kind: "record-table",
    notice: "Messages come from the in-memory development outbox of this server runtime on each request. The outbox exists only in `vite dev`, keeps the newest messages up to its limit, and a restart clears it. HTML is shown as escaped source and is never rendered. Use `vitehub email outbox show <id> --html` for the full source.",
  },
}
