import type { ViteHubConsoleOperationSection } from "@vite-hub/internal/console"

/** Console section for the inbox of every form. It lists the result of `forms.list`. */
export const formsConsoleSection: ViteHubConsoleOperationSection = {
  description: "Read what visitors sent through the forms of the site.",
  icon: "i-vitehub-email",
  id: "forms",
  label: "Forms",
  view: {
    columns: [
      { key: "form", label: "Form" },
      { key: "status", label: "Status", format: "status", tones: { done: "success", open: "info", spam: "error" } },
      // The long text keys that AutoForm draws as a textarea.
      { key: "data.message|data.feedback|data.details|data.description|data.comment|data.body|data.text|data.notes|data.note|data.workflow", label: "Message", format: "excerpt" },
      { key: "data.email|user.email|user.id", label: "From" },
      { key: "page", label: "Page" },
      { key: "createdAt", label: "Sent", format: "datetime" },
    ],
    filters: [
      { id: "open", input: { status: "open" }, label: "Open" },
      { id: "done", input: { status: "done" }, label: "Done" },
      { id: "spam", input: { status: "spam" }, label: "Spam" },
      { id: "all", input: {}, label: "All" },
    ],
    kind: "operation-view",
    link: { label: "Open page", template: "{page:href}" },
    notice: "Each `server/forms/<name>.ts` stores what visitors send here. Mark a submission with `vitehub forms mark <id> done` or `spam`, or with the forms.mark MCP tool.",
    operation: "forms.list",
    pagination: { limit: 100, cursor: { createdAt: "createdAt", id: "id" } },
  },
}
