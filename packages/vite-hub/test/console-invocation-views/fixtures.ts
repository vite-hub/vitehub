import type { TraceEventLogEntry } from "@vite-hub/runtime";
import type { DOMWrapper, VueWrapper } from "@vue/test-utils";
import type { AgentInvocationView } from "../../src/console/runtime/components/invocation/types.ts";

/** The default time of every fixture event and invocation. */
export const timestamp = "2026-08-22T00:00:00.000Z";

/** A trace event. `sequence` defaults to its position in the invocation, `timestamp` to {@link timestamp}. */
export type Event = Omit<TraceEventLogEntry, "sequence" | "timestamp"> & { sequence?: number; timestamp?: string };

/** A completed invocation with the given events. */
export function invocation(events: readonly Event[] = [], fields: Partial<Omit<AgentInvocationView, "observations">> = {}): AgentInvocationView {
  return {
    createdAt: timestamp,
    id: "invocation",
    status: "completed",
    traceId: "trace",
    updatedAt: timestamp,
    ...fields,
    observations: events.map((event, index) => ({ ...event, sequence: event.sequence ?? index + 1, timestamp: event.timestamp ?? timestamp })),
  };
}

export function event(name: string, attributes: Record<string, unknown> = {}, fields: Partial<Event> = {}): Event {
  return { attributes, name, type: name.endsWith(".error") ? "error" : "run", ...fields };
}

/** A recorded chat message. */
export function message(role: string, content: string, attributes: Record<string, unknown> = {}, fields: Partial<Event> = {}): Event {
  return event("agent.message", { "message.content": content, "message.role": role, ...attributes }, fields);
}

/** A streamed chat message part. */
export function delta(role: string, content: string, attributes: Record<string, unknown> = {}, fields: Partial<Event> = {}): Event {
  return event("agent.message.delta", { "message.content": content, "message.role": role, ...attributes }, fields);
}

/** A tool step: `agent.tool.<phase>`. */
export function tool(phase: string, id: string, name: string, attributes: Record<string, unknown> = {}, fields: Partial<Event> = {}): Event {
  return event(`agent.tool.${phase}`, { "tool.id": id, "tool.name": name, ...attributes }, fields);
}

/** A channel delivery. Pass `"error"` as the type for a failed delivery. */
export function delivery(attributes: Record<string, unknown>, fields: Partial<Event> = {}): Event {
  return event("agent.channel.delivery", attributes, fields);
}

/** Input messages that the invocation started with. */
export function input(messages: readonly (readonly [role: string, text: string])[], attributes: Record<string, unknown> = {}, name = "agent.invocation.started"): Event {
  return event(name, {
    "input.messages": messages.map(([role, text], index) => ({ id: `${role}-${index}`, parts: [{ text, type: "text" }], role })),
    ...attributes,
  });
}

/** A mounted component or one of its elements. */
type Wrapper = Pick<DOMWrapper<Element>, "find" | "findAll" | "get">;

/** Opens a `<details>` disclosure, as a person does. */
export async function openDetails(details: Pick<DOMWrapper<Element>, "element" | "trigger">): Promise<void> {
  if (!(details.element instanceof HTMLDetailsElement)) throw new TypeError("Expected a details element");
  details.element.open = true;
  await details.trigger("toggle");
}

/** Opens the collapsed work of a finished run. */
export async function openWork(wrapper: Wrapper): Promise<void> {
  await openDetails(wrapper.get(".vh-invocation-work__details"));
}

/** The kind of each top-level row of the session thread: `history`, `message`, `work` or the activity kind. */
export function threadRows(wrapper: Wrapper): string[] {
  return wrapper.findAll(".vh-invocation-activities > li").map(row => {
    for (const kind of ["history", "message", "work"]) if (row.classes().includes(`vh-invocation-${kind}`)) return kind;
    return row.attributes("data-kind") ?? "unknown";
  });
}

/** The message bodies a person reads. `role` limits them to one role, `scope` to the thread or the work. */
export function messageBodies(wrapper: Wrapper, role?: string, scope: "all" | "thread" | "work" = "all"): string[] {
  const prefix = scope === "thread" ? ".vh-invocation-activities > " : scope === "work" ? ".vh-invocation-work__activities " : "";
  return wrapper.findAll(`${prefix}.vh-invocation-message${role ? `[data-role="${role}"]` : ""}`)
    .map(item => item.get(".vh-invocation-message__body").text());
}

/** The role labels of the messages, for example `You`, `Assistant` or the person who started the run. */
export function messageAuthors(wrapper: Wrapper): string[] {
  return wrapper.findAll(".vh-invocation-message__role").map(role => role.text());
}

/** The visible text of the open work. */
export function workText(wrapper: Wrapper): string {
  return wrapper.get(".vh-invocation-work__activities").text();
}

/** The title of the work summary, for example `Worked for 9s`. */
export function workTitle(wrapper: Wrapper): string {
  return wrapper.get(".vh-invocation-work__title").text();
}

/** The delivery receipts in the open work. */
export function receipts(wrapper: Wrapper): DOMWrapper<Element>[] {
  return wrapper.findAll('.vh-invocation-work__activities [data-kind="delivery"]');
}

/** The titles of the activity rows. */
export function activityTitles(wrapper: Wrapper): string[] {
  return wrapper.findAll(".vh-invocation-event__title").map(title => title.text());
}

/** The truncation notices a person reads. */
export function notices(wrapper: Wrapper): string[] {
  return wrapper.findAll(".vh-invocation-event__notice").map(notice => notice.text());
}

/** The run summary and usage of the inspector, as label and value. */
export function runSummary(inspector: Wrapper): Record<string, string> {
  return Object.fromEntries(inspector.findAll(".vh-invocation-inspector__metrics > div, .vh-invocation-inspector__usage .vh-invocation-inspector__list > div").map(row => [row.get("dt").text(), row.get("dd").text()]));
}

/** The setup group of the inspector with the visible heading, for example `Model`, `Sources` or `Tools`. */
export function setupGroup(inspector: Wrapper, heading: string): DOMWrapper<Element> | undefined {
  return inspector.findAll(".vh-invocation-inspector__group").find(group => {
    const label = group.find(".vh-invocation-inspector__group-heading strong");
    return label.exists() && label.text() === heading;
  });
}

/** Makes the list viewport taller than its content, so the list asks for more pages. */
export function underfilled(wrapper: VueWrapper): void {
  Object.defineProperties(wrapper.get("nav").element, {
    clientHeight: { configurable: true, value: 400 },
    scrollHeight: { configurable: true, value: 200 },
    scrollTop: { configurable: true, value: 0 },
  });
}

/** Replaces the clipboard of the test document. */
export function clipboard(writeText: ((text: string) => Promise<void>) | undefined): void {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: writeText ? { writeText } : undefined });
}
