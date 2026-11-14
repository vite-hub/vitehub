import type { TraceEventLogEntry } from "@vite-hub/runtime"

/** One change the Agent made on a person's page, as the journal recorded it from `page_act`. */
export interface InvocationPageChange {
  /** The change id: `page.undo(id)` on the page, or `vitehub invocations undo <invocation> --change <id>`. */
  id: string
  /** The page id. */
  page: string
  /** The Auth user id of the person whose page it is, or `anonymous`. */
  user: string
  /** The `page_act` tool call. */
  tool?: string
  /** The index of the step in that call. */
  step: number
  ref: string
  label?: string
  key: string
  /** Absent when the journal content policy omits `page.change.content`. */
  before?: unknown
  after?: unknown
  /** The journal omitted the values. Keep them with `content: "content"` or `metadataContent: ["page.change.content"]`. */
  valuesOmitted?: true
  at: string
  /** An operator's undo put `before` back, with `vitehub invocations undo` or the Console. */
  undone?: { at: string, by?: string }
}

/** One step the page asked the person to approve. */
export interface InvocationPageApproval {
  id: string
  name: string
  reason?: string
  approved?: boolean
  at: string
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}

/** The page changes and approvals of one Invocation, oldest first, from its observations. */
export function invocationPageChanges(observations: readonly TraceEventLogEntry[]): { pageChanges: InvocationPageChange[], approvals: InvocationPageApproval[] } {
  const pageChanges: InvocationPageChange[] = []
  const approvals = new Map<string, InvocationPageApproval>()
  const undone = new Map<string, { at: string, by?: string }>()
  for (const observation of observations) {
    const attributes = observation.attributes ?? {}
    if (observation.name === "agent.page.undo") {
      const id = text(attributes["page.change.id"])
      const by = text(attributes["page.undo.by"])
      if (id && attributes["page.undo.restored"] === true) undone.set(id, { at: observation.timestamp, ...(by ? { by } : {}) })
      continue
    }
    if ((observation.name === "agent.approval.request" || observation.name === "agent.approval.decision") && text(attributes["page.id"])) {
      const id = text(attributes["approval.id"]) ?? `observation:${observation.sequence}`
      const approval = approvals.get(id) ?? { id, name: text(attributes["approval.name"]) ?? "page_act", at: observation.timestamp }
      const reason = text(attributes["approval.reason"])
      if (reason) approval.reason = reason
      if (typeof attributes["approval.approved"] === "boolean") approval.approved = attributes["approval.approved"]
      approvals.set(id, approval)
      continue
    }
    if (observation.name !== "agent.page.change") continue
    const id = text(attributes["page.change.id"])
    const page = text(attributes["page.id"])
    const ref = text(attributes["page.ref"])
    const key = text(attributes["page.key"])
    if (!id || !page || !ref || !key) continue
    const content: unknown = attributes["page.change.content"]
    const label = text(attributes["page.label"])
    const tool = text(attributes["tool.id"])
    const step = attributes["page.step"]
    pageChanges.push({
      id,
      page,
      user: text(attributes["page.user"]) ?? "anonymous",
      ...(tool ? { tool } : {}),
      step: typeof step === "number" ? step : -1,
      ref,
      ...(label ? { label } : {}),
      key,
      ...(content && typeof content === "object" && "before" in content ? { before: content.before, after: "after" in content ? content.after : undefined } : { valuesOmitted: true as const }),
      at: observation.timestamp,
    })
  }
  for (const change of pageChanges) {
    const mark = undone.get(change.id)
    if (mark) change.undone = mark
  }
  return { pageChanges, approvals: [...approvals.values()] }
}

function show(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value) ?? "null"
}

/** The page changes as lines for `vitehub agent invocations show`. */
export function formatInvocationPageChanges(changes: readonly InvocationPageChange[]): string[] {
  if (!changes.length) return []
  return [
    "Page changes:",
    ...changes.map((change) => {
      const values = change.valuesOmitted ? "values omitted by the journal" : `${show(change.before)} -> ${show(change.after)}`
      return `  ${change.at} ${change.id} page ${change.page} user ${change.user} step ${change.step + 1} ${change.label ?? change.ref} ${change.key}: ${values}${change.undone ? " (undone)" : ""}`
    }),
  ]
}
