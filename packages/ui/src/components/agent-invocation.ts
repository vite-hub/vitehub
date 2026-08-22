import { computed, defineComponent, h, type PropType, Suspense } from "vue";
import type { AgentInvocationConfiguration, AgentInvocationView } from "../types.ts";
import {
  invocationActivities,
  invocationActivityTitle,
  latestInvocationTokens,
  terminalText,
  type InvocationActivity,
} from "../internal/invocation-activity.ts";
import { AgentDiff } from "./agent-diff.ts";
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
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1, notation: "compact" }).format(value)} tokens`;
}

function formatDuration(startedAt: string | undefined, completedAt: string | undefined): string | undefined {
  if (!startedAt || !completedAt) return;
  const duration = Date.parse(completedAt) - Date.parse(startedAt);
  if (!Number.isFinite(duration) || duration < 0) return;
  if (duration < 60_000) return `${Math.round(duration / 1_000)}s`;
  return `${Math.floor(duration / 60_000)}m ${Math.round((duration % 60_000) / 1_000)}s`;
}

function configurationLabel(configuration: AgentInvocationConfiguration): string | undefined {
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

function renderMessage(activity: InvocationActivity) {
  return h(
    "li",
    {
      class: "vh-invocation-message",
      "data-role": activity.role,
      key: activity.id,
    },
    [markdown(activity.body, "vh-invocation-message__body")],
  );
}

type ActivityIcon = "action" | "approval" | "bot" | "change" | "command" | "error" | "eye" | "search" | "tool";

function activityIcon(activity: InvocationActivity): ActivityIcon {
  if (activity.status === "failed" || activity.kind === "error") return "error";
  const name = String(activity.attributes["tool.name"] ?? "").toLocaleLowerCase();
  if (activity.command) return "command";
  if (activity.kind === "change") return "change";
  if (name.includes("read") || name.includes("image") || name.includes("view")) return "eye";
  if (name.includes("search") || name.includes("find")) return "search";
  if (activity.kind === "reasoning" || activity.kind === "model") return "bot";
  if (activity.kind === "approval") return "approval";
  if (activity.kind === "action") return "action";
  return "tool";
}

const activityIconPaths: Record<ActivityIcon, readonly string[]> = {
  action: ["M13 2 3 14h9l-1 8 10-12h-9z"],
  approval: ["M12 3v12", "m8 11 4 4 4-4", "M5 21h14"],
  bot: ["M12 8V4H8", "M4 8h16v10H4z", "M8 12h.01", "M16 12h.01"],
  change: ["M12 20h9", "M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"],
  command: ["m4 17 6-6-6-6", "M12 19h8"],
  error: ["M18 6 6 18", "m6 6 12 12"],
  eye: ["M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12", "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6"],
  search: ["m21 21-4.35-4.35", "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16"],
  tool: ["M14.7 6.3a4 4 0 0 0-5-5l2.1 2.1-2.4 2.4-2.1-2.1a4 4 0 0 0 5 5L3 18l3 3 9.3-9.3a4 4 0 0 0 5-5l-2.1 2.1-2.4-2.4z"],
};

function renderActivityIcon(activity: InvocationActivity) {
  const icon = activityIcon(activity);
  return h("span", { class: "vh-invocation-event__icon", "data-icon": icon, "aria-hidden": "true" }, [
    h("svg", { fill: "none", viewBox: "0 0 24 24" }, activityIconPaths[icon].map(path => h("path", {
      d: path,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    }))),
  ]);
}

function renderEvent(activity: InvocationActivity) {
  const command = activity.command;
  const tokenLabel = activity.kind === "reasoning" || activity.kind === "model"
    ? formatTokens(activity.reasoningTokens)
    : undefined;
  const suffix = activity.preview ? compactCommand(activity.preview) : tokenLabel;
  const hasDetails = activity.patches.length > 0 || Boolean(command || activity.body);
  const summary = h(hasDetails ? "summary" : "div", { class: "vh-invocation-event__summary" }, [
    renderActivityIcon(activity),
    h("span", { class: "vh-invocation-event__title" }, invocationActivityTitle(activity)),
    suffix ? h("code", { class: "vh-invocation-event__suffix" }, suffix) : null,
    hasDetails
      ? h("span", { class: "vh-invocation-event__disclosure", "aria-hidden": "true" }, "⌄")
      : null,
  ]);
  return h("li", {
    class: "vh-invocation-activity",
    "data-kind": activity.kind,
    "data-status": activity.status,
    key: activity.id,
  }, [
    h(hasDetails ? "details" : "div", {
      class: "vh-invocation-event",
    }, [
      summary,
      activity.patches.length
        ? h("div", { class: "vh-invocation-event__diffs" }, activity.patches.map((patch, index) => h(AgentDiff, { key: index, patch })))
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
            ])
          : activity.body
            ? h("div", { class: "vh-invocation-event__body" }, [markdown(activity.body, "vh-invocation-event__markdown")])
            : null,
    ]),
  ]);
}

function inspectorSection(title: string, body: ReturnType<typeof h> | null) {
  return body ? h("section", [h("h4", title), body]) : null;
}

function renderConfiguration(configuration: AgentInvocationConfiguration) {
  const driver = configurationLabel(configuration);
  const workspace = workspaceLabel(configuration);
  return [
    inspectorSection("Environment", h("dl", { class: "vh-invocation-inspector__list" }, [
      driver ? h("div", [h("dt", "Driver"), h("dd", driver)]) : null,
      configuration.runtime?.name ? h("div", [h("dt", "Runtime"), h("dd", configuration.runtime.name)]) : null,
      workspace ? h("div", [h("dt", "Workspace"), h("dd", workspace)]) : null,
    ])),
    configuration.workspace?.sources?.length
      ? inspectorSection("Sources", h("div", { class: "vh-invocation-inspector__badges" }, configuration.workspace.sources.map(source => h("code", source))))
      : null,
    configuration.capabilities?.length
      ? inspectorSection("Capabilities", h("div", { class: "vh-invocation-inspector__stack" }, configuration.capabilities.map(capability => h("details", [
          h("summary", capability.id),
          capability.metadata ? h("pre", JSON.stringify(capability.metadata, null, 2)) : null,
        ]))))
      : null,
    configuration.tools?.length
      ? inspectorSection("Tools", h("div", { class: "vh-invocation-inspector__badges" }, configuration.tools.map(tool => h("code", tool.name))))
      : null,
    configuration.instructions?.length
      ? inspectorSection("Instructions", h("pre", { class: "vh-invocation-inspector__instructions" }, configuration.instructions.join("\n\n")))
      : null,
  ];
}

export const AgentInvocation = defineComponent({
  name: "AgentInvocation",
  props: {
    invocation: { required: true, type: Object as PropType<AgentInvocationView> },
  },
  setup(props, { slots }) {
    const activities = computed(() => invocationActivities(props.invocation));

    return () => {
      return h("article", {
        class: "vh-invocation-session",
        "data-status": props.invocation.status,
        "data-slot": "invocation",
      }, [
        h("main", { class: "vh-invocation-thread" }, [
          h("div", { class: "vh-invocation-thread__content" }, [
            h("header", { class: "vh-invocation-thread__heading" }, [
              h("div", { class: "vh-invocation-thread__eyebrow" }, [
                h("span", { class: "vh-invocation-session__status-dot", "aria-hidden": "true" }),
                h("span", statusLabel(props.invocation.status)),
              ]),
              h("div", { class: "vh-invocation-thread__title-row" }, [
                h("div", [
                  h("h2", slots.title?.({ invocation: props.invocation }) ?? invocationTitle(props.invocation)),
                  h("p", invocationContext(props.invocation)),
                ]),
                slots.actions?.({ invocation: props.invocation }),
              ]),
            ]),
            props.invocation.error
              ? h("div", { class: "vh-invocation-session__error", role: "alert" }, [
                  h("strong", props.invocation.error.name ?? "Invocation failed"),
                  h("span", props.invocation.error.message),
                ])
              : null,
            activities.value.length
              ? h("ol", { "aria-label": "Session thread", class: "vh-invocation-activities" }, activities.value.map(activity => activity.kind === "message" ? renderMessage(activity) : renderEvent(activity)))
              : h("div", { class: "vh-invocation-empty" }, [h("span", { "aria-hidden": "true" }, "○"), h("p", "Waiting for the first update…")]),
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
    const metrics = computed(() => ({
      changes: activities.value.filter(activity => activity.kind === "change").length,
      messages: activities.value.filter(activity => activity.kind === "message").length,
      steps: activities.value.filter(activity => activity.kind !== "message").length,
      tokens: latestInvocationTokens(activities.value),
    }));

    return () => {
      const configuration = props.invocation.configuration;
      const endedAt = props.invocation.completedAt ?? props.invocation.failedAt;
      return h("aside", {
          "aria-label": "Session details",
          class: "vh-invocation-inspector",
          "data-status": props.invocation.status,
          "data-slot": "invocation-inspector",
        }, [
          h("header", [
            h("div", [h("h3", "Session details"), h("p", configuration?.agent?.name ?? props.invocation.agentName ?? "Agent invocation")]),
            slots.actions?.({ invocation: props.invocation }),
          ]),
          h("div", { class: "vh-invocation-inspector__content" }, [
            h("section", { class: "vh-invocation-inspector__status" }, [
              h("span", { class: "vh-invocation-inspector__status-icon", "aria-hidden": "true" }),
              h("div", [h("strong", statusLabel(props.invocation.status)), h("small", formatDuration(props.invocation.startedAt, endedAt) ?? "In progress")]),
            ]),
            inspectorSection("Activity", h("dl", { class: "vh-invocation-inspector__metrics" }, [
              h("div", [h("dt", "Messages"), h("dd", String(metrics.value.messages))]),
              h("div", [h("dt", "Steps"), h("dd", String(metrics.value.steps))]),
              metrics.value.changes ? h("div", [h("dt", "Changes"), h("dd", String(metrics.value.changes))]) : null,
              metrics.value.tokens !== undefined ? h("div", [h("dt", "Tokens"), h("dd", new Intl.NumberFormat().format(metrics.value.tokens))]) : null,
            ])),
            ...(configuration ? renderConfiguration(configuration) : []),
            slots.metadata?.({ invocation: props.invocation }),
            inspectorSection("Trace", h("code", { class: "vh-invocation-inspector__trace" }, props.invocation.traceId)),
          ]),
        ]);
    };
  },
});
