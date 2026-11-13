import type { CatalogSpec } from "@vite-hub/kit/catalog";

/** A form for a chat modal and the web: the spec an Agent sends to ask for a release approval. */
export const approvalForm: CatalogSpec = {
  version: 1,
  root: "root",
  elements: {
    root: { type: "Form", props: { submitLabel: "Approve" }, children: ["title", "env", "note", "notify"], on: { submit: { action: "approve", params: { env: { $state: "/env" }, note: { $state: "/note" } } } } },
    title: { type: "Heading", props: { text: "Approve the api-search release?" } },
    env: { type: "Select", props: { label: "Environment", value: { $bindState: "/env" }, options: [{ label: "Production", value: "production" }, { label: "Staging", value: "staging" }] } },
    note: { type: "Textarea", props: { label: "Note for the release log", value: { $bindState: "/note" }, placeholder: "Optional" } },
    notify: { type: "KeyValue", props: { label: "Commits", value: "3 since v2.4.0" } },
  },
  state: { env: "production", note: "" },
};

