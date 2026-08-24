import type { TraceEventLogEntry } from "@vite-hub/runtime";
import type { AgentInvocationView } from "../types.ts";

type InvocationActivityKind =
  | "action"
  | "approval"
  | "change"
  | "delivery"
  | "error"
  | "message"
  | "model"
  | "plan"
  | "preparation"
  | "reasoning"
  | "run"
  | "system"
  | "tool"
  | "activity";

interface InvocationCommand {
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
  paths: readonly string[];
  preview?: string;
  reasoningTokens?: number;
  role?: "assistant" | "system" | "tool" | "user";
  sequence: number;
  status: "running" | "completed" | "failed";
  totalTokens?: number;
  truncated?: boolean;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function messageText(value: unknown): string | undefined {
  const message = record(value);
  if (!Array.isArray(message?.parts)) return;
  const parts = message.parts.flatMap((part) => {
    const item = record(part);
    return typeof item?.text === "string" ? [item.text] : [];
  });
  return parts.length ? parts.join("") : undefined;
}

function messageRole(value: unknown): InvocationActivity["role"] {
  return value === "assistant" || value === "system" || value === "tool" || value === "user"
    ? value
    : undefined;
}

function activityBody(attributes: Record<string, unknown>): string | undefined {
  for (const key of [
    "result.text",
    "input.prompt",
    "input.messages",
    "vitehub.activity.body",
    "message.content",
    "approval.input",
    "approval.reason",
    "tool.error",
    "error.message",
    "tool.output",
    "tool.input",
    "content",
    "body",
    "output",
    "input",
  ]) {
    const value = attributes[key];
    if (value === undefined || value === "undefined") continue;
    if (typeof value === "string" && value) return value;
    const json = JSON.stringify(value, null, 2);
    if (json) return json;
  }
}

function fileChanges(attributes: Record<string, unknown>): { patches: string[]; paths: string[] } {
  for (const key of ["tool.output", "tool.input"]) {
    const payload = record(attributes[key]);
    const item = record(payload?.item);
    const fileChange = item?.type === "fileChange"
      || attributes["tool.name"] === "File change"
      || attributes["tool.name"] === "Edit";
    if (!item || !fileChange || !Array.isArray(item.changes)) continue;
    const paths: string[] = [];
    const patches = item.changes.flatMap((value) => {
      const change = record(value);
      if (typeof change?.path !== "string") {
        return [];
      }
      const path = change.path.split("/workspace/").at(-1) || change.path.replace(/^\/+/, "");
      paths.push(path);
      if (typeof change.diff !== "string" || !change.diff) return [];
      const diff = change.diff.endsWith("\n") ? change.diff : `${change.diff}\n`;
      return [`diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${diff}`];
    });
    if (patches.length || paths.length) return { patches, paths };
  }
  const body = attributes["vitehub.activity.body"];
  if (attributes["vitehub.activity.kind"] === "change" && typeof body === "string" && /^diff --git /m.test(body)) {
    const paths = [...body.matchAll(/^diff --git a\/(.+?) b\/.+$/gm)].map(match => match[1]!);
    return {
      patches: [body.endsWith("\n") ? body : `${body}\n`],
      paths: [...new Set(paths)],
    };
  }
  return { patches: [], paths: [] };
}

function commandDetails(
  attributes: Record<string, unknown>,
  observations: readonly TraceEventLogEntry[],
): InvocationCommand | undefined {
  const payloadFor = (key: string) => {
    const payload = record(attributes[key]);
    return record(payload?.item) ?? payload;
  };
  const output = payloadFor("tool.output");
  const input = payloadFor("tool.input");
  const action = [output, input]
    .map(item => Array.isArray(item?.commandActions) ? record(item.commandActions[0]) : undefined)
    .find(candidate => stringAttribute(candidate ?? {}, "command") !== undefined);
  const command = stringAttribute(action ?? {}, "command")
    ?? stringAttribute(input ?? {}, "command")
    ?? stringAttribute(output ?? {}, "command");
  if (!command) return;
  const streamedOutput = observations
    .filter(observation => observation.name === "agent.tool.output")
    .map(observation => observation.attributes?.["tool.output"])
    .filter((value): value is string => typeof value === "string")
    .join("");
  const directOutput = observations
    .filter(observation => /\.(finish|error)$/.test(observation.name))
    .map(observation => observation.attributes?.["tool.output"])
    .findLast(value => typeof value === "string");
  const outputText = typeof output?.aggregatedOutput === "string"
      ? output.aggregatedOutput
      : streamedOutput
        ? streamedOutput
        : typeof directOutput === "string"
          ? directOutput
          : typeof output?.output === "string"
            ? output.output
            : typeof input?.aggregatedOutput === "string"
          ? input.aggregatedOutput
          : typeof input?.output === "string"
            ? input.output
            : undefined;
  return {
    command,
    ...(typeof input?.cwd === "string" ? { cwd: input.cwd } : typeof output?.cwd === "string" ? { cwd: output.cwd } : {}),
    ...(typeof output?.exitCode === "number" ? { exitCode: output.exitCode } : typeof input?.exitCode === "number" ? { exitCode: input.exitCode } : {}),
    ...(outputText !== undefined ? { output: outputText } : {}),
  };
}

export function stringAttribute(attributes: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = attributes[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
}

function payloadDetail(attributes: Record<string, unknown>): string | undefined {
  for (const key of ["tool.output", "tool.input"]) {
    const payload = record(attributes[key]);
    const item = record(payload?.item) ?? payload;
    const detail = item && stringAttribute(item, "detail", "output", "query", "path");
    if (detail) return detail.split(/\r?\n/).find(Boolean)?.trim();
  }
  return stringAttribute(attributes, "tool.detail", "tool.output.summary", "vitehub.activity.detail");
}

function normalizedTitle(value: string): string {
  const title = value.replace(/\s+(?:complete|completed)$/i, "").trim();
  return title ? title[0]!.toUpperCase() + title.slice(1) : "Activity";
}

function activityPreview(
  attributes: Record<string, unknown>,
  command: InvocationCommand | undefined,
  paths: readonly string[],
  title: string,
): string | undefined {
  const detail = command?.command ?? payloadDetail(attributes) ?? (paths.length
    ? `${paths[0]}${paths.length > 1 ? ` +${paths.length - 1} more` : ""}`
    : undefined);
  if (!detail || normalizedTitle(detail).toLocaleLowerCase() === title.toLocaleLowerCase()) return;
  return detail;
}

function activityKey(observation: TraceEventLogEntry, anonymousMessageKey?: string): string {
  const attributes = observation.attributes ?? {};
  return String(
    attributes["step.id"]
      ?? attributes["tool.id"]
      ?? attributes["approval.id"]
      ?? attributes["model.call.id"]
      ?? (attributes["message.id"]
        ? `${String(attributes["message.id"])}:${String(attributes["message.phase"] ?? "message")}`
        : undefined)
      ?? (typeof attributes["message.content"] === "string" ? anonymousMessageKey : undefined)
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
    && ["action", "approval", "change", "delivery", "error", "message", "model", "plan", "preparation", "reasoning", "run", "system", "tool", "activity"].includes(explicit)
  ) {
    return explicit as InvocationActivityKind;
  }
  if (attributes["channel.effect.kind"] || attributes["channel.effect.intent"] || observation.name.includes(".channel.delivery")) return "delivery";
  if (observation.name === "vitehub.agent.configured") return "system";
  if (attributes["tool.name"] || attributes["tool.id"] || observation.name.includes(".tool.")) return "tool";
  if (attributes["approval.id"] || observation.name.includes(".approval.")) return "approval";
  if (observation.type === "error" || observation.name.endsWith(".error")) return "error";
  if (attributes["message.phase"] === "commentary" || attributes["message.phase"] === "reasoning") return "reasoning";
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
  const traceTruncated = invocation.observationsTruncated === true
    || (invocation.observations?.some(observation => observation.attributes?.["vitehub.trace.truncated"] === true) ?? false);
  const hasAgentMessages = (invocation.observations ?? []).some(observation =>
    observation.name === "agent.message" || observation.name.startsWith("agent.message."),
  );
  let anonymousMessage = 0;
  let anonymousMessageKey: string | undefined;
  let anonymousMessagePhase: string | undefined;
  let assistantDeltaText = "";
  for (const observation of invocation.observations ?? []) {
    if (observation.name === "agent.title.recorded") continue;
    const originalAttributes = observation.attributes ?? {};
    const delta = messageText({ parts: [{ text: originalAttributes["message.content"] }] });
    const role = messageRole(originalAttributes["message.role"]);
    const resultText = messageText({ parts: [{ text: originalAttributes["result.text"] }] });
    if (resultText && assistantDeltaText.endsWith(resultText)) continue;
    if (hasAgentMessages && !resultText && (observation.name === "agent.stream.finish" || observation.name === "agent.invocation.finish")) continue;
    if (delta && (role === undefined || role === "assistant")) assistantDeltaText += delta;
    const inputMessages = Array.isArray(originalAttributes["input.messages"])
      ? originalAttributes["input.messages"]
      : Array.isArray(originalAttributes["input.prompt"])
        ? originalAttributes["input.prompt"]
        : undefined;
    if (Array.isArray(inputMessages)) {
      inputMessages.forEach((message, index) => {
        const value = record(message);
        const body = messageText(value) ?? (Array.isArray(value?.parts) ? JSON.stringify(value.parts, null, 2) : undefined);
        const role = messageRole(value?.role);
        if (!body || !role) return;
        const key = `input-message:${observation.sequence}:${index}`;
        groups.set(key, [{
          ...observation,
          attributes: {
            "message.content": body,
            "message.id": value ? stringAttribute(value, "id") ?? key : key,
            "message.role": role,
            ...(originalAttributes["vitehub.observation.truncated"] === true
              ? { "vitehub.observation.truncated": true }
              : {}),
          },
          name: "agent.input.message",
          sequence: observation.sequence - (inputMessages.length - index) / (inputMessages.length + 1),
        }]);
      });
    }
    const attributes = inputMessages === undefined
      ? originalAttributes
      : Object.fromEntries(Object.entries(originalAttributes).filter(([key]) => key !== "input.messages" && key !== "input.prompt"));
    if (inputMessages !== undefined && Object.keys(attributes).length === 0) continue;
    const isAnonymousMessage = stringAttribute(attributes, "message.content") !== undefined
      && !attributes["message.id"];
    const messagePhase = stringAttribute(attributes, "message.phase") ?? "message";
    if (isAnonymousMessage && (!anonymousMessageKey || anonymousMessagePhase !== messagePhase)) {
      anonymousMessageKey = `message:assistant:${anonymousMessage++}`;
      anonymousMessagePhase = messagePhase;
    } else if (!isAnonymousMessage) {
      anonymousMessageKey = undefined;
      anonymousMessagePhase = undefined;
    }
    const key = activityKey(observation, anonymousMessageKey);
    groups.set(key, [...(groups.get(key) ?? []), { ...observation, attributes }]);
  }

  const activities = [...groups.entries()]
    .map(([id, observations]): InvocationActivity => {
      const sorted = observations.slice().sort((left, right) => left.sequence - right.sequence);
      const first = sorted[0]!;
      const attributes = Object.assign({}, ...sorted.map(item => item.attributes ?? {}));
      const messageBody = sorted
        .map(item => item.attributes?.["message.content"])
        .filter((value): value is string => typeof value === "string")
        .join("");
      const { patches, paths } = fileChanges(attributes);
      const kind = activityKind(first, attributes, paths.length ? paths : patches);
      const failed = sorted.some(item => item.type === "error" || item.name.endsWith(".error"));
      const approvalDenied = attributes["approval.approved"] === false;
      const completed = sorted.some(item => /\.(cancelled|completed|decision|finish|recorded)$/.test(item.name));
      const explicitRole = messageRole(attributes["message.role"]);
      const role = explicitRole ?? (attributes["result.text"]
        ? "assistant"
        : kind === "message"
          ? "user"
          : undefined);
      const command = commandDetails(attributes, sorted);
      const started = /\.(request|start|started)$/.test(first.name);
      const unfinishedTerminalStatus = started
        && invocation.status !== "pending"
        && invocation.status !== "running"
        ? invocation.status === "failed" ? "failed" : "completed"
        : undefined;
      const draft = {
        attributes,
        body: patches.join("") || messageBody || activityBody(attributes),
        command,
        id,
        kind,
        name: first.name,
        patches,
        paths,
        sequence: first.sequence,
        ...(numericAttribute(attributes, "usage.reasoningTokens", "usage.reasoningOutputTokens") !== undefined
          ? { reasoningTokens: numericAttribute(attributes, "usage.reasoningTokens", "usage.reasoningOutputTokens") }
          : {}),
        ...(role ? { role } : {}),
        status: failed || approvalDenied ? "failed" : completed || !started ? "completed" : unfinishedTerminalStatus ?? "running",
        ...(sorted.some(item => item.attributes?.["vitehub.observation.truncated"] === true)
          ? { truncated: true }
          : {}),
        ...(numericAttribute(attributes, "usage.totalTokens") !== undefined
          ? { totalTokens: numericAttribute(attributes, "usage.totalTokens") }
          : {}),
      } satisfies Omit<InvocationActivity, "preview">;
      const title = invocationActivityTitle(draft);
      return {
        ...draft,
        ...(activityPreview(attributes, command, paths, title) ? { preview: activityPreview(attributes, command, paths, title) } : {}),
      };
    })
    .sort((left, right) => left.sequence - right.sequence);
  if (traceTruncated && !activities.some(activity => activity.truncated)) {
    if (activities.length > 0) activities[activities.length - 1] = { ...activities[activities.length - 1]!, truncated: true };
    else activities.push({ attributes: {}, id: "trace-truncated", kind: "run", name: "vitehub.observation.truncated", patches: [], paths: [], sequence: 0, status: "completed", truncated: true });
  }
  return activities;
}

export function latestInvocationTokens(activities: readonly InvocationActivity[]): number | undefined {
  const snapshots = activities.flatMap(activity => activity.totalTokens === undefined ? [] : [activity.totalTokens]);
  return snapshots.length ? Math.max(...snapshots) : undefined;
}

export function invocationActivityTitle(activity: InvocationActivity): string {
  const explicit = activity.attributes["vitehub.activity.title"];
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
  if (activity.name === "vitehub.observation.truncated") return "Trace content was truncated";
  if (activity.name === "vitehub.agent.configured") return "Agent configured";
  if (activity.kind === "preparation") return "Prepared session";
  if (activity.kind === "system") return "System configuration";
  if (activity.kind === "delivery") return channelDeliveryTitle(activity);
  if (activity.kind === "action") return String(activity.attributes["channel.effect.kind"] ?? activity.attributes["vitehub.action.name"] ?? "Product action");
  if (activity.kind === "plan") return "Updated plan";
  if (activity.kind === "change") return normalizedTitle(String(activity.attributes["tool.name"] ?? "Changed files"));
  if (activity.kind === "tool") return normalizedTitle(String(activity.attributes["tool.title"] ?? activity.attributes["tool.name"] ?? "Used a tool"));
  if (activity.kind === "approval") {
    if (activity.attributes["approval.approved"] === true) return "Approval granted";
    if (activity.attributes["approval.approved"] === false) return "Approval denied";
    return String(activity.attributes["approval.name"] ?? "Requested approval");
  }
  if (activity.kind === "reasoning") return "Thinking";
  if (activity.kind === "model") return "Thinking";
  if (activity.kind === "run") return activity.name.endsWith(".finish") ? "Finished session" : "Started session";
  return normalizedTitle(activity.name.replace(/\.(start|finish|error|decision|recorded)$/, "").replaceAll(".", " "));
}

export function agentConfigurationSummary(activity: InvocationActivity): string | undefined {
  if (activity.name !== "vitehub.agent.configured") return;
  const configuration = record(activity.attributes["vitehub.agent.configuration"]);
  if (!configuration) return;
  const driver = record(configuration.driver);
  const model = record(driver?.model);
  const modelName = stringAttribute(model ?? {}, "id") ?? stringAttribute(driver ?? {}, "provider");
  const capabilities = Array.isArray(configuration.capabilities) ? configuration.capabilities.length : 0;
  const tools = Array.isArray(configuration.tools) ? configuration.tools.length : 0;
  return [
    modelName,
    capabilities ? `${capabilities} ${capabilities === 1 ? "capability" : "capabilities"}` : undefined,
    tools ? `${tools} ${tools === 1 ? "tool" : "tools"}` : undefined,
  ].filter(Boolean).join(" · ") || undefined;
}

function channelDeliveryTitle(activity: InvocationActivity): string {
  const rawKind = String(activity.attributes["channel.effect.kind"] ?? "").trim();
  const kind = rawKind.toLocaleLowerCase();
  const intent = String(activity.attributes["channel.effect.intent"] ?? "").trim().toLocaleLowerCase();
  if (kind === "reaction") {
    const reaction: Record<string, string> = { completed: "hooray", failed: "confused", started: "eyes" };
    return reaction[intent] ? `Reacted with ${reaction[intent]}` : "Reaction sent";
  }
  if (kind === "reply") return "Reply sent";
  if (kind === "status") return "Status updated";
  if (kind === "title") return "Title updated";
  if (kind === "update") return "Message updated";
  if (rawKind.includes(".")) return rawKind;
  return kind ? `${normalizedTitle(kind)} delivered` : "Channel delivery";
}

export function channelDeliverySummary(activity: InvocationActivity): string | undefined {
  if (activity.kind !== "delivery") return;
  if (activity.attributes["channel.effect.supported"] === false) return "Not supported";
  const skipped = stringAttribute(activity.attributes, "channel.effect.skipped");
  if (skipped) return normalizedTitle(skipped);
  const kind = String(activity.attributes["channel.effect.kind"] ?? "").trim().toLocaleLowerCase();
  const intent = String(activity.attributes["channel.effect.intent"] ?? "").trim();
  if (!intent || (kind === "reaction" && ["completed", "failed", "started"].includes(intent.toLocaleLowerCase()))) return;
  return normalizedTitle(intent);
}

export function terminalText(value: string | undefined): string {
  if (!value) return "";
  const escape = String.fromCharCode(27);
  return value.replace(new RegExp(`${escape}\\[[0-?]*[ -/]*[@-~]`, "g"), "").replaceAll("\r", "");
}
