import type { TraceEventLogEntry } from "@vite-hub/runtime";

/** One change an Agent made on a person's page, from an `agent.page.change` observation. */
export interface InvocationPageChangeView {
  id: string;
  page: string;
  user: string;
  step: number;
  ref: string;
  label?: string;
  key: string;
  before?: unknown;
  after?: unknown;
  valuesOmitted?: boolean;
  at: string;
  undone?: { at: string; by?: string };
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

// The same reading as `invocationPageChanges()` of `@vite-hub/agent`, which the CLI prints. The Console client keeps its
// own copy so it does not load the Agent package.
export function invocationPageChangeViews(observations: readonly TraceEventLogEntry[]): InvocationPageChangeView[] {
  const changes: InvocationPageChangeView[] = [];
  const undone = new Map<string, { at: string; by?: string }>();
  for (const observation of observations) {
    const attributes = observation.attributes ?? {};
    if (observation.name === "agent.page.undo") {
      const id = text(attributes["page.change.id"]);
      const by = text(attributes["page.undo.by"]);
      if (id && attributes["page.undo.restored"] === true) undone.set(id, { at: observation.timestamp, ...(by ? { by } : {}) });
      continue;
    }
    if (observation.name !== "agent.page.change") continue;
    const id = text(attributes["page.change.id"]);
    const page = text(attributes["page.id"]);
    const ref = text(attributes["page.ref"]);
    const key = text(attributes["page.key"]);
    if (!id || !page || !ref || !key) continue;
    const content: unknown = attributes["page.change.content"];
    const label = text(attributes["page.label"]);
    const step = attributes["page.step"];
    changes.push({
      id,
      page,
      user: text(attributes["page.user"]) ?? "anonymous",
      step: typeof step === "number" ? step : -1,
      ref,
      ...(label ? { label } : {}),
      key,
      ...(content && typeof content === "object" && "before" in content
        ? { before: content.before, after: "after" in content ? content.after : undefined }
        : { valuesOmitted: true }),
      at: observation.timestamp,
    });
  }
  for (const change of changes) {
    const mark = undone.get(change.id);
    if (mark) change.undone = mark;
  }
  return changes;
}
