import type { TraceEventLogEntry } from "@vite-hub/runtime";
import type { AgentInvocationView } from "../types.ts";

export type InvocationActivityKind =
  | "action"
  | "approval"
  | "change"
  | "error"
  | "message"
  | "model"
  | "plan"
  | "reasoning"
  | "run"
  | "tool"
  | "activity";

export interface InvocationCommand {
  command: string;
  cwd?: string;
  exitCode?: number;
  output?: string;
}

export interface InvocationActivity {
  attributes: Record<string, unknown>;
  body?: string;
  command?: InvocationCommand;
  id: string;
  kind: InvocationActivityKind;
  name: string;
  patches: readonly string[];
  reasoningTokens?: number;
  role?: "assistant" | "user";
  status: "running" | "completed" | "failed";
  totalTokens?: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function textFromMessages(value: unknown): string | undefined {
  if (!Array.isArray(value)) return;
  const messages = value.flatMap((message) => {
    const value = record(message);
    if (!Array.isArray(value?.parts)) return [];
    return value.parts.flatMap((part) => {
      const item = record(part);
      return typeof item?.text === "string" ? [item.text] : [];
    });
  });
  return messages.length ? messages.join("\n\n") : undefined;
}

function activityBody(attributes: Record<string, unknown>): string | undefined {
  for (const key of [
    "result.text",
    "input.prompt",
    "input.messages",
    "vitehub.activity.body",
    "message.content",
    "approval.input",
    "content",
    "body",
    "output",
    "input",
  ]) {
    const value = attributes[key];
    if (value === undefined || value === "undefined") continue;
    if (key === "input.messages") {
      const messages = textFromMessages(value);
      if (messages) return messages;
    }
    if (typeof value === "string" && value) return value;
    const json = JSON.stringify(value, null, 2);
    if (json) return json;
  }
}

function fileChangePatches(attributes: Record<string, unknown>): string[] {
  for (const key of ["tool.output", "tool.input"]) {
    const payload = record(attributes[key]);
    const item = record(payload?.item);
    const fileChange = item?.type === "fileChange"
      || attributes["tool.name"] === "File change"
      || attributes["tool.name"] === "Edit";
    if (!item || !fileChange || !Array.isArray(item.changes)) continue;
    const patches = item.changes.flatMap((value) => {
      const change = record(value);
      if (typeof change?.path !== "string" || typeof change.diff !== "string" || !change.diff) {
        return [];
      }
      const path = change.path.split("/workspace/").at(-1) || change.path.replace(/^\/+/, "");
      const diff = change.diff.endsWith("\n") ? change.diff : `${change.diff}\n`;
      return [`diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${diff}`];
    });
    if (patches.length) return patches;
  }
  return [];
}

function commandDetails(attributes: Record<string, unknown>): InvocationCommand | undefined {
  if (attributes["tool.name"] !== "Ran command") return;
  const itemFor = (key: string) => record(record(attributes[key])?.item);
  const item = itemFor("tool.output") ?? itemFor("tool.input");
  const action = Array.isArray(item?.commandActions) ? record(item.commandActions[0]) : undefined;
  const command = typeof action?.command === "string"
    ? action.command
    : typeof item?.command === "string"
      ? item.command
      : undefined;
  if (!command) return;
  return {
    command,
    ...(typeof item?.cwd === "string" ? { cwd: item.cwd } : {}),
    ...(typeof item?.exitCode === "number" ? { exitCode: item.exitCode } : {}),
    ...(typeof item?.aggregatedOutput === "string" ? { output: item.aggregatedOutput } : {}),
  };
}

function activityKey(observation: TraceEventLogEntry): string {
  const attributes = observation.attributes ?? {};
  return String(
    attributes["step.id"]
      ?? attributes["tool.id"]
      ?? attributes["approval.id"]
      ?? attributes["model.call.id"]
      ?? `observation:${observation.sequence}`,
  );
}

function activityKind(
  observation: TraceEventLogEntry,
  attributes: Record<string, unknown>,
  patches: readonly string[],
): InvocationActivityKind {
  if (patches.length) return "change";
  if (observation.name === "agent.usage.recorded") return "model";
  const explicit = attributes["vitehub.activity.kind"];
  if (
    typeof explicit === "string"
    && ["action", "approval", "change", "error", "message", "model", "plan", "reasoning", "run", "tool", "activity"].includes(explicit)
  ) {
    return explicit as InvocationActivityKind;
  }
  if (attributes["channel.effect.kind"] || attributes["channel.effect.intent"] || observation.name.includes(".channel.delivery")) return "action";
  if (attributes["tool.name"] || attributes["tool.id"] || observation.name.includes(".tool.")) return "tool";
  if (attributes["approval.id"] || observation.name.includes(".approval.")) return "approval";
  if (observation.type === "error" || observation.name.endsWith(".error")) return "error";
  if (observation.name.includes(".reasoning.")) return "reasoning";
  if (observation.name.includes(".model.")) return "model";
  if (attributes["message.role"] || attributes["message.content"] || attributes["input.prompt"] || attributes["input.messages"] || attributes["result.text"]) return "message";
  if (observation.name.includes(".invocation.")) return "run";
  return "activity";
}

function numericAttribute(attributes: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = attributes[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
}

export function invocationActivities(invocation: AgentInvocationView): InvocationActivity[] {
  const groups = new Map<string, TraceEventLogEntry[]>();
  for (const observation of invocation.observations ?? []) {
    if (observation.name === "agent.title.recorded" || observation.name === "vitehub.agent.configured") continue;
    const key = activityKey(observation);
    groups.set(key, [...(groups.get(key) ?? []), observation]);
  }

  return [...groups.entries()]
    .map(([id, observations]): InvocationActivity => {
      const sorted = observations.slice().sort((left, right) => left.sequence - right.sequence);
      const first = sorted[0]!;
      const attributes = Object.assign({}, ...sorted.map(item => item.attributes ?? {}));
      const patches = fileChangePatches(attributes);
      const kind = activityKind(first, attributes, patches);
      const failed = sorted.some(item => item.type === "error" || item.name.endsWith(".error"));
      const completed = sorted.some(item => /\.(finish|decision|recorded)$/.test(item.name));
      const role = attributes["message.role"] === "assistant" || attributes["result.text"]
        ? "assistant"
        : kind === "message"
          ? "user"
          : undefined;
      return {
        attributes,
        body: patches.join("") || activityBody(attributes),
        command: commandDetails(attributes),
        id,
        kind,
        name: first.name,
        patches,
        ...(numericAttribute(attributes, "usage.reasoningTokens", "usage.reasoningOutputTokens") !== undefined
          ? { reasoningTokens: numericAttribute(attributes, "usage.reasoningTokens", "usage.reasoningOutputTokens") }
          : {}),
        ...(role ? { role } : {}),
        status: failed ? "failed" : completed || !first.name.endsWith(".start") ? "completed" : "running",
        ...(numericAttribute(attributes, "usage.totalTokens") !== undefined
          ? { totalTokens: numericAttribute(attributes, "usage.totalTokens") }
          : {}),
      };
    })
    .sort((left, right) => {
      const leftSequence = groups.get(left.id)?.[0]?.sequence ?? 0;
      const rightSequence = groups.get(right.id)?.[0]?.sequence ?? 0;
      return leftSequence - rightSequence;
    });
}

export function latestInvocationTokens(activities: readonly InvocationActivity[]): number | undefined {
  const snapshots = activities.flatMap(activity => activity.totalTokens === undefined ? [] : [activity.totalTokens]);
  return snapshots.length ? Math.max(...snapshots) : undefined;
}

export function invocationActivityTitle(activity: InvocationActivity): string {
  if (activity.kind === "action") return String(activity.attributes["channel.effect.kind"] ?? activity.attributes["vitehub.action.name"] ?? "Product action");
  if (activity.kind === "plan") return "Updated plan";
  if (activity.kind === "change") return "Edited files";
  if (activity.kind === "tool") return String(activity.attributes["tool.name"] ?? "Used a tool");
  if (activity.kind === "approval") return String(activity.attributes["approval.name"] ?? "Requested approval");
  if (activity.kind === "reasoning") return "Thinking";
  if (activity.kind === "model") return "Thinking";
  if (activity.kind === "run") return activity.name.endsWith(".finish") ? "Finished session" : "Started session";
  return activity.name.replace(/\.(start|finish|error|decision|recorded)$/, "").replaceAll(".", " ");
}

export function terminalText(value: string | undefined): string {
  if (!value) return "";
  const escape = String.fromCharCode(27);
  return value.replace(new RegExp(`${escape}\\[[0-?]*[ -/]*[@-~]`, "g"), "").replaceAll("\r", "");
}
