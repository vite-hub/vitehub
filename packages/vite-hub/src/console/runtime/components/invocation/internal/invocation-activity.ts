import type { TraceEventLogEntry } from "@vite-hub/runtime";
import type { AgentInvocationView, AgentToolInspection } from "../types.ts";
import { payloadText } from "./payload-text.ts";

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

interface InvocationSkillRead {
  name: string;
  path: string;
}

export interface InvocationActivity {
  attributes: Record<string, unknown>;
  body?: string;
  command?: InvocationCommand;
  durationMs?: number;
  endedAt?: string;
  id: string;
  kind: InvocationActivityKind;
  name: string;
  patches: readonly string[];
  paths: readonly string[];
  preview?: string;
  reasoningTokens?: number;
  role?: "assistant" | "system" | "tool" | "user";
  sequence: number;
  skill?: InvocationSkillRead;
  skills?: readonly InvocationSkillRead[];
  startedAt?: string;
  status: "running" | "completed" | "failed";
  /** Display metadata the called tool declares in the configuration catalog. */
  toolDisplay?: Pick<AgentToolInspection, "icon" | "label">;
  totalTokens?: number;
  truncated?: boolean;
  /** Displayed attributes the journal shortened. Absent when the record does not name them. */
  truncatedAttributes?: readonly string[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const truncatedContentLabels: Readonly<Record<string, string>> = {
  "approval.input": "Approval input",
  "approval.reason": "Approval reason",
  body: "Details",
  "channel.effect.content": "Delivered text",
  content: "Details",
  "error.message": "Error",
  input: "Input",
  "input.messages": "Conversation history",
  "input.prompt": "Conversation history",
  "message.content": "Message",
  output: "Output",
  "result.text": "Message",
  "tool.error": "Error",
  "tool.input": "Input",
  "tool.output": "Output",
  "vitehub.activity.body": "Details",
  "vitehub.activity.detail": "Details",
  "vitehub.activity.progress": "Details",
  "vitehub.activity.title": "Title",
  "vitehub.payload.value": "Details",
};

/**
 * The displayed attributes that an observation's truncation flag covers.
 * `undefined` means the record is flagged but does not name its attributes, so any displayed value may be cut.
 * Identity and accounting metadata are never displayed, so their truncation returns an empty list.
 */
function truncatedContent(observation: Pick<TraceEventLogEntry, "attributes">): readonly string[] | undefined {
  const attributes = observation.attributes;
  if (attributes?.["vitehub.observation.truncated"] !== true) return [];
  const named = attributes["vitehub.observation.truncatedAttributes"];
  if (!Array.isArray(named)) return undefined;
  return named.filter((key): key is string => typeof key === "string" && key in truncatedContentLabels);
}

function cutsContent(observation: Pick<TraceEventLogEntry, "attributes">): boolean {
  return truncatedContent(observation)?.length !== 0;
}

/** The note that says which displayed value of an activity was shortened. */
export function invocationTruncationNotice(activity: InvocationActivity): string | undefined {
  if (!activity.truncated) return;
  const labels = [...new Set((activity.truncatedAttributes ?? []).map(key => truncatedContentLabels[key]!))];
  if (!labels.length) return "Part of this activity was shortened when it was recorded.";
  const subject = labels.length === 1
    ? labels[0]!
    : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)!.toLowerCase()}`;
  return `${subject} shortened when recorded.`;
}

function messageText(value: unknown): string | undefined {
  const message = record(value);
  if (!Array.isArray(message?.parts)) return;
  const parts = message.parts.flatMap((part) => {
    const item = record(part);
    if (typeof item?.text === "string") return [item.text];
    if (item?.type === "image" && typeof item.url === "string" && /^(https?:\/\/|\/(?!\/))/.test(item.url)) {
      const name = typeof item.name === "string" ? item.name.replace(/[\[\]\r\n]/g, "") : "Attachment";
      const url = item.url.replace(/[<>\r\n]/g, "");
      return [`\n\n![${name}](<${url}>)\n\n`];
    }
    return [];
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
    "vitehub.activity.progress",
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
    try {
      const json = JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? `${item}n` : item, 2);
      if (json) return json;
    } catch (error) {
      return error instanceof Error ? `[Unable to display payload: ${error.message}]` : "[Unable to display payload]";
    }
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
    // Diff views take one file per patch, and a turn diff can change several files.
    return {
      patches: (body.endsWith("\n") ? body : `${body}\n`).split(/^(?=diff --git )/m).filter(patch => patch.startsWith("diff --git ")),
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

function skillReadDetails(attributes: Record<string, unknown>): InvocationSkillRead[] {
  const reads: InvocationSkillRead[] = [];
  const add = (path: string) => {
    if (path.includes("\\") || path.includes("//")) return;
    const match = /^\.agents\/skills\/([^/.][^/]*)\/SKILL\.md$/.exec(path);
    if (match?.[1] && !reads.some(read => read.path === path)) reads.push({ name: match[1], path });
  };
  for (const key of ["tool.output", "tool.input"]) {
    const payload = record(attributes[key]);
    const item = record(payload?.item) ?? payload;
    if (!item || !Array.isArray(item.commandActions)) continue;
    for (const value of item.commandActions) {
      const action = record(value);
      const cwd = typeof item.cwd === "string" ? item.cwd.replace(/\/+$/, "") : undefined;
      if (action?.type === "read" && typeof action.path === "string") {
        add(cwd && action.path.startsWith(`${cwd}/`)
          ? action.path.slice(cwd.length + 1)
          : action.path.replace(/^\.\//, ""));
        continue;
      }
      if (action?.type !== "unknown" || typeof action.command !== "string") continue;
      const tokens = action.command.trim().split(/\s+/);
      if (tokens[0] !== "cat" || tokens.length < 2 || tokens.slice(1).some(token => token.startsWith("-") || /[\\'"`$;&|<>(){}[\]*?!]/.test(token))) continue;
      for (const token of tokens.slice(1)) add(token.replace(/^\.\//, ""));
    }
  }
  return reads;
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
    const detail = item && stringAttribute(item, "detail", "summary", "output", "query", "path");
    if (detail) return detail.split(/\r?\n/).find(Boolean)?.trim();
  }
  return stringAttribute(attributes, "tool.detail", "tool.output.summary", "vitehub.activity.detail");
}

/** Sentences for common snake_case tool identifiers. Other identifiers keep their words with the underscores removed. */
const toolTitles: Record<string, string> = {
  apply_patch: "Changed files",
  command_execution: "Ran command",
  edit_file: "Changed files",
  exec_command: "Ran command",
  file_change: "Changed files",
  grep_search: "Searched code",
  list_dir: "Listed directory",
  read_file: "Read file",
  run_command: "Ran command",
  web_fetch: "Fetched page",
  web_search: "Searched the web",
  write_file: "Changed files",
};

function normalizedTitle(value: string): string {
  const trimmed = value.replace(/\s+(?:complete|completed)$/i, "").trim();
  // Provider tools arrive as `<server>.<tool>`, and proxied MCP tools as `<server>.mcp_<service>_<tool>`.
  const namespaced = /^[a-z0-9-]+\.[a-z0-9_]+$/i.test(trimmed);
  const name = namespaced ? trimmed.slice(trimmed.indexOf(".") + 1).replace(/^mcp_(?=[a-z0-9]+_)/i, "") : trimmed;
  const known = toolTitles[name.toLocaleLowerCase()];
  if (known) return known;
  const title = namespaced || /^[a-z0-9]+(?:_[a-z0-9]+)+$/i.test(name)
    ? name.split("_").map(word => word.toLocaleLowerCase() === "mcp" ? "MCP" : word).join(" ")
    : name;
  return title ? title[0]!.toUpperCase() + title.slice(1) : "Activity";
}

/** Shows the script that `sh -lc '<script>'` wrappers run, so the row reads as the command the agent typed. */
function shellScript(command: string): string {
  const match = /^(?:\/(?:usr\/)?bin\/)?(?:ba|z|da)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/.exec(command.trim());
  if (!match) return command;
  return match[1] === "'" ? match[2]!.replaceAll("'\\''", "'") : match[2]!.replace(/\\(["\\$`])/g, "$1");
}

function activityPreview(
  attributes: Record<string, unknown>,
  command: InvocationCommand | undefined,
  paths: readonly string[],
  title: string,
): string | undefined {
  const detail = (command ? shellScript(command.command) : undefined) ?? payloadDetail(attributes) ?? (paths.length
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
  if (attributes["message.phase"] === "commentary") return "message";
  if (attributes["message.phase"] === "reasoning") return "reasoning";
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

function isRecordedTool(value: unknown): value is Pick<AgentToolInspection, "icon" | "label" | "name"> {
  const tool = record(value);
  return typeof tool?.name === "string"
    && (tool.icon === undefined || typeof tool.icon === "string")
    && (tool.label === undefined || typeof tool.label === "string");
}

export function invocationActivities(invocation: AgentInvocationView): InvocationActivity[] {
  const groups = new Map<string, TraceEventLogEntry[]>();
  // Historical journals can hold truncation markers in place of tool entries.
  const recordedTools: readonly unknown[] = Array.isArray(invocation.configuration?.tools) ? invocation.configuration.tools : [];
  const toolCatalog = new Map(recordedTools.flatMap(tool => isRecordedTool(tool) ? [[tool.name, tool] as const] : []));
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
    if (originalAttributes["vitehub.auxiliary.kind"] === "title") continue;
    if (
      observation.name === "agent.stream.error"
      && originalAttributes["error.recoverable"] === true
    ) continue;
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
      let lastInputKey: string | undefined;
      inputMessages.forEach((message, index) => {
        const value = record(message);
        const body = messageText(value) ?? (Array.isArray(value?.parts) ? "```json\n" + payloadText(value.parts) + "\n```" : undefined);
        const role = messageRole(value?.role);
        if (!body || !role) return;
        const key = `input-message:${observation.sequence}:${index}`;
        lastInputKey = key;
        groups.set(key, [{
          ...observation,
          attributes: {
            "message.content": body,
            "message.origin": "invocation-input",
            "message.id": value ? stringAttribute(value, "id") ?? key : key,
            "message.role": role,
          },
          name: "agent.input.message",
          sequence: observation.sequence - (inputMessages.length - index) / (inputMessages.length + 1),
        }]);
      });
      // One note after the history says it was shortened; repeating it on every message adds noise.
      const historyTruncation = truncatedContent(observation) === undefined
        ? { "vitehub.observation.truncated": true }
        : truncatedContent(observation)!.some(key => key === "input.messages" || key === "input.prompt")
          ? { "vitehub.observation.truncated": true, "vitehub.observation.truncatedAttributes": ["input.messages"] }
          : undefined;
      const lastInput = lastInputKey === undefined ? undefined : groups.get(lastInputKey)?.[0];
      if (lastInput && historyTruncation) lastInput.attributes = { ...lastInput.attributes, ...historyTruncation };
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
    const group = groups.get(key);
    const groupedObservation = { ...observation, attributes };
    if (group) group.push(groupedObservation);
    else groups.set(key, [groupedObservation]);
  }

  // A finish record can truncate usage metadata while preserving the whole response.
  // Only suppress its message warning when an untruncated assistant turn proves it intact.
  const completeAssistantTexts = new Set<string>();
  let latestMessageSequence = -Infinity;
  for (const observations of groups.values()) {
    const sequence = Math.max(...observations.map(item => item.sequence));
    if (sequence > latestMessageSequence && observations.every(item => item.name.startsWith("agent.message")
      || item.name === "agent.input.message")) latestMessageSequence = sequence;
  }
  for (const observations of groups.values()) {
    if (Math.max(...observations.map(item => item.sequence)) !== latestMessageSequence) continue;
    if (observations.some(cutsContent)) continue;
    if (!observations.every(item => item.name.startsWith("agent.message")
      && (item.attributes?.["message.role"] === undefined || item.attributes["message.role"] === "assistant")
      && item.attributes?.["message.phase"] !== "commentary")) continue;
    const text = observations.map(item => {
      const content = item.attributes?.["message.content"];
      return typeof content === "string" ? content : "";
    }).join("").trim();
    if (!text) continue;
    completeAssistantTexts.add(text);
    try {
      const response = record(JSON.parse(text));
      const responseText = response && stringAttribute(response, "text");
      if (responseText) completeAssistantTexts.add(responseText);
    } catch {
      // Plain text and incomplete JSON cannot verify a structured response's text field.
    }
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
      const failed = sorted.some(item => item.type === "error" || /\.(error|failed)$/.test(item.name))
        || (kind === "delivery" && Boolean(stringAttribute(attributes, "error.message")))
        || attributes["agent.capability.outcome"] === "error";
      const approvalDenied = attributes["approval.approved"] === false;
      const completed = sorted.some(item => /\.(abort|cancelled|completed|decision|error|failed|finish|recorded)$/.test(item.name));
      const explicitRole = messageRole(attributes["message.role"]);
      const role = explicitRole ?? (attributes["result.text"]
        ? "assistant"
        : kind === "message"
          ? "user"
          : undefined);
      const command = commandDetails(attributes, sorted);
      const skills = skillReadDetails(attributes);
      const observedEndedAt = sorted.at(-1)?.timestamp;
      const invocationEndedAt = invocation.completedAt ?? invocation.failedAt ?? invocation.cancelledAt;
      const started = /\.(request|start|started)$/.test(first.name);
      const unfinishedTerminalStatus = started
        && !completed
        && invocation.status !== "pending"
        && invocation.status !== "running"
        ? invocation.status === "failed" ? "failed" : "completed"
        : undefined;
      const endedAt = unfinishedTerminalStatus
        ? invocationEndedAt ?? observedEndedAt
        : started && !completed && invocation.status === "running"
          ? invocation.updatedAt
          : observedEndedAt;
      const observedDuration = Date.parse(endedAt ?? "") - Date.parse(first.timestamp);
      const durationMs = numericAttribute(attributes, "tool.durationMs")
        ?? (Number.isFinite(observedDuration) ? Math.max(0, observedDuration) : undefined);
      const terminalStartedAt = !started && endedAt && durationMs !== undefined
        ? new Date(Date.parse(endedAt) - durationMs).toISOString()
        : undefined;
      const catalogTool = kind === "tool" ? toolCatalog.get(String(attributes["tool.name"] ?? "")) : undefined;
      const toolDisplay = {
        ...(catalogTool?.icon ? { icon: catalogTool.icon } : {}),
        ...(catalogTool?.label ? { label: catalogTool.label } : {}),
      };
      const draft = {
        attributes,
        body: patches.join("") || messageBody || activityBody(attributes),
        command,
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(endedAt ? { endedAt } : {}),
        id,
        kind,
        name: first.name,
        patches,
        paths,
        sequence: first.sequence,
        ...(skills.length ? { skill: skills[0], skills } : {}),
        startedAt: terminalStartedAt ?? first.timestamp,
        ...(numericAttribute(attributes, "usage.reasoningTokens", "usage.reasoningOutputTokens") !== undefined
          ? { reasoningTokens: numericAttribute(attributes, "usage.reasoningTokens", "usage.reasoningOutputTokens") }
          : {}),
        ...(role ? { role } : {}),
        status: failed || approvalDenied ? "failed" : completed || !started ? "completed" : unfinishedTerminalStatus ?? "running",
        ...(Object.keys(toolDisplay).length ? { toolDisplay } : {}),
        ...(sorted.some(cutsContent)
          && !(first.name === "agent.invocation.finish" && completeAssistantTexts.has(stringAttribute(attributes, "result.text") ?? ""))
          ? {
              truncated: true,
              ...(sorted.every(item => truncatedContent(item) !== undefined)
                ? { truncatedAttributes: [...new Set(sorted.flatMap(item => truncatedContent(item)!))] }
                : {}),
            }
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
  const visibleActivities = activities.filter(activity => !(
    activity.kind === "run"
    && /^agent\.invocation\.(?:start|started)$/.test(activity.name)
  ));
  if (traceTruncated && !visibleActivities.some(activity => activity.name === "vitehub.observation.truncated")) {
    visibleActivities.push({
      attributes: {},
      id: "trace-truncated",
      kind: "system",
      name: "vitehub.observation.truncated",
      patches: [],
      paths: [],
      sequence: (visibleActivities.at(-1)?.sequence ?? -1) + 1,
      status: "completed",
    });
  }
  return visibleActivities;
}

/** Count distinct calls per tool name. */
export function invocationToolUsage(invocation: AgentInvocationView): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  const seen = new Set<string>();
  for (const observation of invocation.observations) {
    const name = observation.attributes?.["tool.name"];
    if (typeof name !== "string" || !name) continue;
    const id = observation.attributes?.["tool.id"];
    if (typeof id === "string" && id) {
      const key = `${name}:${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
    } else if (!observation.name.endsWith(".start")) {
      continue;
    }
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

export function latestInvocationTokens(activities: readonly InvocationActivity[]): number | undefined {
  const snapshots = activities.flatMap(activity => activity.totalTokens === undefined ? [] : [activity.totalTokens]);
  return snapshots.length ? Math.max(...snapshots) : undefined;
}

/** The short detail of an activity: its command, path, or recorded detail. */
export function invocationActivityDetail(activity: InvocationActivity): string | undefined {
  return activity.preview ?? stringAttribute(activity.attributes, "vitehub.activity.detail");
}

export function invocationActivityTitle(activity: InvocationActivity): string {
  const explicit = activity.attributes["vitehub.activity.title"];
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
  if (activity.name === "vitehub.observation.truncated") return "Trace content was truncated";
  if (activity.name === "vitehub.agent.configured") return agentConfigurationTitle(activity);
  if (activity.skill) return `Read ${activity.skill.name} skill`;
  if (activity.kind === "preparation") return "Prepared session";
  if (activity.kind === "system") return "System configuration";
  if (activity.kind === "delivery") return channelDeliveryTitle(activity);
  if (activity.attributes["vitehub.action.name"] === "progress-summary.update") return "Updated loading message";
  if (activity.attributes["vitehub.action.name"] === "input.steered") return "Steered active session";
  if (activity.kind === "action") return String(activity.attributes["channel.effect.kind"] ?? activity.attributes["vitehub.action.name"] ?? "Product action");
  if (activity.kind === "plan") return "Updated plan";
  if (activity.kind === "change") return normalizedTitle(String(activity.attributes["tool.name"] ?? "Changed files"));
  if (activity.kind === "tool") {
    // Codex records the script as tool.title; the command preview already shows it.
    if (activity.attributes["tool.name"] === "command_execution") return normalizedTitle("command_execution");
    return normalizedTitle(String(activity.attributes["tool.title"] ?? activity.toolDisplay?.label ?? activity.attributes["tool.name"] ?? "Used a tool"));
  }
  if (activity.kind === "approval") {
    if (activity.attributes["approval.approved"] === true) return "Approval granted";
    if (activity.attributes["approval.approved"] === false) return "Approval denied";
    return String(activity.attributes["approval.name"] ?? "Requested approval");
  }
  if (activity.kind === "reasoning") return "Thinking";
  if (activity.kind === "model") return "Thinking";
  if (activity.kind === "run") return activity.name.endsWith(".finish") ? "Finished session" : "Started session";
  if (activity.kind === "error" && activity.name.startsWith("agent.invocation.")) return "Session failed";
  return normalizedTitle(activity.name.replace(/\.(start|finish|error|decision|recorded)$/, "").replaceAll(".", " "));
}

function agentConfigurationTitle(activity: InvocationActivity): string {
  const configuration = record(activity.attributes["vitehub.agent.configuration"]);
  if (!configuration) return "Agent configured";
  const agent = stringAttribute(record(configuration.agent) ?? {}, "name") ?? "Agent";
  const capabilities = Array.isArray(configuration.capabilities) ? configuration.capabilities.length : 0;
  return capabilities
    ? `Configured ${agent} with ${capabilities} ${capabilities === 1 ? "capability" : "capabilities"}`
    : `Configured ${agent}`;
}

export function agentConfigurationSummary(activity: InvocationActivity): string | undefined {
  if (activity.name !== "vitehub.agent.configured") return;
  const configuration = record(activity.attributes["vitehub.agent.configuration"]);
  if (!configuration) return;
  const driver = record(configuration.driver);
  const model = record(driver?.model);
  const modelName = stringAttribute(model ?? {}, "id") ?? stringAttribute(driver ?? {}, "provider");
  const tools = Array.isArray(configuration.tools) ? configuration.tools.length : 0;
  return [
    modelName,
    tools ? `${tools} ${tools === 1 ? "tool" : "tools"}` : undefined,
  ].filter(Boolean).join(" · ") || undefined;
}

function channelDeliveryTitle(activity: InvocationActivity): string {
  const rawKind = String(activity.attributes["channel.effect.kind"] ?? "").trim();
  const kind = rawKind.toLocaleLowerCase();
  const intent = String(activity.attributes["channel.effect.intent"] ?? "").trim().toLocaleLowerCase();
  const delivery = rawKind.includes(".") ? rawKind : kind ? normalizedTitle(kind) : "Channel delivery";
  if (activity.attributes["channel.effect.supported"] === false) return `${delivery} not supported`;
  if (stringAttribute(activity.attributes, "channel.effect.skipped")) return `${delivery} skipped`;
  if (activity.status === "failed") return `${delivery} failed`;
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
