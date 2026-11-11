<script setup lang="ts">
// The app override keeps product-specific host selection out of the package tree.
// `::code-tree` shows example code as a set of file tabs. Each child code block names its file
// with a path, such as ```ts [server/workspaces/docs.ts]```. The tabs list folders first, like an
// editor, and the first code block opens first. Code blocks inside `::framework{name}` show only for the
// framework that the reader picked, and the header then shows the framework switch. A wide panel shows
// the tabs as a column beside the code. A narrow panel, such as a hero beside its copy, shows them as a
// row above the code.
//
// With `feature`, a catalog id such as `kv`, a "Deploy on" row lists the hosts. Picking one rewrites the
// file with `host: '<host>'` for that host and marks the changed lines. The other files stay the same,
// because the route code does not depend on the host.
import { features } from "@vite-hub/internal/features";
import type { FeatureId } from "@vite-hub/internal/features";
import { isVNode } from "vue";
import type { ComponentPublicInstance, VNode } from "vue";
import { isFramework } from "~/utils/framework";
import type { Framework } from "~/utils/framework";

import { brandColors } from "../../data/brand-colors";
import { hostConfigs } from "../../data/host-configs";
import type { PickerHost } from "../../utils/host-config";

const props = defineProps<{
  /** The catalog id of the primitive, such as `kv` or `rateLimit`. It adds the host picker. */
  feature?: FeatureId;
  /** The path of the file that opens first. */
  defaultValue?: string;
}>();
const slots = defineSlots<{ default?: () => VNode[] }>();
const framework = useFramework();

// A `::framework{name}` block is the node whose `name` prop is a framework. Content components resolve lazily, so the
// node type differs between the server and the browser and cannot tell. Code blocks have a `filename`, never a `name`.
function frameworkOf(node: VNode): Framework | undefined {
  const name: unknown = node.props?.name;
  return isFramework(name) ? name : undefined;
}

function slotNodes(node: VNode): VNode[] {
  const children: unknown = node.children;
  if (typeof children !== "object" || children === null || !("default" in children)) return [];
  const slot: unknown = children.default;
  return typeof slot === "function" ? slot() : [];
}

function flatten(nodes: VNode[], all = false): VNode[] {
  return nodes.flatMap((node) => {
    if (typeof node.type === "symbol" && Array.isArray(node.children)) return flatten(node.children as VNode[], all);
    const name = frameworkOf(node);
    if (name === undefined) return [node];
    return all || name === framework.value ? [node, ...flatten(slotNodes(node), all)] : [];
  });
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
const switchable = computed(() => flatten(slots.default?.() ?? [], true).some((node) => frameworkOf(node) !== undefined));
const selected = ref(files.value.find((file) => file.path === props.defaultValue)?.path ?? files.value[0]?.path ?? "");

// A framework switch keeps the open file when the other framework has a file with the same path.
watch(files, (next) => {
  if (!next.some((file) => file.path === selected.value)) selected.value = next[0]?.path ?? "";
});

// The tabs show file names, so two files with the same name also show their folder.
const items = computed(() => {
  const names = files.value.map((file) => file.path.split("/").at(-1));
  const shared = new Set(names.filter((name, index) => names.indexOf(name) !== index));
  return buildFileTree(files.value.map((file) => file.path)).flatMap((row) => {
    if (row.kind !== "file") return [];
    const parts = row.path.split("/");
    const folder = shared.has(row.name) && parts.length > 1 ? `${parts.at(-2)}/` : "";
    return [{ label: row.name, value: row.path, folder }];
  });
});

// Vercel and Deno have no brand color, so their marks take the text color.
const hostOptions: { color?: string; host: PickerHost; icon: string; label: string }[] = [
  { color: brandColors.node, host: "node", icon: "i-simple-icons-nodedotjs", label: "Node / Docker" },
  { color: brandColors.cloudflare, host: "cloudflare", icon: "i-simple-icons-cloudflare", label: "Cloudflare" },
  { host: "vercel", icon: "i-simple-icons-vercel", label: "Vercel" },
  { color: brandColors.netlify, host: "netlify", icon: "i-simple-icons-netlify", label: "Netlify" },
  { host: "deno", icon: "i-simple-icons-deno", label: "Deno" },
];

const rowTabs = useTemplateRef<ComponentPublicInstance>("rowTabs");
const configs = computed(() => (props.feature ? hostConfigs[props.feature] : undefined));
// The file written for a host. Its authored host is selected first, so the server renders the authored code.
const config = computed(() => {
  if (!configs.value) return undefined;
  const index = files.value.findIndex((file) => configHost(file.code));
  if (index === -1) return undefined;
  const file = files.value[index]!;
  return { code: file.code, host: configHost(file.code)!, index, path: file.path };
});
const pickedHost = ref<PickerHost>();
const host = computed(() => (config.value ? (pickedHost.value ?? config.value.host) : undefined));
const hostLabel = computed(() => hostOptions.find((option) => option.host === host.value)?.label ?? "");
const hostItems = computed(() =>
  hostOptions.map((option) => ({ ...option, supported: isSupported(option.host), value: option.host })),
);
const support = computed(() => (props.feature && host.value ? features[props.feature].hosts[host.value] : undefined));
// The catalog's short provider name, or its sentence when the name only repeats the host, such as Cloudflare Rate Limit.
const providerName = computed(() => {
  if (!support.value || support.value.level === "unsupported") return "";
  return support.value.display === hostLabel.value ? support.value.detail.replace(/\.$/, "") : support.value.display;
});

const rewrite = shallowRef<{ code: string; host: PickerHost; html: string; source: string }>();
// The rewrite must match both the host and the framework's source. Until it is highlighted, show the authored code.
const shownRewrite = computed(() => (rewrite.value?.host === host.value && rewrite.value?.source === config.value?.code ? rewrite.value : undefined));
let rewriteRequest = 0;
watch([host, config], async ([next]) => {
  const request = ++rewriteRequest;
  const source = config.value?.code;
  const code = config.value && configs.value && next && next !== config.value.host
    ? rewriteHostConfig(config.value.code, configs.value, next)
    : undefined;
  if (!code || !source) {
    rewrite.value = undefined;
    return;
  }
  const html = await highlightCodeLines(code, "ts", changedLines(source, code));
  if (request === rewriteRequest) rewrite.value = { code, host: next!, html, source };
});

function isSupported(option: PickerHost) {
  return Boolean(configs.value?.[option]);
}

// A host that changes the config also opens it, so the change is in view.
function pickHost(value: string | number) {
  const option = hostOptions.find((item) => item.host === value);
  if (!option) return;
  pickedHost.value = option.host;
  if (!config.value || !isSupported(option.host)) return;
  selected.value = config.value.path;
  revealConfigTab();
}

// A narrow tab row can hide the config tab past its edge, so the row scrolls to it. Only the row scrolls:
// `scrollIntoView()` would also scroll the page away from the host row.
function revealConfigTab() {
  const row: HTMLElement | undefined = rowTabs.value?.$el;
  const tab = config.value && row?.querySelector(`[data-path="${CSS.escape(config.value.path)}"]`)?.closest("[data-slot='trigger']");
  if (!row || !tab) return;
  const bounds = row.getBoundingClientRect();
  const box = tab.getBoundingClientRect();
  if (box.right > bounds.right) row.scrollLeft += box.right - bounds.right;
  else if (box.left < bounds.left) row.scrollLeft -= bounds.left - box.left;
}

// The changed-file dot makes the config tab wider once the rewrite shows.
watch(shownRewrite, revealConfigTab, { flush: "post" });

/** The catalog sentences quote code in backticks. Odd parts are code. */
function codeParts(text: string) {
  return text.split("`");
}

function pathNote(index: number) {
  if (!config.value) return "";
  if (index !== config.value.index) return "Same on every host";
  return shownRewrite.value ? `Changed for ${hostLabel.value}` : "";
}
</script>

<template>
  <div class="vh-files-frame">
    <div class="vh-files" :class="{ 'has-hosts': config }">
      <!-- Both tab lists render on the server. The container query shows one, so the layout never moves. -->
      <UTabs ref="rowTabs" v-model="selected" :items="items" :content="false" class="vh-files-tabs is-row items-start font-mono" aria-label="Example files">
        <template #leading="{ item }">
          <span class="vh-files-icon" aria-hidden="true"><ProseCodeIcon :filename="item.value" /></span>
        </template>
        <template #default="{ item }">
          <span :data-path="item.value"><span v-if="item.folder" class="text-dimmed">{{ item.folder }}</span>{{ item.label }}</span>
          <span v-if="shownRewrite && item.value === config?.path" class="vh-files-changed-dot" aria-hidden="true" />
        </template>
      </UTabs>
      <UTabs v-model="selected" :items="items" :content="false" orientation="vertical" class="vh-files-tabs is-column items-start font-mono" aria-label="Example files">
        <template #leading="{ item }">
          <span class="vh-files-icon" aria-hidden="true"><ProseCodeIcon :filename="item.value" /></span>
        </template>
        <template #default="{ item }">
          <span><span v-if="item.folder" class="text-dimmed">{{ item.folder }}</span>{{ item.label }}</span>
          <span v-if="shownRewrite && item.value === config?.path" class="vh-files-changed-dot" aria-hidden="true" />
        </template>
      </UTabs>

      <div
        v-for="(file, index) in files"
        v-show="selected === file.path"
        :key="file.path"
        role="tabpanel"
        class="vh-files-code"
        :aria-label="file.path"
      >
        <div class="vh-files-path">
          <span class="vh-files-path-name">{{ file.path }}</span>
          <span v-if="pathNote(index)" class="vh-files-path-note" :class="{ 'is-changed': index === config?.index }">{{ pathNote(index) }}</span>
          <FrameworkSwitch v-if="switchable" />
        </div>
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

      <!-- The host row matches the "Deploy on" row of the Agent playground. -->
      <div v-if="config" class="vh-files-hosts">
        <span class="vh-files-hosts-label">Deploy on</span>
        <div class="vh-files-host-tabs">
          <UTabs :model-value="host" :items="hostItems" :content="false" class="w-max min-w-full" aria-label="Deploy on" @update:model-value="pickHost">
            <template #leading="{ item }">
              <UIcon :name="item.icon" class="size-4 shrink-0" :class="{ 'vh-files-host-unsupported': !item.supported }" :style="{ color: item.color }" />
            </template>
            <template #default="{ item }">
              {{ item.label }}<span v-if="!item.supported" class="sr-only">, not supported</span>
            </template>
          </UTabs>
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
/* The panel width, not the viewport, decides where the tabs go. */
.vh-files-frame {
  container-type: inline-size;
}

/* One framed code panel: the file tabs, then the code under a header with its path, then the host row. */
.vh-files {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: auto minmax(0, 1fr) auto;
  overflow: hidden;
  border: 1px solid var(--ui-border);
  border-radius: calc(var(--ui-radius) * 2);
  background: var(--ui-bg);
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

.vh-files-tabs.is-column {
  display: none;
}

/* A row of many files scrolls instead of cutting the names. The padding keeps the list's bottom line in view. */
.vh-files-tabs.is-row {
  overflow-x: auto;
  padding-bottom: 1px;
  scrollbar-width: none;
}

.vh-files-tabs.is-row :deep([data-slot="list"]) {
  width: max-content;
  min-width: 100%;
}

.vh-files-tabs.is-row :deep([data-slot="trigger"]) {
  flex: none;
}

/* Wide panels: the tab column fits its longest name, so file names never truncate. The code takes the rest. */
@container (min-width: 44rem) {
  .vh-files {
    grid-template-columns: max-content minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr) auto;
  }

  .vh-files-tabs.is-row {
    display: none;
  }

  .vh-files-tabs.is-column {
    display: flex;
    min-width: 9rem;
    overflow: hidden auto;
    border-right: 1px solid var(--ui-border);
    padding: 0.5rem;
  }

  .vh-files-code {
    grid-area: 1 / 2;
  }

  .vh-files-hosts {
    grid-row: 2;
  }
}

.vh-files-code {
  position: relative;
  display: flex;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
}

.vh-files-path {
  display: flex;
  min-height: 2.5rem;
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  margin: 0;
  border-bottom: 1px solid var(--ui-border);
  padding-inline: 0.75rem 4.5rem;
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
  font-size: 0.75rem;
}

.vh-files-path-note.is-changed {
  color: var(--ui-text-muted);
}

/* The config tab shows a dot while its code is rewritten for another host, like a changed file in an editor. */
.vh-files-changed-dot {
  width: 0.375rem;
  height: 0.375rem;
  flex: none;
  margin-left: 0.375rem;
  border-radius: 999px;
  background: var(--ui-text-highlighted);
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
  background: transparent;
  padding: 0;
  font-size: 0.75rem;
  line-height: 1.85;
  white-space: pre;
}

.vh-files-body :deep(> div) {
  margin: 0;
}

/*
 * The panel names the file and frames the code, so comark-ui's code block drops its frame and its title.
 * `data-code-header` stops it from making room for its bar, and the bar, with Wrap and Copy, moves to the end of the
 * path row: the block is not positioned, so the bar is placed against the panel.
 */
.vh-files-body :deep(.ck) {
  position: static;
  margin: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
  padding: 0;
}

.vh-files-body :deep(.ck > .ck-bar) {
  top: 0;
  right: 0;
  bottom: auto;
  left: auto;
  width: max-content;
  height: 2.75rem;
  align-items: center;
  padding: 0 0.5rem;
}

.vh-files-body :deep(.ck-title) {
  display: none;
}

/* Lines that the host rewrite changed. The dark Shiki theme sets every span's background color with
   !important, so the mark is a background image. */
.vh-files-body :deep(.line.is-marked) {
  --vh-mark: color-mix(in srgb, var(--ui-text-highlighted) 8%, transparent);
  background-image: linear-gradient(var(--vh-mark), var(--vh-mark));
}

.vh-files-hosts {
  grid-column: 1 / -1;
  border-top: 1px solid var(--ui-border);
  background: color-mix(in srgb, var(--ui-bg-muted) 48%, transparent);
  padding: 0.45rem 0.65rem 0.55rem;
}

.vh-files-hosts-label {
  display: block;
  padding: 0 0.25rem 0.2rem;
  color: var(--ui-text-dimmed);
  font-size: 0.6rem;
  font-weight: 600;
  line-height: 1rem;
}

/* The tabs scroll sideways when the row is too narrow for every label. The padding keeps the underline inside. */
.vh-files-host-tabs {
  overflow-x: auto;
  padding-bottom: 1px;
  scrollbar-width: none;
}

/* A host without support stays in the row, muted. Picking it explains why. */
.vh-files-host-unsupported {
  opacity: 0.3;
  filter: grayscale(1);
}

.vh-files-host-status {
  margin: 0.4rem 0.25rem 0;
  color: var(--ui-text-muted);
  font-size: 0.75rem;
  line-height: 1.45;
  text-wrap: pretty;
}

.vh-files-host-status strong {
  color: var(--ui-text-highlighted);
  font-weight: 500;
}

.vh-files-host-status code {
  font-family: var(--font-mono);
  font-size: 0.75rem;
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

</style>
