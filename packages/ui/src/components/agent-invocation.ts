import { computed, defineComponent, h, onBeforeUnmount, ref, type PropType, Suspense } from "vue";
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

function renderFolderIcon() {
  return h("svg", { "aria-hidden": "true", fill: "none", viewBox: "0 0 24 24" }, [
    h("path", { d: "M3 6.5h6l2 2h10v9.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z", "stroke-linecap": "round", "stroke-linejoin": "round" }),
  ]);
}

function renderMessage(activity: InvocationActivity) {
  return h(
    "li",
    {
      class: "vh-invocation-message",
      "data-role": activity.role,
      key: activity.id,
    },
    [
      markdown(activity.body, "vh-invocation-message__body"),
      activity.truncated
        ? h("p", { class: "vh-invocation-event__notice" }, "Some trace content was truncated by the invocation journal.")
        : null,
    ],
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
  const hasDetails = activity.patches.length > 0 || Boolean(command || activity.body || activity.truncated);
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
      hasDetails ? h("div", { class: "vh-invocation-event__details" }, [
        activity.truncated
          ? h("p", { class: "vh-invocation-event__notice" }, "Some trace content was truncated by the invocation journal.")
          : null,
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
      ]) : null,
    ]),
  ]);
}

function inspectorSection(title: string, body: ReturnType<typeof h> | null) {
  return body ? h("section", [h("h4", title), body]) : null;
}

function inspectorRow(label: string, value: string | number | undefined, code = false) {
  if (value === undefined || value === "") return null;
  return h("div", [h("dt", label), h("dd", code ? [h("code", String(value))] : String(value))]);
}

function copyIcon(copied: boolean) {
  return h("svg", { "aria-hidden": "true", fill: "none", viewBox: "0 0 24 24" }, copied
    ? [h("path", { d: "m5 12 4 4L19 6", "stroke-linecap": "round", "stroke-linejoin": "round" })]
    : [
        h("rect", { height: "13", rx: "2", width: "13", x: "8", y: "8" }),
        h("path", { d: "M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3", "stroke-linecap": "round", "stroke-linejoin": "round" }),
      ]);
}

function renderConfiguration(configuration: AgentInvocationConfiguration) {
  const driver = configurationLabel(configuration);
  const workspace = workspaceLabel(configuration);
  return [
    configuration.truncated
      ? inspectorSection("Configuration notice", h("p", "Some configuration values were truncated by the invocation journal."))
      : null,
    inspectorSection("Environment", h("dl", { class: "vh-invocation-inspector__list" }, [
      inspectorRow("Driver", driver),
      inspectorRow("Runtime", configuration.runtime?.name),
      inspectorRow("Workspace", workspace),
    ])),
    configuration.workspace?.sources?.length
      ? inspectorSection("Sources", h("ul", { class: "vh-invocation-inspector__items" }, configuration.workspace.sources.map(source => h("li", [h("span", { "aria-hidden": "true" }, "↳"), h("code", source)]))))
      : null,
    configuration.capabilities?.length
      ? inspectorSection("Capabilities", h("div", { class: "vh-invocation-inspector__stack" }, configuration.capabilities.map(capability => h("details", { class: "vh-invocation-inspector__disclosure" }, [
          h("summary", [h("span", capability.id), capability.metadata ? h("small", "Metadata") : null]),
          capability.metadata ? h("pre", JSON.stringify(capability.metadata, null, 2)) : h("p", "No additional metadata."),
        ]))))
      : null,
    configuration.tools?.length
      ? inspectorSection("Tools", h("ul", { class: "vh-invocation-inspector__items" }, configuration.tools.map(tool => h("li", [h("span", { "aria-hidden": "true" }, "⌁"), h("code", tool.name)]))))
      : null,
    configuration.instructions?.length
      ? inspectorSection("Instructions", h("details", { class: "vh-invocation-inspector__disclosure" }, [
          h("summary", [h("span", "Invocation instructions"), h("small", `${configuration.instructions.length} block${configuration.instructions.length === 1 ? "" : "s"}`)]),
          h("pre", { class: "vh-invocation-inspector__instructions" }, configuration.instructions.join("\n\n")),
        ]))
      : null,
  ];
}

export const AgentInvocation = defineComponent({
  name: "AgentInvocation",
  props: {
    header: { default: true, type: Boolean },
    invocation: { required: true, type: Object as PropType<AgentInvocationView> },
  },
  setup(props, { slots }) {
    const activities = computed(() => invocationActivities(props.invocation));

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
        h("main", { class: "vh-invocation-thread" }, [
          h("div", { class: "vh-invocation-thread__content" }, [
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
    const copied = ref<"invocation" | "trace">();
    let copyTimer: ReturnType<typeof setTimeout> | undefined;
    const metrics = computed(() => ({
      changes: activities.value.filter(activity => activity.kind === "change").length,
      messages: activities.value.filter(activity => activity.kind === "message").length,
      steps: activities.value.filter(activity => activity.kind !== "message").length,
      tokens: latestInvocationTokens(activities.value),
    }));

    async function copyIdentifier(kind: "invocation" | "trace", value: string | undefined) {
      if (!value || !("navigator" in globalThis) || !navigator.clipboard) return;
      await navigator.clipboard.writeText(value);
      copied.value = kind;
      if (copyTimer) clearTimeout(copyTimer);
      copyTimer = setTimeout(() => { copied.value = undefined; }, 1_600);
    }

    function copyAction(kind: "invocation" | "trace", label: string, value: string | undefined) {
      if (!value) return null;
      const didCopy = copied.value === kind;
      return h("button", {
        "aria-label": `Copy ${label}`,
        class: "vh-invocation-inspector__copy",
        onClick: () => void copyIdentifier(kind, value),
        type: "button",
      }, [
        h("span", { class: "vh-invocation-inspector__copy-icon" }, [copyIcon(didCopy)]),
        h("span", didCopy ? "Copied" : `Copy ${label}`),
      ]);
    }

    onBeforeUnmount(() => {
      if (copyTimer) clearTimeout(copyTimer);
    });

    return () => {
      const configuration = props.invocation.configuration;
      const endedAt = props.invocation.completedAt ?? props.invocation.failedAt ?? props.invocation.cancelledAt;
      return h("aside", {
          "aria-label": "Session details",
          class: "vh-invocation-inspector",
          "data-status": props.invocation.status,
          "data-slot": "invocation-inspector",
        }, [
          h("header", [
            h("div", [h("h3", "Details"), h("p", invocationProject(props.invocation))]),
            slots.actions?.({ invocation: props.invocation }),
          ]),
          h("div", { class: "vh-invocation-inspector__content" }, [
            h("section", { class: "vh-invocation-inspector__identity" }, [
              h("div", { class: "vh-invocation-inspector__status" }, [
                h("span", { class: "vh-invocation-inspector__status-icon", "aria-hidden": "true" }),
                h("strong", statusLabel(props.invocation.status)),
                h("small", formatDuration(props.invocation.startedAt, endedAt) ?? "In progress"),
              ]),
              h("h4", invocationTitle(props.invocation)),
              invocationContext(props.invocation) !== props.invocation.id
                ? h("p", invocationContext(props.invocation))
                : null,
            ]),
            inspectorSection("Run", h("dl", { class: "vh-invocation-inspector__list" }, [
              inspectorRow("Agent", configuration?.agent?.name ?? props.invocation.agentName),
              inspectorRow("Messages", metrics.value.messages),
              inspectorRow("Steps", metrics.value.steps),
              metrics.value.changes ? inspectorRow("Changes", metrics.value.changes) : null,
              metrics.value.tokens !== undefined ? inspectorRow("Tokens", new Intl.NumberFormat("en").format(metrics.value.tokens)) : null,
            ])),
            ...(configuration ? renderConfiguration(configuration) : []),
            slots.metadata?.({ invocation: props.invocation }),
            inspectorSection("Identifiers", h("div", { class: "vh-invocation-inspector__copy-list" }, [
              copyAction("trace", "Trace ID", props.invocation.traceId),
              copyAction("invocation", "Invocation ID", props.invocation.id),
            ])),
          ]),
        ]);
    };
  },
});
