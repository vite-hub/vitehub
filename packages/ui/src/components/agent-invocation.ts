import { computed, defineComponent, h, nextTick, onBeforeUnmount, ref, type PropType, Suspense } from "vue";
import type { AgentInvocationConfiguration, AgentInvocationView } from "../types.ts";
import {
  agentConfigurationSummary,
  channelDeliverySummary,
  invocationActivities,
  invocationActivityTitle,
  latestInvocationTokens,
  stringAttribute,
  terminalText,
  type InvocationActivity,
} from "../internal/invocation-activity.ts";
import { isSafeExternalUrl } from "../internal/url.ts";
import { AgentPatchDiff } from "./agent-code-view.ts";
import { AgentMarkdown } from "./agent-markdown.ts";

function invocationTitle(invocation: AgentInvocationView): string {
  const annotated = invocation.annotations?.["github.title"];
  return invocation.title
    ?? (typeof annotated === "string" ? annotated : undefined)
    ?? invocation.agentName
    ?? "Agent invocation";
}

function invocationContext(invocation: AgentInvocationView): string {
  const repository = invocation.annotations?.["github.repository"];
  const pullRequest = invocation.annotations?.["github.pullRequest"];
  if (typeof repository === "string" && (typeof pullRequest === "string" || typeof pullRequest === "number")) {
    return `${repository} · PR #${pullRequest}`;
  }
  return invocation.threadId ?? invocation.origin ?? invocation.id;
}

function invocationRepository(invocation: AgentInvocationView): string | undefined {
  const repository = invocation.annotations?.["github.repository"];
  return typeof repository === "string" ? repository : undefined;
}

function invocationProject(invocation: AgentInvocationView): string {
  return invocationRepository(invocation)?.split("/").at(-1)
    ?? invocation.configuration?.workspace?.name
    ?? invocation.agentName
    ?? "Workspace";
}

function statusLabel(status: AgentInvocationView["status"]): string {
  return {
    cancelled: "Cancelled",
    completed: "Completed",
    failed: "Failed",
    pending: "Queued",
    running: "Working",
  }[status];
}

function compactCommand(command: string): string {
  const normalized = command.replaceAll(/\s+/g, " ").trim();
  return normalized.length > 96 ? `${normalized.slice(0, 95)}…` : normalized;
}

function formatTokens(value: number | undefined): string | undefined {
  if (value === undefined) return;
  if (value < 1_000) return `${value} tokens`;
  return `${new Intl.NumberFormat("en", { maximumFractionDigits: 1, notation: "compact" }).format(value)} tokens`;
}

function formatDuration(startedAt: string | undefined, completedAt: string | undefined): string | undefined {
  if (!startedAt || !completedAt) return;
  const duration = Date.parse(completedAt) - Date.parse(startedAt);
  if (!Number.isFinite(duration) || duration < 0) return;
  const seconds = Math.round(duration / 1_000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function formatTimelineDuration(value: number): string | undefined {
  if (!Number.isFinite(value) || value < 0) return;
  if (value < 1_000) return `${Math.round(value)}ms`;
  if (value < 60_000) {
    return `${new Intl.NumberFormat("en", { maximumFractionDigits: 1 }).format(value / 1_000)}s`;
  }
  const seconds = Math.round(value / 1_000);
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function driverLabel(configuration: AgentInvocationConfiguration): string | undefined {
  const driver = configuration.driver;
  const model = driver?.model;
  return [
    driver?.kind,
    model?.provider ?? driver?.provider,
    model?.id,
  ].filter(Boolean).join(" · ") || undefined;
}

function workspaceLabel(configuration: AgentInvocationConfiguration): string | undefined {
  const workspace = configuration.workspace;
  return workspace ? [workspace.name, workspace.mode].filter(Boolean).join(" · ") : undefined;
}

function markdown(value: string | undefined, className: string) {
  if (!value) return null;
  return h(Suspense, null, {
    default: () => h(AgentMarkdown, { class: className, value }),
    fallback: () => h("p", { class: className }, value),
  });
}

function renderFolderIcon() {
  return h("svg", { "aria-hidden": "true", fill: "none", viewBox: "0 0 24 24" }, [
    h("path", { d: "M3 6.5h6l2 2h10v9.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z", "stroke-linecap": "round", "stroke-linejoin": "round" }),
  ]);
}

type InspectTarget = "agent" | "workspace";

const messageRoleLabels: Record<NonNullable<InvocationActivity["role"]>, string> = {
  assistant: "Assistant",
  system: "System",
  tool: "Tool",
  user: "User",
};

function renderMessage(
  activity: InvocationActivity,
  expanded: ReadonlySet<string>,
  toggleExpanded: (id: string) => void,
) {
  const body = activity.body ?? "";
  const collapsible = activity.role === "user" && (body.length > 720 || body.split(/\r?\n/).length > 12);
  const isExpanded = expanded.has(activity.id);
  return h(
    "li",
    {
      class: "vh-invocation-message",
      "data-role": activity.role,
      key: activity.id,
    },
    [
      h("span", { class: "vh-visually-hidden" }, `${messageRoleLabels[activity.role ?? "assistant"]} message`),
      h("div", {
        class: "vh-invocation-message__content",
        "data-collapsed": collapsible && !isExpanded ? "true" : undefined,
      }, [markdown(body, "vh-invocation-message__body")]),
      activity.truncated
        ? h("p", { class: "vh-invocation-event__notice" }, "Some trace content was truncated by the invocation journal.")
        : null,
      collapsible
        ? h("button", {
            "aria-expanded": String(isExpanded),
            class: "vh-invocation-message__more",
            onClick: () => toggleExpanded(activity.id),
            type: "button",
          }, isExpanded ? "Show less" : "Read more")
        : null,
    ],
  );
}

type ActivityIcon =
  | "action"
  | "approval"
  | "bot"
  | "change"
  | "check"
  | "command"
  | "error"
  | "eye"
  | "folder"
  | "github"
  | "label"
  | "message"
  | "pull-request"
  | "search"
  | "tool";

function activityIcon(activity: InvocationActivity): ActivityIcon {
  if (activity.status === "failed" || activity.kind === "error") return "error";
  const name = String(activity.attributes["tool.name"] ?? "").toLocaleLowerCase();
  if (activity.command) return "command";
  if (activity.kind === "change") return "change";
  if (name.includes("read") || name.includes("image") || name.includes("view")) return "eye";
  if (name.includes("search") || name.includes("find")) return "search";
  if (activity.kind === "reasoning" || activity.kind === "model") return "bot";
  if (activity.kind === "approval") return "approval";
  if (activity.kind === "delivery") {
    const delivery = String(activity.attributes["channel.effect.kind"] ?? "").toLocaleLowerCase();
    if (delivery === "reaction") return "eye";
    if (["reply", "status", "update"].includes(delivery)) return "message";
    return "action";
  }
  if (activity.kind === "action") return "check";
  if (activity.kind === "preparation") {
    const title = invocationActivityTitle(activity).toLocaleLowerCase();
    if (title.includes("pull request")) return "pull-request";
    if (title.includes("github")) return "github";
    if (title.includes("workspace")) return "folder";
    if (title.includes("agent")) return "bot";
    if (title.includes("prompt")) return "message";
    return "check";
  }
  if (activity.kind === "system") return "bot";
  return "tool";
}

const activityIconPaths: Record<ActivityIcon, readonly string[]> = {
  action: ["M13 2 3 14h9l-1 8 10-12h-9z"],
  approval: ["M12 3v12", "m8 11 4 4 4-4", "M5 21h14"],
  bot: ["M12 8V4H8", "M4 8h16v10H4z", "M8 12h.01", "M16 12h.01"],
  change: ["M12 20h9", "M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"],
  check: ["m5 12 4 4L19 6"],
  command: ["m4 17 6-6-6-6", "M12 19h8"],
  error: ["M18 6 6 18", "m6 6 12 12"],
  eye: ["M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12", "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6"],
  folder: ["M3 6.5h6l2 2h10v9.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"],
  github: ["M15 22v-4a4.8 4.8 0 0 0-1-3.5c3.28-.36 6.72-1.61 6.72-7A5.4 5.4 0 0 0 19.22 3.77 5.07 5.07 0 0 0 19.13.32S17.95-.04 15 1.8a13.38 13.38 0 0 0-6 0C6.05-.04 4.87.32 4.87.32A5.07 5.07 0 0 0 4.78 3.77a5.4 5.4 0 0 0-1.5 3.78c0 5.42 3.44 6.61 6.72 7A4.8 4.8 0 0 0 9 18v4", "M9 18c-4.51 2-5-2-7-2"],
  label: ["M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l4.58-4.58a2.426 2.426 0 0 0 0-3.42z", "M7.5 7.5h.01"],
  message: ["M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"],
  "pull-request": [
    "M6 9v12",
    "M18 15V8a2 2 0 0 0-2-2h-3",
    "M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6",
    "M18 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6",
  ],
  search: ["m21 21-4.35-4.35", "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16"],
  tool: ["M14.7 6.3a4 4 0 0 0-5-5l2.1 2.1-2.4 2.4-2.1-2.1a4 4 0 0 0 5 5L3 18l3 3 9.3-9.3a4 4 0 0 0 5-5l-2.1 2.1-2.4-2.4z"],
};

function renderActivityIcon(activity: InvocationActivity) {
  return renderNamedActivityIcon(activityIcon(activity));
}

function renderNamedActivityIcon(icon: ActivityIcon) {
  return h("span", { class: "vh-invocation-event__icon", "data-icon": icon, "aria-hidden": "true" }, [
    h("svg", { fill: "none", viewBox: "0 0 24 24" }, activityIconPaths[icon].map(path => h("path", {
      d: path,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    }))),
  ]);
}

function renderEvent(activity: InvocationActivity, inspect: (target: InspectTarget) => void) {
  const command = activity.command;
  const tokenLabel = activity.kind === "reasoning" || activity.kind === "model"
    ? formatTokens(activity.reasoningTokens)
    : undefined;
  const suffix = agentConfigurationSummary(activity)
    ?? channelDeliverySummary(activity)
    ?? (activity.preview ? compactCommand(activity.preview) : tokenLabel);
  const hasPayloads = activity.kind === "tool" && (
    activity.attributes["tool.input"] !== undefined
    || activity.attributes["tool.output"] !== undefined
    || activity.attributes["tool.error"] !== undefined
  );
  const hasDetails = activity.patches.length > 0 || Boolean(command || hasPayloads || activity.body || activity.truncated);
  const inspectTarget = activity.attributes["vitehub.inspect.target"] ?? (activity.name === "vitehub.agent.configured" ? "agent" : undefined);
  const inspectable = inspectTarget === "agent" || inspectTarget === "workspace";
  const summaryContent = [
    renderActivityIcon(activity),
    h("span", { class: "vh-invocation-event__title" }, invocationActivityTitle(activity)),
    activity.status === "failed" ? h("span", { class: "vh-visually-hidden" }, "Failed") : null,
    suffix ? h("code", { class: "vh-invocation-event__suffix" }, suffix) : null,
    hasDetails
      ? h("span", { class: "vh-invocation-event__disclosure", "aria-hidden": "true" }, "⌄")
      : null,
  ];
  const summary = inspectable && !hasDetails
    ? h("button", {
        class: "vh-invocation-event__summary",
        onClick: () => inspect(inspectTarget),
        type: "button",
      }, summaryContent)
    : h(hasDetails ? "summary" : "div", { class: "vh-invocation-event__summary" }, summaryContent);
  return h("li", {
    class: "vh-invocation-activity",
    "data-activity-id": activity.id,
    "data-inspectable": inspectable ? "true" : undefined,
    "data-kind": activity.kind,
    "data-status": activity.status,
    key: activity.id,
  }, [
    h(hasDetails ? "details" : "div", {
      class: "vh-invocation-event",
    }, [
      summary,
      hasDetails ? h("div", { class: "vh-invocation-event__details" }, [
        activity.truncated
          ? h("p", { class: "vh-invocation-event__notice" }, "Some trace content was truncated by the invocation journal.")
          : null,
        activity.patches.length
          ? h("div", { class: "vh-invocation-event__diffs" }, activity.patches.map((patch, index) => h(AgentPatchDiff, { key: index, patch })))
          : command
          ? h("div", { class: "vh-invocation-command" }, [
              h("div", { class: "vh-invocation-command__bar" }, [
                h("code", command.command),
                command.exitCode !== undefined
                  ? h("span", { "data-failed": command.exitCode !== 0 }, `exit ${command.exitCode}`)
                  : null,
              ]),
              command.cwd ? h("div", { class: "vh-invocation-command__cwd" }, command.cwd) : null,
              command.output ? h("pre", terminalText(command.output)) : null,
              renderEventPayload("Error", activity.attributes["tool.error"]),
            ])
          : hasPayloads
            ? h("div", { class: "vh-invocation-event__payloads" }, [
                renderEventPayload("Input", activity.attributes["tool.input"]),
                renderEventPayload("Output", activity.attributes["tool.output"]),
                renderEventPayload("Error", activity.attributes["tool.error"]),
              ].filter(Boolean))
          : activity.body
            ? h("div", { class: "vh-invocation-event__body" }, [markdown(activity.body, "vh-invocation-event__markdown")])
            : null,
        inspectable
          ? h("button", {
              class: "vh-invocation-event__inspect",
              onClick: () => inspect(inspectTarget),
              type: "button",
            }, `Inspect ${inspectTarget}`)
          : null,
      ]) : null,
    ]),
  ]);
}

function renderEventPayload(label: string, value: unknown) {
  if (value === undefined) return null;
  const text = Object.prototype.toString.call(value) === "[object String]" ? String(value) : JSON.stringify(value, null, 2);
  return h("section", { class: "vh-invocation-event__payload" }, [
    h("strong", label),
    h("pre", text),
  ]);
}

function activityDetail(activity: InvocationActivity): string | undefined {
  return activity.preview ?? stringAttribute(activity.attributes, "vitehub.activity.detail");
}

function githubUrl(invocation: AgentInvocationView): string | undefined {
  const value = stringAttribute(invocation.annotations ?? {}, "github.url");
  return value && isSafeExternalUrl(value) ? value : undefined;
}

function renderPreparationAction(activity: InvocationActivity, inspect: (target: InspectTarget) => void) {
  const target = activity.attributes["vitehub.inspect.target"];
  if (target !== "workspace" && target !== "agent") return;
  return h("button", {
    "aria-label": target === "workspace" ? "Open Workspace" : "Open Invocation details",
    class: "vh-invocation-preparation__action",
    onClick: () => inspect(target),
    type: "button",
  }, [renderNamedActivityIcon(target === "workspace" ? "folder" : "bot")]);
}

function renderPreparationContext(invocation: AgentInvocationView, url: string | undefined) {
  const repository = invocation.annotations?.["github.repository"];
  const pullRequest = invocation.annotations?.["github.pullRequest"];
  if (typeof repository !== "string" || (typeof pullRequest !== "number" && typeof pullRequest !== "string")) {
    return h("code", invocationContext(invocation));
  }
  return h("span", { class: "vh-invocation-preparation__context" }, [
    h("code", repository),
    h("span", { "aria-hidden": "true" }, "·"),
    url
      ? h("a", {
          href: url,
          onClick: (event: MouseEvent) => event.stopPropagation(),
          rel: "noreferrer",
          target: "_blank",
        }, `PR #${pullRequest}`)
      : h("code", `PR #${pullRequest}`),
  ]);
}

function renderPreparationDetail(activity: InvocationActivity, url: string | undefined) {
  const detail = activityDetail(activity);
  if (!detail) return;
  const compact = compactCommand(detail);
  if (!url || !invocationActivityTitle(activity).toLocaleLowerCase().includes("pull request")) {
    return h("code", compact);
  }
  const match = compact.match(/^(.*?)\s*·\s*(PR #\d+)$/);
  if (!match) return h("code", compact);
  return h("span", { class: "vh-invocation-preparation__context" }, [
    h("code", match[1]),
    h("span", { "aria-hidden": "true" }, "·"),
    h("a", { href: url, rel: "noreferrer", target: "_blank" }, match[2]),
  ]);
}

function renderChevronDown(className: string) {
  return h("svg", { "aria-hidden": "true", class: className, fill: "none", viewBox: "0 0 24 24" }, [
    h("path", { d: "m6 9 6 6 6-6", "stroke-linecap": "round", "stroke-linejoin": "round" }),
  ]);
}

function renderPreparationGroup(
  activities: readonly InvocationActivity[],
  invocation: AgentInvocationView,
  inspect: (target: InspectTarget) => void,
) {
  const url = githubUrl(invocation);
  const failed = activities.some(activity => activity.status === "failed");
  return h("li", {
    class: "vh-invocation-preparation",
    key: `preparation:${activities[0]?.id}`,
  }, [
    h("details", { class: "vh-invocation-preparation__details" }, [
      h("summary", { class: "vh-invocation-preparation__summary" }, [
        renderNamedActivityIcon(failed ? "error" : "check"),
        h("strong", failed ? "Session preparation failed" : "Session prepared"),
        renderPreparationContext(invocation, url),
        h("small", `${activities.length} steps`),
        renderChevronDown("vh-invocation-preparation__disclosure"),
      ]),
      h("ol", { class: "vh-invocation-preparation__steps" }, activities.map(activity => h("li", {
        "data-activity-id": activity.id,
        "data-kind": "preparation",
        key: activity.id,
      }, [
        renderActivityIcon(activity),
        h("strong", invocationActivityTitle(activity)),
        renderPreparationDetail(activity, url),
        renderPreparationAction(activity, inspect),
        activity.body
          ? h("p", { class: "vh-invocation-preparation__body" }, activity.body)
          : null,
        activity.truncated
          ? h("p", { class: "vh-invocation-event__notice" }, "Some trace content was truncated by the invocation journal.")
          : null,
      ]))),
    ]),
  ]);
}

function activityGroup(activity: InvocationActivity | undefined): string | undefined {
  return activity ? stringAttribute(activity.attributes, "vitehub.activity.group") : undefined;
}

function labelStyle(color: string | undefined): Record<string, string> {
  const normalized = color?.replace(/^#/, "");
  if (!normalized || !/^[\da-f]{6}$/i.test(normalized)) return {};
  const red = Number.parseInt(normalized.slice(0, 2), 16);
  const green = Number.parseInt(normalized.slice(2, 4), 16);
  const blue = Number.parseInt(normalized.slice(4, 6), 16);
  const luminance = (red * 299 + green * 587 + blue * 114) / 1_000;
  return {
    "--vh-invocation-label-bg": `#${normalized}`,
    "--vh-invocation-label-fg": luminance > 150 ? "#1f2328" : "#ffffff",
  };
}

function renderLabelChip(activity: InvocationActivity) {
  const name = stringAttribute(activity.attributes, "github.label.name");
  if (!name) return;
  return h("span", {
    class: "vh-invocation-lifecycle__label",
    "data-operation": stringAttribute(activity.attributes, "github.label.operation"),
    style: labelStyle(stringAttribute(activity.attributes, "github.label.color")),
  }, name);
}

function groupedActivityTitle(activity: InvocationActivity): string {
  if (!stringAttribute(activity.attributes, "github.label.name")) return invocationActivityTitle(activity);
  const operation = stringAttribute(activity.attributes, "github.label.operation")?.toLocaleLowerCase();
  if (activity.status === "failed") {
    if (operation === "add" || operation === "added") return "Failed to add label";
    if (operation === "remove" || operation === "removed") return "Failed to remove label";
    return "Failed to update label";
  }
  if (operation === "add" || operation === "added") return "Added label";
  if (operation === "remove" || operation === "removed") return "Removed label";
  return "Updated label";
}

function renderGroupedActivityIcon(activity: InvocationActivity) {
  if (activity.status === "failed") return renderActivityIcon(activity);
  if (stringAttribute(activity.attributes, "github.label.name")) return renderNamedActivityIcon("label");
  const delivery = stringAttribute(activity.attributes, "channel.effect.kind")?.toLocaleLowerCase();
  if (delivery === "reaction") {
    const intent = stringAttribute(activity.attributes, "channel.effect.intent")?.toLocaleLowerCase();
    const reaction = intent === "completed"
      ? { label: "hooray", value: "🎉" }
      : intent === "failed"
        ? { label: "confused", value: "😕" }
        : { label: "eyes", value: "👀" };
    return h("span", { "aria-label": reaction.label, class: "vh-invocation-lifecycle__emoji", role: "img" }, reaction.value);
  }
  if (["reply", "status", "update"].includes(delivery ?? "")) return renderNamedActivityIcon("message");
  return renderActivityIcon(activity);
}

function renderActivityGroup(
  group: string,
  activities: readonly InvocationActivity[],
  inspect: (target: InspectTarget) => void,
) {
  return h("li", {
    class: "vh-invocation-lifecycle",
    "data-activity-group": group,
    key: `activity-group:${group}:${activities[0]?.id}`,
  }, [
    h("ol", { "aria-label": group, class: "vh-invocation-lifecycle__rows" }, activities.map(activity => {
      const target = activity.attributes["vitehub.inspect.target"];
      const inspectable = target === "agent" || target === "workspace";
      const rowContent = [
        renderGroupedActivityIcon(activity),
        h("span", { class: "vh-invocation-lifecycle__title" }, groupedActivityTitle(activity)),
        renderLabelChip(activity),
        !stringAttribute(activity.attributes, "github.label.name") && channelDeliverySummary(activity)
          ? h("code", { class: "vh-invocation-lifecycle__detail" }, channelDeliverySummary(activity))
          : null,
        activity.status === "failed" && activity.body
          ? h("span", { class: "vh-invocation-lifecycle__failure" }, activity.body)
          : null,
        activity.truncated
          ? h("span", { class: "vh-invocation-event__notice" }, "Some trace content was truncated by the invocation journal.")
          : null,
      ];
      return h("li", {
        "data-activity-id": activity.id,
        "data-kind": activity.kind,
        "data-status": activity.status,
        key: activity.id,
      }, [
        inspectable
          ? h("button", { class: "vh-invocation-lifecycle__row", onClick: () => inspect(target), type: "button" }, rowContent)
          : h("div", { class: "vh-invocation-lifecycle__row" }, rowContent),
      ]);
    })),
  ]);
}

function inspectorSection(title: string, body: ReturnType<typeof h>) {
  return h("section", [h("h4", title), body]);
}

function timelineOwner(activity: InvocationActivity): "agent" | "vitehub" {
  const tool = String(activity.attributes["tool.name"] ?? "").toLocaleLowerCase();
  if (
    activity.kind === "preparation"
    || activity.kind === "action"
    || activity.kind === "system"
    || activity.kind === "delivery"
    || activity.name.startsWith("vitehub.")
    || tool === "materialize_sources"
    || tool.startsWith("vitehub_")
  ) return "vitehub";
  return "agent";
}

function traceTimeline(activities: readonly InvocationActivity[], invocation: AgentInvocationView) {
  const items = activities.filter(activity => activity.kind !== "message" && Number.isFinite(Date.parse(activity.startedAt ?? "")));
  if (!items.length) return null;
  const invocationStart = Date.parse(invocation.startedAt ?? invocation.createdAt ?? "");
  const observedStarts = items
    .map(activity => Date.parse(activity.startedAt ?? ""))
    .filter(Number.isFinite);
  const zero = Number.isFinite(invocationStart) ? invocationStart : Math.min(...observedStarts);
  const invocationEnd = Date.parse(
    invocation.completedAt ?? invocation.failedAt ?? invocation.cancelledAt ?? invocation.updatedAt ?? "",
  );
  const observedEnds = items
    .map(activity => Date.parse(activity.endedAt ?? activity.startedAt ?? ""))
    .filter(Number.isFinite);
  const end = Number.isFinite(invocationEnd) ? invocationEnd : Math.max(...observedEnds, zero + 1);
  const span = Math.max(1, end - zero);
  return inspectorSection("Trace timeline", h("div", { class: "vh-invocation-timeline" }, [
    h("div", { class: "vh-invocation-timeline__legend", "aria-hidden": "true" }, [
      h("span", { "data-owner": "agent" }, "Agent"),
      h("span", { "data-owner": "vitehub" }, "ViteHub"),
    ]),
    h("ol", items.map((activity) => {
      const started = Date.parse(activity.startedAt ?? "");
      const duration = Number.isFinite(activity.durationMs) ? (activity.durationMs ?? 0) : 0;
      const offset = Number.isFinite(started) ? Math.max(0, started - zero) : 0;
      const owner = timelineOwner(activity);
      const timing = [
        offset ? `+${formatTimelineDuration(offset)}` : "start",
        duration ? formatTimelineDuration(duration) : undefined,
      ].filter(Boolean).join(" · ");
      const title = invocationActivityTitle(activity);
      const detail = activityDetail(activity);
      const width = Math.max(1.5, Math.min(100, (duration / span) * 100));
      const left = Math.min(100 - width, Math.max(0, (offset / span) * 100));
      return h("li", {
        class: "vh-invocation-timeline__row",
        "data-owner": owner,
        key: `timeline:${activity.id}`,
        tabindex: "0",
        title: detail ? `${title} — ${detail}` : title,
      }, [
        h("div", { class: "vh-invocation-timeline__heading" }, [
          h("strong", title),
          h("time", timing),
        ]),
        detail ? h("code", { class: "vh-invocation-timeline__detail" }, detail) : null,
        h("div", { class: "vh-invocation-timeline__track", "aria-hidden": "true" }, [
          h("span", { style: {
            left: `${left}%`,
            width: `${width}%`,
          } }),
        ]),
      ]);
    })),
  ]));
}

function inspectorRow(label: string, value: string | number | undefined) {
  if (value === undefined || value === "") return null;
  return h("div", [h("dt", label), h("dd", String(value))]);
}

function copyIcon(copied: boolean) {
  return h(
    "svg",
    { "aria-hidden": "true", fill: "none", viewBox: "0 0 24 24" },
    copied
      ? [h("path", { d: "m5 12 4 4L19 6", "stroke-linecap": "round", "stroke-linejoin": "round" })]
      : [
          h("rect", { height: "13", rx: "2", width: "13", x: "8", y: "8" }),
          h("path", {
            d: "M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3",
            "stroke-linecap": "round",
            "stroke-linejoin": "round",
          }),
        ],
  );
}

function statusIcon(status: AgentInvocationView["status"]) {
  const paths: Record<AgentInvocationView["status"], readonly string[]> = {
    cancelled: ["M18 6 6 18", "M12 22a10 10 0 1 1 0-20 10 10 0 0 1 0 20"],
    completed: ["m5 12 4 4L19 6"],
    failed: ["M18 6 6 18", "m6 6 12 12"],
    pending: ["M12 8v4l3 2", "M12 22a10 10 0 1 1 0-20 10 10 0 0 1 0 20"],
    running: ["M21 12a9 9 0 1 1-6.219-8.56"],
  };
  return h(
    "svg",
    { "aria-hidden": "true", fill: "none", viewBox: "0 0 24 24" },
    paths[status].map((path) =>
      h("path", {
        d: path,
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
      }),
    ),
  );
}

function inspectorCollection(title: string, items: readonly string[]) {
  return h("div", { class: "vh-invocation-inspector__group" }, [
    h("div", { class: "vh-invocation-inspector__group-heading" }, [
      h("strong", title),
      h("small", items.length),
    ]),
    h(
      "ul",
      { class: "vh-invocation-inspector__items" },
      items.map((item) => h("li", { key: item }, [h("code", item)])),
    ),
  ]);
}

function inspectorDisclosure(
  title: string,
  summary: string,
  body: ReturnType<typeof h>,
) {
  return h(
    "details",
    { class: "vh-invocation-inspector__group vh-invocation-inspector__disclosure" },
    [
      h("summary", { class: "vh-invocation-inspector__group-heading" }, [
        h("strong", title),
        h("small", summary),
        renderChevronDown("vh-invocation-inspector__chevron"),
      ]),
      body,
    ],
  );
}

function renderConfiguration(configuration: AgentInvocationConfiguration) {
  const driver = driverLabel(configuration);
  const workspace = workspaceLabel(configuration);
  const setup = [
    inspectorRow("Driver", driver),
    inspectorRow("Runtime", configuration.runtime?.name),
    inspectorRow("Workspace", workspace),
  ].filter((item) => item !== null);
  const groups = [
    setup.length
      ? h("div", { class: "vh-invocation-inspector__group" }, [
          h("div", { class: "vh-invocation-inspector__group-heading" }, [
            h("strong", "Execution"),
          ]),
          h("dl", { class: "vh-invocation-inspector__list" }, setup),
        ])
      : null,
    configuration.workspace?.sources?.length
      ? inspectorCollection("Sources", configuration.workspace.sources)
      : null,
    configuration.capabilities?.length
      ? h("div", { class: "vh-invocation-inspector__group" }, [
          h("div", { class: "vh-invocation-inspector__group-heading" }, [
            h("strong", "Capabilities"),
            h("small", configuration.capabilities.length),
          ]),
          h(
            "div",
            { class: "vh-invocation-inspector__stack" },
            configuration.capabilities.map((capability) =>
              capability.metadata
                ? h(
                    "details",
                    { class: "vh-invocation-inspector__item-disclosure", key: capability.id },
                    [
                      h("summary", [
                        h("code", capability.id),
                        h("small", "Metadata"),
                        renderChevronDown("vh-invocation-inspector__chevron"),
                      ]),
                      h("pre", JSON.stringify(capability.metadata, null, 2)),
                    ],
                  )
                : h("div", { class: "vh-invocation-inspector__item", key: capability.id }, [
                    h("code", capability.id),
                  ]),
            ),
          ),
        ])
      : null,
    configuration.tools?.length
      ? inspectorCollection(
          "Tools",
          configuration.tools.map((tool) => tool.name),
        )
      : null,
    configuration.instructions?.length
      ? inspectorDisclosure(
          "Instructions",
          `${configuration.instructions.length} block${configuration.instructions.length === 1 ? "" : "s"}`,
          h(
            "pre",
            { class: "vh-invocation-inspector__instructions" },
            configuration.instructions.join("\n\n"),
          ),
        )
      : null,
  ].filter((item) => item !== null);
  return [
    configuration.truncated
      ? h("div", { class: "vh-invocation-inspector__notice", role: "note" }, [
          h("strong", "Configuration truncated"),
          h("p", "Some values were shortened by the invocation journal."),
        ])
      : null,
    groups.length
      ? inspectorSection(
          "Captured setup",
          h("div", { class: "vh-invocation-inspector__groups" }, groups),
        )
      : null,
  ];
}

function renderInvocationActivity(
  activity: InvocationActivity,
  expanded: ReadonlySet<string>,
  toggleExpanded: (id: string) => void,
  inspect: (target: InspectTarget) => void,
) {
  return activity.kind === "message"
    ? renderMessage(activity, expanded, toggleExpanded)
    : renderEvent(activity, inspect);
}

function renderActivitySequence(
  activities: readonly InvocationActivity[],
  invocation: AgentInvocationView,
  expanded: ReadonlySet<string>,
  toggleExpanded: (id: string) => void,
  inspect: (target: InspectTarget) => void,
) {
  const rendered = [];
  for (let index = 0; index < activities.length;) {
    const group = activityGroup(activities[index]!);
    if (group) {
      let end = index + 1;
      while (activityGroup(activities[end]) === group) end += 1;
      rendered.push(renderActivityGroup(group, activities.slice(index, end), inspect));
      index = end;
      continue;
    }
    if (activities[index]!.kind !== "preparation") {
      rendered.push(renderInvocationActivity(activities[index]!, expanded, toggleExpanded, inspect));
      index += 1;
      continue;
    }
    let end = index + 1;
    while (activities[end]?.kind === "preparation") end += 1;
    rendered.push(renderPreparationGroup(activities.slice(index, end), invocation, inspect));
    index = end;
  }
  return rendered;
}

function isExternalActivity(activity: InvocationActivity): boolean {
  return activity.kind === "preparation"
    || activity.kind === "delivery"
    || activity.kind === "action"
    || activity.kind === "system";
}

function renderWorkSummary(
  activities: readonly InvocationActivity[],
  invocation: AgentInvocationView,
  expanded: ReadonlySet<string>,
  toggleExpanded: (id: string) => void,
  inspect: (target: InspectTarget) => void,
) {
  if (!activities.length) return null;
  const endedAt = invocation.completedAt ?? invocation.failedAt ?? invocation.cancelledAt ?? invocation.updatedAt;
  const duration = formatDuration(invocation.startedAt, endedAt);
  return h("li", { class: "vh-invocation-work", key: "invocation-work" }, [
    h("details", { class: "vh-invocation-work__details" }, [
      h("summary", { class: "vh-invocation-work__summary" }, [
        h("span", { class: "vh-invocation-work__title" }, duration ? `Worked for ${duration}` : "Work details"),
        renderChevronDown("vh-invocation-work__disclosure"),
      ]),
      h("div", { "aria-hidden": "true", class: "vh-invocation-work__divider" }),
      h("ol", { class: "vh-invocation-work__activities" }, renderActivitySequence(activities, invocation, expanded, toggleExpanded, inspect)),
    ]),
  ]);
}

function renderInvocationActivities(
  activities: readonly InvocationActivity[],
  invocation: AgentInvocationView,
  expanded: ReadonlySet<string>,
  toggleExpanded: (id: string) => void,
  inspect: (target: InspectTarget) => void,
) {
  if (invocation.status === "pending" || invocation.status === "running") {
    return renderActivitySequence(activities, invocation, expanded, toggleExpanded, inspect);
  }
  const firstUser = activities.findIndex(activity => activity.kind === "message" && activity.role === "user");
  let lastUser = -1;
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    if (activities[index]!.kind === "message" && activities[index]!.role === "user") {
      lastUser = index;
      break;
    }
  }
  let lastAssistant = -1;
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    if (index > lastUser && activities[index]!.kind === "message" && activities[index]!.role === "assistant") {
      lastAssistant = index;
      break;
    }
  }
  if (firstUser < 0) return renderActivitySequence(activities, invocation, expanded, toggleExpanded, inspect);

  const prefix = activities.slice(0, firstUser + 1);
  const tail = activities.slice(firstUser + 1);
  const terminal = tail.filter(activity => activity.name === "vitehub.observation.truncated");
  const externalBeforeFinal = tail.filter((activity, offset) =>
    activity.name !== "vitehub.observation.truncated"
    && isExternalActivity(activity)
    && (lastAssistant < 0 || firstUser + 1 + offset < lastAssistant),
  );
  const externalAfterFinal = tail.filter((activity, offset) =>
    activity.name !== "vitehub.observation.truncated"
    && isExternalActivity(activity)
    && lastAssistant >= 0
    && firstUser + 1 + offset > lastAssistant,
  );
  const work = tail.filter((activity, offset) => {
    const index = firstUser + 1 + offset;
    return index !== lastAssistant && !isExternalActivity(activity);
  });

  return [
    ...renderActivitySequence(prefix, invocation, expanded, toggleExpanded, inspect),
    ...renderActivitySequence(externalBeforeFinal, invocation, expanded, toggleExpanded, inspect),
    renderWorkSummary(work, invocation, expanded, toggleExpanded, inspect),
    ...(lastAssistant >= 0 ? [renderInvocationActivity(activities[lastAssistant]!, expanded, toggleExpanded, inspect)] : []),
    ...renderActivitySequence(externalAfterFinal, invocation, expanded, toggleExpanded, inspect),
    ...renderActivitySequence(terminal, invocation, expanded, toggleExpanded, inspect),
  ].filter(item => item !== null);
}

export const AgentInvocation = defineComponent({
  name: "AgentInvocation",
  emits: {
    inspect: (target: InspectTarget) => target === "agent" || target === "workspace",
  },
  props: {
    header: { default: true, type: Boolean },
    invocation: { required: true, type: Object as PropType<AgentInvocationView> },
  },
  setup(props, { emit, slots }) {
    const activities = computed(() => invocationActivities(props.invocation));
    const expandedMessages = ref<ReadonlySet<string>>(new Set());

    function toggleExpanded(id: string) {
      const next = new Set(expandedMessages.value);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      expandedMessages.value = next;
    }

    return () => {
      return h("article", {
        class: ["vh-invocation-session", { "vh-invocation-session--headerless": !props.header }],
        "data-status": props.invocation.status,
        "data-slot": "invocation",
      }, [
        props.header ? h("header", { class: "vh-invocation-header" }, [
          h("div", { class: "vh-invocation-header__breadcrumb", title: `${invocationProject(props.invocation)} / ${invocationTitle(props.invocation)}` }, [
            h("span", { class: "vh-invocation-header__project-icon" }, [renderFolderIcon()]),
            h("span", { class: "vh-invocation-header__project" }, invocationProject(props.invocation)),
            h("span", { "aria-hidden": "true", class: "vh-invocation-header__separator" }, "/"),
            h("h2", slots.title?.({ invocation: props.invocation }) ?? invocationTitle(props.invocation)),
          ]),
          slots.actions?.({ invocation: props.invocation }),
        ]) : null,
        h("div", { class: "vh-invocation-thread" }, [
          h("div", { class: "vh-invocation-thread__content" }, [
            props.invocation.error
              ? h("div", { class: "vh-invocation-session__error", role: "alert" }, [
                  h("strong", props.invocation.error.name ?? "Invocation failed"),
                  h("span", props.invocation.error.message),
                ])
              : null,
            h("div", {
              "aria-label": "Session thread",
              "aria-relevant": "additions text",
              role: "log",
            }, [h("ol", { class: "vh-invocation-activities" }, renderInvocationActivities(
              activities.value,
              props.invocation,
              expandedMessages.value,
              toggleExpanded,
              target => emit("inspect", target),
            ))]),
            activities.value.length
              ? null
              : h("div", { class: "vh-invocation-empty", role: "status" }, [h("span", { "aria-hidden": "true" }, "○"), h("p", "Waiting for the first update…")]),
            slots.footer?.({ invocation: props.invocation }),
          ]),
        ]),
      ]);
    };
  },
});

export const AgentInvocationInspector = defineComponent({
  name: "AgentInvocationInspector",
  props: {
    invocation: { required: true, type: Object as PropType<AgentInvocationView> },
  },
  setup(props, { slots }) {
    const activities = computed(() => invocationActivities(props.invocation));
    const copied = ref<"invocation" | "trace">();
    const copyError = ref<"invocation" | "trace">();
    let copyTimer: ReturnType<typeof setTimeout> | undefined;
    const metrics = computed(() => ({
      changes: activities.value.filter((activity) => activity.kind === "change").length,
      messages: activities.value.filter((activity) => activity.kind === "message").length,
      steps: activities.value.filter((activity) =>
        activity.kind !== "message" && activity.name !== "vitehub.observation.truncated"
      ).length,
      tokens: latestInvocationTokens(activities.value),
    }));

    async function copyIdentifier(kind: "invocation" | "trace", value: string | undefined) {
      if (!value) return;
      copyError.value = undefined;
      await nextTick();
      if (!("navigator" in globalThis) || !navigator.clipboard) {
        copied.value = undefined;
        copyError.value = kind;
        return;
      }
      try {
        await navigator.clipboard.writeText(value);
        copied.value = kind;
        copyError.value = undefined;
        if (copyTimer) clearTimeout(copyTimer);
        copyTimer = setTimeout(() => { copied.value = undefined; }, 1_600);
      } catch {
        copied.value = undefined;
        copyError.value = kind;
      }
    }

    function copyAction(kind: "invocation" | "trace", label: string, value: string | undefined) {
      if (!value) return null;
      const didCopy = copied.value === kind;
      return h(
        "button",
        {
          "aria-label": didCopy ? `${label} copied` : `Copy ${label}`,
          class: "vh-invocation-inspector__copy",
          onClick: () => void copyIdentifier(kind, value),
          type: "button",
        },
        [
          h("span", { class: "vh-invocation-inspector__copy-label" }, label),
          h(
            "span",
            { class: "vh-invocation-inspector__copy-state" },
            didCopy ? "Copied" : "Copy",
          ),
          h("span", { class: "vh-invocation-inspector__copy-icon" }, [copyIcon(didCopy)]),
        ],
      );
    }

    onBeforeUnmount(() => {
      if (copyTimer) clearTimeout(copyTimer);
    });

    return () => {
      const configuration = props.invocation.configuration;
      const agentName = configuration?.agent?.name ?? props.invocation.agentName;
      const endedAt =
        props.invocation.completedAt ?? props.invocation.failedAt ?? props.invocation.cancelledAt;
      const duration =
        formatDuration(props.invocation.startedAt, endedAt) ??
        (props.invocation.status === "pending"
          ? "Waiting to start"
          : props.invocation.status === "running"
            ? "In progress"
            : "Duration unavailable");
      return h(
        "aside",
        {
          "aria-label": "Session details",
          class: "vh-invocation-inspector",
          "data-status": props.invocation.status,
          "data-slot": "invocation-inspector",
        },
        [
          h("header", [
            h("div", [h("p", invocationProject(props.invocation)), h("h3", "Invocation details")]),
            slots.actions?.({ invocation: props.invocation }),
          ]),
          h("div", { class: "vh-invocation-inspector__content" }, [
            h("span", {
              class: "vh-visually-hidden",
              role: "status",
            }, copied.value
              ? `${copied.value === "trace" ? "Trace" : "Invocation"} ID copied`
              : copyError.value
                ? `${copyError.value === "trace" ? "Trace" : "Invocation"} ID could not be copied`
                : ""),
            h("section", { class: "vh-invocation-inspector__identity" }, [
              h(
                "div",
                {
                  "aria-atomic": "true",
                  "aria-live": "polite",
                  class: "vh-invocation-inspector__status",
                  role: "status",
                },
                [
                  h("span", { class: "vh-invocation-inspector__status-icon" }, [
                    statusIcon(props.invocation.status),
                  ]),
                  h("strong", statusLabel(props.invocation.status)),
                  h("small", duration),
                ],
              ),
              h("h4", invocationTitle(props.invocation)),
              invocationContext(props.invocation) !== props.invocation.id
                ? h("p", invocationContext(props.invocation))
                : null,
              agentName
                ? h("div", { class: "vh-invocation-inspector__agent" }, [
                    h("span", "Agent"),
                    h("code", agentName),
                  ])
                : null,
              props.invocation.error
                ? h("div", { class: "vh-invocation-inspector__error" }, [
                    h("strong", props.invocation.error.name ?? "Invocation failed"),
                    h("p", props.invocation.error.message),
                  ])
                : null,
            ]),
            inspectorSection(
              "Run summary",
              h("dl", { class: "vh-invocation-inspector__metrics" }, [
                h("div", [h("dt", "Messages"), h("dd", metrics.value.messages)]),
                h("div", [h("dt", "Steps"), h("dd", metrics.value.steps)]),
                metrics.value.changes
                  ? h("div", [h("dt", "Changes"), h("dd", metrics.value.changes)])
                  : null,
                metrics.value.tokens !== undefined
                  ? h("div", [
                      h("dt", "Tokens"),
                      h("dd", new Intl.NumberFormat("en").format(metrics.value.tokens)),
                    ])
                  : null,
              ]),
            ),
            traceTimeline(activities.value, props.invocation),
            ...(configuration ? renderConfiguration(configuration) : []),
            slots.metadata?.({ invocation: props.invocation }),
            inspectorSection(
              "Identifiers",
              h("div", { class: "vh-invocation-inspector__copy-list" }, [
                copyAction("trace", "Trace ID", props.invocation.traceId),
                copyAction("invocation", "Invocation ID", props.invocation.id),
              ]),
            ),
          ]),
        ],
      );
    };
  },
});
