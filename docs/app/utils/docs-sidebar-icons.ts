import type { PrimitiveIconName } from "@vite-hub/ui/primitive-rail";
import type { DocsPage, DocsSection } from "~~/modules/vitehub-docs/runtime/utils/docs";
import { normalizeDocsPath } from "~~/modules/vitehub-docs/runtime/utils/docs";

/** Frontmatter icons map to the light Phosphor set so every sidebar page row shares one style. */
const sidebarIconMap = {
  "i-lucide-activity": "i-ph-activity-light",
  "i-lucide-audio-lines": "i-ph-waveform-light",
  "i-lucide-badge-check": "i-ph-seal-check-light",
  "i-lucide-blocks": "i-ph-squares-four-light",
  "i-lucide-book-open": "i-ph-book-open-light",
  "i-lucide-book-open-check": "i-ph-book-bookmark-light",
  "i-lucide-bot": "i-ph-robot-light",
  "i-lucide-box": "i-ph-cube-light",
  "i-lucide-brain": "i-ph-brain-light",
  "i-lucide-brain-circuit": "i-ph-brain-light",
  "i-lucide-calendar-clock": "i-ph-calendar-check-light",
  "i-lucide-chart-no-axes-column": "i-ph-chart-bar-light",
  "i-lucide-circle-alert": "i-ph-warning-circle-light",
  "i-lucide-clipboard-check": "i-ph-clipboard-text-light",
  "i-lucide-cloud-cog": "i-ph-cloud-light",
  "i-lucide-cloud-upload": "i-ph-cloud-arrow-up-light",
  "i-lucide-code-2": "i-ph-code-light",
  "i-lucide-cpu": "i-ph-cpu-light",
  "i-lucide-database": "i-ph-database-light",
  "i-lucide-database-zap": "i-ph-lightning-light",
  "i-lucide-door-open": "i-ph-door-open-light",
  "i-lucide-download": "i-ph-download-simple-light",
  "i-lucide-file-box": "i-ph-file-light",
  "i-lucide-file-code-2": "i-ph-file-code-light",
  "i-lucide-file-cog": "i-ph-file-code-light",
  "i-lucide-file-text": "i-ph-file-text-light",
  "i-lucide-file-user": "i-ph-identification-card-light",
  "i-lucide-files": "i-ph-files-light",
  "i-lucide-folder-git-2": "i-ph-folder-notch-open-light",
  "i-lucide-folder-input": "i-ph-folder-plus-light",
  "i-lucide-folder-search": "i-ph-file-magnifying-glass-light",
  "i-lucide-folder-tree": "i-ph-tree-structure-light",
  "i-lucide-gauge": "i-ph-gauge-light",
  "i-lucide-git-branch": "i-ph-git-branch-light",
  "i-lucide-git-pull-request": "i-ph-git-pull-request-light",
  "i-lucide-heading": "i-ph-text-h-light",
  "i-lucide-key-round": "i-ph-key-light",
  "i-lucide-layout-template": "i-ph-squares-four-light",
  "i-lucide-list-checks": "i-ph-list-checks-light",
  "i-lucide-list-ordered": "i-ph-list-numbers-light",
  "i-lucide-mail": "i-ph-paper-plane-tilt-light",
  "i-lucide-map": "i-ph-map-trifold-light",
  "i-lucide-message-circle-code": "i-ph-chat-circle-text-light",
  "i-lucide-message-square": "i-ph-chat-text-light",
  "i-lucide-messages-square": "i-ph-chats-circle-light",
  "i-lucide-monitor": "i-ph-browser-light",
  "i-lucide-network": "i-ph-tree-structure-light",
  "i-lucide-package": "i-ph-package-light",
  "i-lucide-panels-top-left": "i-ph-browser-light",
  "i-lucide-play-circle": "i-ph-play-circle-light",
  "i-lucide-plug": "i-ph-plug-light",
  "i-lucide-plug-zap": "i-ph-plug-light",
  "i-lucide-radio": "i-ph-broadcast-light",
  "i-lucide-rocket": "i-ph-rocket-launch-light",
  "i-lucide-route": "i-ph-path-light",
  "i-lucide-scroll-text": "i-ph-scroll-light",
  "i-lucide-search": "i-ph-magnifying-glass-light",
  "i-lucide-send": "i-ph-paper-plane-tilt-light",
  "i-lucide-server": "i-ph-hard-drives-light",
  "i-lucide-server-cog": "i-ph-hard-drives-light",
  "i-lucide-shield-alert": "i-ph-shield-warning-light",
  "i-lucide-shield-check": "i-ph-shield-check-light",
  "i-lucide-sliders-horizontal": "i-ph-sliders-horizontal-light",
  "i-lucide-stethoscope": "i-ph-stethoscope-light",
  "i-lucide-terminal": "i-ph-terminal-light",
  "i-lucide-terminal-square": "i-ph-terminal-window-light",
  "i-lucide-user-check": "i-ph-user-check-light",
  "i-lucide-users-round": "i-ph-users-three-light",
  "i-lucide-workflow": "i-ph-arrows-split-light",
  "i-lucide-wrench": "i-ph-wrench-light",
  "i-simple-icons-vite": "i-ph-lightning-light",
  "i-simple-icons-cloudflare": "i-ph-cloud-light",
  "i-simple-icons-vercel": "i-ph-triangle-light",
  "i-vscode-icons-file-type-markdown": "i-ph-markdown-logo-light",
} satisfies Record<string, string>;

const sidebarSectionIconMap = {
  "ai-resources": "i-ph-brain-light",
  "development": "i-ph-wrench-light",
  "frameworks-hosts": "i-ph-plug-light",
  "getting-started": "i-ph-book-open-light",
  "reference": "i-ph-book-bookmark-light",
} satisfies Record<string, string>;

const sidebarPageIconMap = {
  "/docs/agents": "i-ph-activity-light",
  "/docs/agents/capabilities": "i-ph-sliders-horizontal-light",
  "/docs/getting-started/concepts": "i-ph-book-bookmark-light",
  "/docs/frameworks-hosts": "i-ph-lightning-light",
  "/docs/getting-started": "i-ph-book-open-light",
  "/docs/getting-started/server-primitives": "i-ph-cube-light",
  "/docs/reference": "i-ph-package-light",
} satisfies Record<string, string>;

/** Rail icon of each docs section. The Console uses the same icons for its sections. */
export const railSectionIconMap: Readonly<Record<string, PrimitiveIconName>> = {
  "agents": "agent",
  "auth": "auth",
  "blob": "blob",
  "browser": "browser",
  "channels": "channel",
  "connections": "connection",
  "content": "content",
  "database": "database",
  "development": "development",
  "email": "email",
  "env": "env",
  "frameworks-hosts": "hosts",
  "getting-started": "start",
  "kv": "kv",
  "queue": "queue",
  "rate-limit": "rate-limit",
  "realtime": "realtime",
  "reference": "reference",
  "sandbox": "sandbox",
  "schedule": "schedule",
  "shell": "shell",
  "source": "source",
  "ui": "ui",
  "workflows": "workflow",
  "workspace": "workspace",
};

/** Returns the rail icon of a section. A new section without an entry falls back to the Reference icon. */
export function railSectionIcon(section: Pick<DocsSection, "id">): PrimitiveIconName {
  const icon = Object.hasOwn(railSectionIconMap, section.id) ? railSectionIconMap[section.id] : undefined;
  return icon ?? "reference";
}

export function sidebarIcon(icon: string | null | undefined, fallback = "i-ph-file-text-light") {
  return icon ? lookupIcon(sidebarIconMap, icon) || (icon.startsWith("i-ph-") ? icon : fallback) : fallback;
}

export function sidebarSectionIcon(section: Pick<DocsSection, "id" | "icon">) {
  return lookupIcon(sidebarSectionIconMap, section.id) || sidebarIcon(section.icon, "i-ph-folder-light");
}

export function sidebarPageIcon(page: Pick<DocsPage, "path" | "icon">) {
  return lookupIcon(sidebarPageIconMap, normalizeDocsPath(page.path)) || sidebarIcon(page.icon);
}

function lookupIcon(icons: Record<string, string>, key: string) {
  return icons[key];
}
