// Every combination of USkeleton, UEmpty, UBadge, UChip, UAlert, and UCard that the Console passes, and its presence
// avatar row, with the Console file that uses it. `nuxt-ui.ts` renders each case with the Nuxt UI component, as the
// Console does, and `kit.ts` renders it as the kit markup. The text is the Console's.

export type Color = "neutral" | "success" | "warning" | "info" | "error";

export interface Action {
  label: string;
  icon?: string;
  variant?: "outline" | "ghost";
  color?: "neutral";
}

export type Case =
  | { part: "skeleton"; id: string; source: string; class: string }
  | { part: "badge"; id: string; source: string; size?: "sm"; color?: Color; label?: string; status?: Color; class?: string; role?: string }
  | { part: "chip"; id: string; source: string; show: boolean }
  | {
    part: "alert";
    id: string;
    source: string;
    color?: Color;
    variant?: "outline";
    icon?: string;
    title?: string;
    description?: string;
    paragraphs?: string[];
    actions?: Action[];
    orientation?: "horizontal";
    close?: boolean;
    class?: string;
    role?: string;
  }
  | {
    part: "empty";
    id: string;
    source: string;
    variant?: "naked";
    size?: "xs" | "sm";
    icon?: string;
    title?: string;
    description?: string;
    paragraphs?: string[];
    actions?: Action[];
    body?: boolean;
    class?: string;
    /**
     * The class to write on the kit markup when it differs. Nuxt UI's `sm:p-6 lg:p-8` on UEmpty win over a padding
     * class such as `py-16` from 640px up, so in the Console that class pads only phones. `max-sm:` keeps that.
     */
    kitClass?: string;
    role?: string;
  }
  | { part: "card"; id: string; source: string }
  | { part: "avatar-group"; id: string; source: string; size?: "sm"; people: Array<{ initials?: string; image?: boolean; live?: boolean; viewing?: boolean }>; more?: number };

// The Skeleton classes of the Console, one case each. Only the look of the bar comes from the part; the classes set
// its size, radius, margins, and animation.
const skeletonClasses = [
  "h-3.5 w-24", "h-9 w-full", "my-0.5 h-10 rounded-md", "h-7", "h-3 w-16 animate-none", "h-3 w-40",
  "mb-2 h-6 w-1/3 animate-none", "h-4 animate-none w-2/3", "my-0.5 h-8 rounded-md", "h-4 w-56", "h-3.5 w-1/2",
  "h-6 w-28 rounded-md", "mb-1 h-11 w-full rounded-md", "h-20 w-full", "size-4 animate-none", "mt-1 h-4 w-16 animate-none sm:hidden",
  "ms-auto h-3 w-12 animate-none", "aspect-square w-16 rounded-md", "my-1 h-9 rounded-md", "size-7 rounded-full",
  "h-8 w-2/3 animate-none rounded-md", "h-4 w-3/4 rounded-md", "h-20 rounded-lg", "h-1 w-full rounded-full", "h-14 rounded-lg",
  "mx-[0.5625rem] my-2 size-[1.125rem] shrink-0 rounded-sm", "size-52", "h-12 ms-auto w-1/2", "size-4 shrink-0 rounded-sm",
  "h-3 flex-1", "mt-0.5 size-4", "my-1 h-6 w-10", "h-4 w-16 sm:mt-3",
];

export const cases: Case[] = [
  ...skeletonClasses.map((className, index): Case => ({ part: "skeleton", id: `skeleton-${index + 1}`, source: "28 files", class: className })),

  { part: "badge", id: "badge-count", source: "console-section.vue", label: "12", class: "tabular-nums" },
  { part: "badge", id: "badge-md-success", source: "console-usage.vue", color: "success", label: "ready" },
  { part: "badge", id: "badge-md-error", source: "console-usage.vue", color: "error", label: "unavailable" },
  { part: "badge", id: "badge-md-neutral", source: "console-usage.vue", color: "neutral", label: "Stale" },
  { part: "badge", id: "badge-sm-count", source: "console-document-list.vue", size: "sm", label: "3", class: "tabular-nums" },
  { part: "badge", id: "badge-sm-neutral", source: "console-setup.vue", size: "sm", color: "neutral", label: "Off" },
  { part: "badge", id: "badge-sm-success", source: "console-setup.vue", size: "sm", color: "success", label: "On, implied" },
  { part: "badge", id: "badge-sm-warning", source: "console-setup.vue", size: "sm", color: "warning", label: "Unknown" },
  { part: "badge", id: "badge-sm-info", source: "console-document-preview.vue", size: "sm", color: "info", label: "Draft", role: "status", class: "ms-auto shrink-0" },
  { part: "badge", id: "badge-sm-error", source: "console-mcp-content.vue", size: "sm", color: "error", label: "Protocol error" },
  { part: "badge", id: "badge-sm-status", source: "console-mcp-connection.vue", size: "sm", color: "success", status: "success", label: "Connected", class: "shrink-0" },
  { part: "badge", id: "badge-sm-status-warning", source: "console-mcp-connection.vue", size: "sm", color: "warning", status: "warning", label: "Signed out", class: "shrink-0" },

  { part: "chip", id: "chip-shown", source: "console-app.vue", show: true },
  { part: "chip", id: "chip-hidden", source: "console-app.vue", show: false },

  {
    part: "alert", id: "alert-neutral-actions", source: "console-documents.vue", color: "neutral", icon: "i-lucide-log-in", title: "Sign in to edit",
    description: "You are not signed in, or your session ended. Sign in, then reload.", actions: [{ label: "Reload", icon: "i-lucide-refresh-cw", variant: "outline" }],
  },
  {
    part: "alert", id: "alert-error-actions", source: "console-documents.vue", color: "error", icon: "i-lucide-cloud-off", title: "Couldn't load collections",
    description: "The server answered 500.", actions: [{ label: "Try again", icon: "i-lucide-refresh-cw", variant: "outline" }],
  },
  { part: "alert", id: "alert-error-plain", source: "console-document-history.vue", color: "error", title: "Couldn't load history", description: "The server answered 500." },
  {
    part: "alert", id: "alert-warning-icon", source: "console-channels.vue", color: "warning", icon: "i-lucide-triangle-alert", title: "Older messages may be missing",
    description: "The adapter keeps 30 days of messages.", class: "m-3",
  },
  { part: "alert", id: "alert-error-icon", source: "console-invocation-composer.vue", color: "error", icon: "i-lucide-circle-alert", title: "Could not start Agent", description: "The Agent has no model." },
  {
    part: "alert", id: "alert-warning-horizontal", source: "console-connection-state.vue", color: "warning", icon: "i-lucide-wifi-off", title: "Connection lost", role: "alert",
    description: "Showing the last loaded session. Reconnect to get updates.", orientation: "horizontal", actions: [{ label: "Reconnect", icon: "i-lucide-refresh-cw", variant: "outline" }],
  },
  {
    part: "alert", id: "alert-error-slot", source: "console-env.vue", color: "error", icon: "i-lucide-circle-alert", title: "Set DATABASE_URL", role: "alert",
    paragraphs: ["The Database needs a connection string. Run `vitehub env set DATABASE_URL`."],
  },
  { part: "alert", id: "alert-warning-plain", source: "console-setup.vue", color: "warning", title: "The dev server did not come back", description: "The change is written. Restart the dev server by hand, then reload this page." },
  { part: "alert", id: "alert-success-icon", source: "console-setup.vue", color: "success", icon: "i-lucide-check", title: "Queue is on", description: "Changed vite.config.ts. The dev server restarted." },
  {
    part: "alert", id: "alert-warning-outline", source: "console-document-list.vue", color: "warning", variant: "outline", icon: "i-lucide-circle-alert", role: "alert", close: true, class: "m-4",
    title: "Nothing was published", description: "Welcome changed on the server. Open it, then publish again.", actions: [{ label: "Open Welcome", color: "neutral", variant: "outline" }],
  },
  {
    part: "alert", id: "alert-error-outline", source: "console-document-list.vue", color: "error", variant: "outline", icon: "i-lucide-circle-alert", role: "alert", close: true, class: "m-4",
    title: "Fix 1 document before you publish", description: "Pricing has a field that is not valid.", actions: [{ label: "Open Pricing", color: "neutral", variant: "outline" }],
  },
  {
    part: "alert", id: "alert-warning-paragraphs", source: "console-document-editor.vue", color: "warning", icon: "i-lucide-laptop", title: "Local only", role: "status", class: "mb-6",
    paragraphs: ["Your edits stay in this tab. Nobody sees them, and nothing saves until you apply them.", "Someone saved the shared draft after your local edits started. Apply compares them before it saves."],
    actions: [{ label: "Discard…", variant: "ghost" }, { label: "Apply to shared draft", variant: "outline" }],
  },
  {
    part: "alert", id: "alert-neutral-outline", source: "console-document-editor.vue", color: "neutral", variant: "outline", icon: "i-lucide-lock", role: "status", class: "mb-6",
    paragraphs: ["Ana is editing this page. You can read it."], actions: [{ label: "Take over", variant: "outline" }],
  },
  {
    part: "alert", id: "alert-state-neutral", source: "console-state.vue", color: "neutral", icon: "i-lucide-inbox", title: "No Agents yet", role: "status",
    paragraphs: ["Define an Agent in server/agents/."],
  },

  { part: "card", id: "card-section", source: "console-document-dashboard.vue" },

  { part: "empty", id: "empty-naked-xs", source: "console-kv.vue", variant: "naked", size: "xs", icon: "i-lucide-key-round", title: "No keys", description: "Keys show here after the app writes one." },
  { part: "empty", id: "empty-naked-xs-title", source: "console-documents.vue", variant: "naked", size: "xs", title: "No collections you can read", description: "Ask an admin for read access to a collection." },
  {
    part: "empty", id: "empty-naked-xs-actions", source: "console-kv.vue", variant: "naked", size: "xs", icon: "i-lucide-search", title: "No keys match “user:”",
    description: "Try another prefix.", actions: [{ label: "Clear filter", variant: "ghost" }],
  },
  { part: "empty", id: "empty-naked-sm", source: "console-auth-detail.vue", variant: "naked", size: "sm", icon: "i-lucide-link", title: "No linked accounts", description: "This user signs in with email only." },
  {
    part: "empty", id: "empty-naked-sm-actions", source: "console-logs.vue", variant: "naked", size: "sm", icon: "i-lucide-search", title: "No logs match", role: "status",
    description: "No log line matches “timeout” at the warn level.", actions: [{ label: "Clear filters", variant: "ghost" }],
  },
  { part: "empty", id: "empty-naked-sm-padded", source: "console-search-palette.vue", variant: "naked", size: "sm", icon: "i-lucide-search-x", title: "No results", description: "Nothing matches “queue”.", class: "py-10", kitClass: "max-sm:py-10" },
  { part: "empty", id: "empty-naked", source: "console-setup.vue", variant: "naked", icon: "i-lucide-blocks", title: "Pick a feature", description: "Choose a feature on the left to see what it does and turn it on." },
  { part: "empty", id: "empty-naked-title", source: "console-session-trace.vue", variant: "naked", icon: "i-lucide-search", title: "No spans match" },
  {
    part: "empty", id: "empty-naked-actions-padded", source: "console-kv.vue", variant: "naked", icon: "i-lucide-key-round", title: "This store is empty", class: "flex-1 py-16", kitClass: "flex-1 max-sm:py-16",
    description: "Keys show here after the app writes one.", actions: [{ label: "Refresh", icon: "i-lucide-refresh-cw", color: "neutral", variant: "outline" }],
  },
  { part: "empty", id: "empty-naked-no-icon", source: "console-session-inspector.vue", variant: "naked", title: "Open a tab", description: "Choose what to inspect in this Agent Invocation.", body: true },
  {
    part: "empty", id: "empty-naked-state", source: "console-state.vue", variant: "naked", icon: "i-lucide-circle-alert", title: "Couldn't load sessions", role: "alert", class: "min-h-0 flex-1",
    paragraphs: ["The server answered 500.", "Try again in a minute."], body: true,
  },
  { part: "empty", id: "empty-outline", source: "console-document-dashboard.vue", icon: "i-lucide-circle-check", title: "Everything is published", description: "Drafts and edits show here until someone publishes them." },
  {
    part: "empty", id: "empty-outline-actions", source: "console-document-list.vue", icon: "i-lucide-file-text", title: "No posts yet", class: "m-4 flex-1 py-12", kitClass: "m-4 flex-1 max-sm:py-12",
    description: "Create the first post.", actions: [{ label: "New document", icon: "i-lucide-plus" }],
  },
  { part: "empty", id: "empty-outline-sm", source: "console-document-diff.vue", size: "sm", icon: "i-lucide-equal", title: "No changes", description: "This version is the same as the published one." },
  { part: "empty", id: "empty-outline-no-icon", source: "console-usage-chart.vue", title: "No usage yet", description: "Nov 1 to Nov 14 UTC", class: "h-40" },
  { part: "empty", id: "empty-outline-padded-x", source: "console-app.vue", icon: "i-lucide-message-square-more", title: "No sessions match", class: "px-4", kitClass: "max-sm:px-4", actions: [{ label: "Clear filters" }] },

  { part: "avatar-group", id: "avatars-header", source: "console-presence-avatars.vue", people: [{ initials: "AL" }, { initials: "BK", viewing: true }] },
  { part: "avatar-group", id: "avatars-header-more", source: "console-presence-avatars.vue", people: [{ live: true }, { initials: "AL" }, { image: true }], more: 2 },
  { part: "avatar-group", id: "avatars-row", source: "console-presence-avatars.vue", size: "sm", people: [{ initials: "AL" }], more: 1 },
  { part: "avatar-group", id: "avatars-row-viewing", source: "console-presence-avatars.vue", size: "sm", people: [{ initials: "BK", viewing: true }] },
];

// A 1x1 picture for the avatar image case, so the page needs no network.
export const picture = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 2 2'%3E%3Cpath fill='%2393c5fd' d='M0 0h2v2H0z'/%3E%3Cpath fill='%231d4ed8' d='M0 0h1v1H0z'/%3E%3C/svg%3E";
