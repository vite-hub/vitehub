/** The request header that names the page of an Agent run. `connectPage()` sends it, and `page()` reads it. */
export const pageHeader = "x-vitehub-page"
/** The Realtime Definition of page rooms. ViteHub adds it when an app has Agents and Realtime. */
export const pageRealtimeDefinition = "agent-pages"
/** The Invocation context key that names the page when a run has no request, such as `{ page: { id } }`. */
export const pageContextKey = "page"
/** The page answers `act` with this version, so `page()` knows it applied the rules. */
export const pageRulesVersion = 1

/**
 * A rule of `page({ deny, requireApproval })`, checked on each step after ui-sdk resolves it. Every field the rule sets
 * must match. A rule covers every action on its component, including the ones ui-sdk runs on its own, like opening a
 * closed section.
 */
export interface PageStepRule {
  /** The component's label, compared without case or accents, like "Project name". */
  label?: string
  /** The component kind, like "select", "switch", or "button". */
  component?: string
  /** `true`: the step is on an element inside `data-agent-confirm`. */
  confirm?: boolean
}

export interface PageStepRules {
  deny: PageStepRule[]
  requireApproval: PageStepRule[]
}

/** Why the page refused a step: a `deny` rule, no way to ask the person, or the person said no. */
export type PageRefusalCode = "AGENT_R1047" | "AGENT_R1048" | "AGENT_R1049"
