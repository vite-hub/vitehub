<script setup lang="ts">
// The app override keeps product-specific host selection out of the package tree.
// `::code-tree` shows example code as a project file tree. Each child code block names its file
// with a path, such as ```ts [server/workspaces/docs.ts]```. The tree lists folders first, like an
// editor, and the first code block opens first. In a narrow panel, such as a hero beside its copy, the
// tree becomes one row of file tabs above the code, so the code keeps the width.
//
// With `feature`, a catalog id such as `kv`, a "Deploy on" row lists the hosts. Picking one rewrites the
// file with `preset: '<host>'` for that host and marks the changed lines. The other files stay the same,
// because the route code does not depend on the host.
import { features } from "@vite-hub/internal/features";
import type { FeatureId } from "@vite-hub/internal/features";
import { useElementSize } from "@vueuse/core";
import { isVNode } from "vue";
import type { VNode } from "vue";

import { hostConfigs } from "../../data/host-configs";
import type { PickerHost } from "../../utils/host-config";

const props = defineProps<{
  /** The catalog id of the primitive, such as `kv` or `rateLimit`. It adds the host picker. */
  feature?: FeatureId;
  /** The path of the file that opens first. */
  defaultValue?: string;
}>();
const slots = defineSlots<{ default?: () => VNode[] }>();
const id = useId();
const selected = ref(0);
const tree = useTemplateRef<HTMLElement>("tree");
const frame = useTemplateRef<HTMLElement>("frame");
// The tree is a column from 44rem of panel width, the same width as the container query below.
const { width } = useElementSize(frame);
const orientation = computed(() => (width.value === 0 ? undefined : width.value >= 704 ? "vertical" : "horizontal"));

function flatten(nodes: VNode[]): VNode[] {
  return nodes.flatMap((node) =>
    typeof node.type === "symbol" && Array.isArray(node.children) ? flatten(node.children as VNode[]) : [node],
  );
}

// The text of a rendered code block. Nuxt Content does not pass the source as a `code` prop, so this joins the
// text of the highlighted lines, which also hold the newlines between them.
function textOf(children: VNode["children"]): string {
  if (typeof children === "string") return children;
  if (Array.isArray(children)) return children.map((child) => (isVNode(child) ? textOf(child.children) : typeof child === "string" ? child : "")).join("");
  if (children && typeof children === "object" && typeof children.default === "function") return textOf(children.default());
  return "";
}

const files = computed(() =>
  flatten(slots.default?.() ?? [])
    .map((node) => ({ code: textOf(node.children), node, path: String(node.props?.filename ?? "") }))
    .filter((file) => file.path),
);

const rows = computed(() => buildFileTree(files.value.map((file) => file.path)));
if (props.defaultValue) selected.value = Math.max(0, files.value.findIndex((file) => file.path === props.defaultValue));

// The row of tabs hides the folders, so two files with the same name also show their folder.
const sharedNames = computed(() => {
  const names = files.value.map((file) => file.path.split("/").at(-1));
  return new Set(names.filter((name, index) => names.indexOf(name) !== index));
});

function folderOf(path: string) {
  const parts = path.split("/");
  return sharedNames.value.has(parts.at(-1)) && parts.length > 1 ? `${parts.at(-2)}/` : "";
}

const hostOptions: { color: string; host: PickerHost; icon: string; label: string }[] = [
  { color: "#5fa04e", host: "node", icon: "i-simple-icons-nodedotjs", label: "Node / Docker" },
  { color: "#f48120", host: "cloudflare", icon: "i-simple-icons-cloudflare", label: "Cloudflare" },
  { color: "#52525b", host: "vercel", icon: "i-simple-icons-vercel", label: "Vercel" },
  { color: "#00c7b7", host: "netlify", icon: "i-simple-icons-netlify", label: "Netlify" },
  { color: "#475569", host: "deno", icon: "i-simple-icons-deno", label: "Deno" },
];

const hostRow = useTemplateRef<HTMLElement>("hostRow");
const configs = computed(() => (props.feature ? hostConfigs[props.feature] : undefined));
// The file written for a host. Its authored host is selected first, so the server renders the authored code.
const config = computed(() => {
  if (!configs.value) return undefined;
  const index = files.value.findIndex((file) => configHost(file.code));
  return index === -1 ? undefined : { code: files.value[index]!.code, host: configHost(files.value[index]!.code)!, index };
});
const pickedHost = ref<PickerHost>();
const host = computed(() => (config.value ? (pickedHost.value ?? config.value.host) : undefined));
const hostLabel = computed(() => hostOptions.find((option) => option.host === host.value)?.label ?? "");
const support = computed(() => (props.feature && host.value ? features[props.feature].hosts[host.value] : undefined));
// The catalog's short provider name, or its sentence when the name only repeats the host, such as Cloudflare Rate Limit.
const providerName = computed(() => {
  if (!support.value || support.value.level === "unsupported") return "";
  return support.value.display === hostLabel.value ? support.value.detail.replace(/\.$/, "") : support.value.display;
});

const rewrite = shallowRef<{ code: string; host: PickerHost; html: string }>();
// The rewrite that matches the picked host. Until it is highlighted, the panel keeps the authored code.
const shownRewrite = computed(() => (rewrite.value?.host === host.value ? rewrite.value : undefined));
let rewriteRequest = 0;
watch(host, async (next) => {
  const request = ++rewriteRequest;
  const code = config.value && configs.value && next && next !== config.value.host
    ? rewriteHostConfig(config.value.code, configs.value, next)
    : undefined;
  if (!code || !config.value) {
    rewrite.value = undefined;
    return;
  }
  const html = await highlightCodeLines(code, "ts", changedLines(config.value.code, code));
  if (request === rewriteRequest) rewrite.value = { code, host: next!, html };
});

function isSupported(option: PickerHost) {
  return Boolean(configs.value?.[option]);
}

// A host that changes the config also opens it, so the change is in view.
function pickHost(option: PickerHost) {
  pickedHost.value = option;
  if (!config.value || !isSupported(option)) return;
  selected.value = config.value.index;
  revealConfigTab();
}

// A narrow tab row can hide the config tab past its edge, so the row scrolls to it. Only the row scrolls:
// `scrollIntoView()` would also scroll the page away from the host row.
function revealConfigTab() {
  const tab = config.value && tree.value?.querySelector(`[data-index="${config.value.index}"]`);
  if (!tree.value || !tab) return;
  const row = tree.value.getBoundingClientRect();
  const box = tab.getBoundingClientRect();
  if (box.right > row.right) tree.value.scrollLeft += box.right - row.right;
  else if (box.left < row.left) tree.value.scrollLeft -= row.left - box.left;
}

// The changed-file dot makes the config tab wider once the rewrite shows.
watch(shownRewrite, revealConfigTab, { flush: "post" });

// The host row is a radio group: arrow keys move the choice and the focus together.
function onHostKeydown(event: KeyboardEvent) {
  const index = hostOptions.findIndex((option) => option.host === host.value);
  const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key];
  const target = event.key === "Home" ? 0 : event.key === "End" ? hostOptions.length - 1
    : step ? (index + step + hostOptions.length) % hostOptions.length : undefined;
  if (target === undefined) return;
  event.preventDefault();
  pickHost(hostOptions[target]!.host);
  hostRow.value?.querySelector<HTMLElement>(`[data-host="${hostOptions[target]!.host}"]`)?.focus();
}

/** The catalog sentences quote code in backticks. Odd parts are code. */
function codeParts(text: string) {
  return text.split("`");
}

function pathNote(index: number) {
  if (!config.value) return "";
  if (index !== config.value.index) return "Same on every host";
  return shownRewrite.value ? `Changed for ${hostLabel.value}` : "";
}

// Both arrow pairs move through the files in tree order.
function onTreeKeydown(event: KeyboardEvent) {
  const order = rows.value.flatMap((row) => (row.kind === "file" ? [row.index] : []));
  const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key];
  const target = event.key === "Home" ? order[0] : event.key === "End" ? order.at(-1)
    : step ? order[(order.indexOf(selected.value) + step + order.length) % order.length] : undefined;
  if (target === undefined) return;
  event.preventDefault();
  selected.value = target;
  tree.value?.querySelector<HTMLElement>(`[data-index="${target}"]`)?.focus();
}
</script>

<template>
  <div ref="frame" class="vh-files-frame">
  <div class="vh-files" :class="{ 'has-hosts': config }">
    <div ref="tree" class="vh-files-tree" role="tablist" aria-label="Example files" :aria-orientation="orientation" @keydown="onTreeKeydown">
      <template v-for="row in rows" :key="row.path">
        <div v-if="row.kind === 'folder'" class="vh-files-row is-folder" role="presentation" :style="{ '--depth': row.depth }">
          <UIcon name="i-lucide-folder-open" class="size-3.5 shrink-0" aria-hidden="true" />
          <span>{{ row.name }}</span>
        </div>
        <button
          v-else
          :id="`${id}-tab-${row.index}`"
          type="button"
          role="tab"
          class="vh-files-row is-file"
          :style="{ '--depth': row.depth }"
          :data-index="row.index"
          :data-state="selected === row.index ? 'active' : 'inactive'"
          :aria-selected="selected === row.index"
          :aria-controls="`${id}-panel-${row.index}`"
          :aria-label="row.path"
          :tabindex="selected === row.index ? 0 : -1"
          @click="selected = row.index"
        >
          <span class="vh-files-icon" aria-hidden="true"><ProseCodeIcon :filename="row.path" /></span>
          <span><span v-if="folderOf(row.path)" class="vh-files-folder">{{ folderOf(row.path) }}</span>{{ row.name }}</span>
          <span v-if="shownRewrite && row.index === config?.index" class="vh-files-changed-dot" aria-hidden="true" />
        </button>
      </template>
    </div>

    <div
      v-for="(file, index) in files"
      :id="`${id}-panel-${index}`"
      :key="file.path"
      role="tabpanel"
      class="vh-files-code"
      :data-state="selected === index ? 'active' : 'inactive'"
      :aria-labelledby="`${id}-tab-${index}`"
    >
      <p class="vh-files-path">
        <span class="vh-files-path-name">{{ file.path }}</span>
        <span v-if="pathNote(index)" class="vh-files-path-note" :class="{ 'is-changed': index === config?.index }">{{ pathNote(index) }}</span>
      </p>
      <div class="vh-files-body" data-code-header>
        <ProsePre
          v-if="shownRewrite && index === config?.index"
          :code="shownRewrite.code"
          language="ts"
          :class="['language-ts', highlightedPreClass]"
          hide-header
          tabindex="-1"
        >
          <code v-html="shownRewrite.html" />
        </ProsePre>
        <component :is="file.node" v-else hide-header tabindex="-1" />
      </div>
    </div>

    <div v-if="config" class="vh-files-hosts">
      <span :id="`${id}-hosts`" class="vh-files-hosts-label">Deploy on</span>
      <div
        ref="hostRow"
        class="vh-files-host-row"
        role="radiogroup"
        :aria-labelledby="`${id}-hosts`"
        @keydown="onHostKeydown"
      >
        <button
          v-for="option in hostOptions"
          :key="option.host"
          type="button"
          role="radio"
          class="vh-files-host"
          :data-host="option.host"
          :data-supported="isSupported(option.host)"
          :style="{ '--brand-color': option.color }"
          :aria-checked="host === option.host"
          :aria-label="isSupported(option.host) ? option.label : `${option.label}, not supported`"
          :tabindex="host === option.host ? 0 : -1"
          @click="pickHost(option.host)"
        >
          <UIcon :name="option.icon" class="vh-files-host-mark" aria-hidden="true" />
          <span class="vh-files-host-name">{{ option.label }}</span>
        </button>
      </div>
      <p class="vh-files-host-status" aria-live="polite">
        <template v-if="support?.level === 'unsupported'">
          <strong>{{ hostLabel }}</strong>: not supported.
          <template v-for="(part, partIndex) in codeParts(support.detail)" :key="partIndex">
            <code v-if="partIndex % 2">{{ part }}</code><template v-else>{{ part }}</template>
          </template>
        </template>
        <template v-else-if="support">
          <strong>{{ hostLabel }}</strong>: {{ providerName }}<template v-if="support.level === 'explicit'">, set with <code>{{ support.option }}</code></template>
          <span v-if="shownRewrite" class="sr-only">. {{ files[config.index]?.path }} is updated.</span>
        </template>
      </p>
    </div>
  </div>
  </div>
</template>

<style scoped>
/* The panel width, not the viewport, decides where the tree goes. */
.vh-files-frame {
  container-type: inline-size;
}

/* One framed panel, like a small editor: the tree on a tinted pane, the code under a header with its path. */
.vh-files {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: auto minmax(0, 1fr) auto;
  overflow: hidden;
  border: 1px solid var(--ui-border);
  border-radius: calc(var(--ui-radius) * 3);
  background: var(--ui-bg);
  box-shadow:
    0 1px 2px rgb(0 0 0 / 0.04),
    0 12px 32px -16px rgb(0 0 0 / 0.16);
}

@media (min-width: 40rem) {
  .vh-files {
    height: 26rem;
  }

  /* The host row adds its own height, so the code keeps the same room. */
  .vh-files.has-hosts {
    height: 31rem;
  }
}

/* Narrow panels: the files are one row of tabs. The path header names the folder. */
.vh-files-tree {
  display: flex;
  overflow-x: auto;
  border-bottom: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
  padding: 0.25rem;
  font-family: var(--font-mono);
  font-size: 0.75rem;
  white-space: nowrap;
  scrollbar-width: none;
}

.vh-files-row.is-folder {
  display: none;
}

.vh-files-folder {
  color: var(--ui-text-dimmed);
}

/* Wide panels: the tree column fits its longest name, so file names never truncate. The code takes the rest. */
@container (min-width: 44rem) {
  .vh-files {
    grid-template-columns: max-content minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr) auto;
  }

  .vh-files-tree {
    min-width: 9rem;
    flex-direction: column;
    overflow: hidden auto;
    border-right: 1px solid var(--ui-border);
    border-bottom: 0;
    padding: 0.5rem 0.25rem;
  }

  .vh-files-row.is-folder {
    display: flex;
  }

  .vh-files-folder {
    display: none;
  }

  .vh-files-code {
    grid-area: 1 / 2;
  }
}

.vh-files-row {
  display: flex;
  min-height: 1.75rem;
  flex: none;
  align-items: center;
  gap: 0.4375rem;
  border-radius: var(--ui-radius);
  padding-inline: 0.5rem;
  color: var(--ui-text-muted);
  text-align: start;
}

@container (min-width: 44rem) {
  .vh-files-row {
    padding-inline: calc(0.375rem + var(--depth) * 0.75rem) 0.375rem;
  }
}

.vh-files-row.is-folder {
  color: var(--ui-text-dimmed);
}

.vh-files-row.is-file {
  cursor: pointer;
  transition:
    background-color 150ms ease,
    color 150ms ease;
}

.vh-files-row.is-file:hover {
  color: var(--ui-text-highlighted);
}

.vh-files-row.is-file[data-state="active"] {
  background: color-mix(in srgb, var(--ui-text-highlighted) 7%, transparent);
  color: var(--ui-text-highlighted);
}

.vh-files-row.is-file:focus-visible {
  outline: 2px solid var(--ui-text-highlighted);
  outline-offset: -2px;
}

/* Inactive files stay mounted but hidden, so switching files does not move the page. */
.vh-files-code {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
}

.vh-files-code[data-state="inactive"] {
  display: none;
}

/* The header lines up with the first tree row. */
.vh-files-path {
  display: flex;
  min-height: 2.75rem;
  flex: none;
  align-items: center;
  gap: 0.75rem;
  margin: 0;
  border-bottom: 1px solid var(--ui-border);
  padding-inline: 0.75rem;
  color: var(--ui-text-dimmed);
  font-family: var(--font-mono);
  font-size: 0.75rem;
}

.vh-files-path-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.vh-files-path-note {
  margin-left: auto;
  flex: none;
  font-family: var(--font-sans);
  font-size: 0.6875rem;
}

.vh-files-path-note.is-changed {
  color: var(--ui-text-muted);
}

/* The config tab shows a dot while its code is rewritten for another host. */
.vh-files-changed-dot {
  width: 0.375rem;
  height: 0.375rem;
  flex: none;
  border-radius: 999px;
  background: var(--ui-primary);
}

.vh-files-body {
  min-height: 0;
  flex: 1;
  overflow: auto;
  overscroll-behavior: contain;
  padding: 0.875rem 0.75rem 1rem;
}

.vh-files-body :deep(pre) {
  margin: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  padding: 0;
  font-size: 0.75rem;
  line-height: 1.85;
  white-space: pre;
}

.vh-files-body :deep(> div) {
  margin: 0;
}

/* Lines that the host rewrite changed. The dark Shiki theme sets every span's background color with
   !important, so the mark is a background image. */
.vh-files-body :deep(.line.is-marked) {
  --vh-mark: color-mix(in srgb, var(--ui-primary) 12%, transparent);
  background-image: linear-gradient(var(--vh-mark), var(--vh-mark));
}

/* The host row matches the "Deploy on" row of the Agent playground. */
.vh-files-hosts {
  grid-column: 1 / -1;
  border-top: 1px solid var(--ui-border);
  background: color-mix(in srgb, var(--ui-bg-muted) 48%, transparent);
  padding: 0.45rem 0.65rem 0.55rem;
}

@container (min-width: 44rem) {
  .vh-files-hosts {
    grid-row: 2;
  }
}

.vh-files-hosts-label {
  display: block;
  padding: 0 0.25rem 0.2rem;
  color: var(--ui-text-dimmed);
  font-size: 0.6rem;
  font-weight: 600;
  line-height: 1rem;
}

.vh-files-host-row {
  display: grid;
  /* Equal columns, but a long name such as "Node / Docker" keeps its full width. */
  grid-template-columns: repeat(5, minmax(max-content, 1fr));
  gap: 0.2rem;
}

.vh-files-host {
  display: flex;
  min-width: 0;
  min-height: 2.35rem;
  align-items: center;
  justify-content: center;
  gap: 0.35rem;
  border-radius: 0.375rem;
  color: var(--ui-text-muted);
  cursor: pointer;
  transition:
    background-color 150ms ease,
    color 150ms ease;
}

/* Narrow panels put the name under the mark, so five hosts fit in one row. */
@container (max-width: 30rem) {
  .vh-files-host {
    flex-direction: column;
    gap: 0.2rem;
    padding-block: 0.35rem;
  }
}

.vh-files-host-mark {
  width: 1rem;
  height: 1rem;
  flex: none;
  color: var(--brand-color);
  opacity: 0.72;
}

.vh-files-host-name {
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  font-size: 0.6rem;
  font-weight: 500;
  line-height: 0.75rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* A host without support stays in the row, muted. Picking it explains why. */
.vh-files-host[data-supported="false"] .vh-files-host-mark {
  opacity: 0.3;
  filter: grayscale(1);
}

.vh-files-host[data-supported="false"] .vh-files-host-name {
  color: var(--ui-text-dimmed);
}

.vh-files-host[aria-checked="true"] {
  background: var(--ui-bg);
  color: var(--ui-text-highlighted);
  box-shadow:
    0 1px 3px rgb(0 0 0 / 0.08),
    inset 0 0 0 1px color-mix(in srgb, var(--brand-color) 28%, var(--ui-border));
}

.vh-files-host[aria-checked="true"] .vh-files-host-mark {
  opacity: 1;
}

.vh-files-host:focus-visible {
  outline: 2px solid var(--ui-text-highlighted);
  outline-offset: -2px;
}

@media (hover: hover) and (pointer: fine) {
  .vh-files-host:hover {
    background: color-mix(in srgb, var(--brand-color) 7%, var(--ui-bg));
    color: var(--ui-text-highlighted);
  }

  .vh-files-host:hover .vh-files-host-mark {
    opacity: 1;
  }
}

.vh-files-host-status {
  margin: 0.4rem 0.25rem 0;
  color: var(--ui-text-muted);
  font-size: 0.6875rem;
  line-height: 1.45;
  text-wrap: pretty;
}

.vh-files-host-status strong {
  color: var(--ui-text-highlighted);
  font-weight: 500;
}

.vh-files-host-status code {
  font-family: var(--font-mono);
  font-size: 0.625rem;
}

@media (prefers-reduced-motion: reduce) {
  .vh-files-host,
  .vh-files-row.is-file {
    transition: none;
  }
}
.vh-files-icon {
  display: grid;
  width: 0.875rem;
  height: 0.875rem;
  flex: none;
  place-items: center;
}

.vh-files-icon > * {
  width: 100%;
  height: 100%;
}

.vh-files-body :deep(.ck) {
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
  padding: 0;
}

.vh-files-body :deep(.ck-bar) {
  display: none;
}
</style>
