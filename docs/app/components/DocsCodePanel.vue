<script setup lang="ts">
// The sticky code panel beside a tutorial. It reads the code blocks of the article body in order.
// While the reader scrolls, the tree lists every file seen so far and the panel shows the file being read.
// Shell blocks (`bash`, or a `commands/` name) are steps to run, not project files, so the panel skips them.
// On wide screens each file block in the prose shrinks to its name bar, which opens the file in the panel.
const props = defineProps<{
  /** The rendered article body that holds the code blocks. */
  body: HTMLElement | null | undefined;
}>();

type Block = { path: string; wrapper: HTMLElement; pre: HTMLPreElement };

const blocks = shallowRef<Block[]>([]);
const reached = ref(0);
const selectedPath = ref<string>();
const code = useTemplateRef<HTMLElement>("code");

function filenameFor(pre: HTMLPreElement): string {
  return (pre.dataset.filename ?? pre.dataset.codeFilename ?? "").trim();
}

function collectBlocks(body: HTMLElement): Block[] {
  return [...body.querySelectorAll<HTMLPreElement>("pre")].flatMap((pre) => {
    const wrapper = pre.closest<HTMLElement>(".code-block-wrapper") ?? pre.parentElement;
    const path = filenameFor(pre);
    const isShell = /\blanguage-(bash|sh|shell|zsh)\b/.test(pre.className) || path.startsWith("commands/");
    return wrapper && path && !isShell ? [{ path, wrapper, pre }] : [];
  });
}

// The file being read is the last block whose top crossed 40% of the viewport. Before the first one, it is the first block.
function updateReached() {
  const line = window.innerHeight * 0.4;
  let index = 0;
  blocks.value.forEach((block, position) => {
    if (block.wrapper.getBoundingClientRect().top < line) index = position;
  });
  if (index !== reached.value || !selectedPath.value) {
    reached.value = index;
    selectedPath.value = blocks.value[index]?.path;
  }
}

// One entry per path, in order of first appearance. A later block with the same path replaces the earlier code.
const seenFiles = computed(() => {
  const latest = new Map<string, Block>();
  for (const block of blocks.value.slice(0, reached.value + 1)) latest.set(block.path, block);
  return [...latest.values()];
});
const rows = computed(() => buildFileTree(seenFiles.value.map((file) => file.path)));
const selected = computed(() => seenFiles.value.find((file) => file.path === selectedPath.value));

// The panel reuses the highlighted markup the article already rendered, so both copies look the same.
watch([selected, code], ([file, container]) => {
  if (!container) return;
  container.replaceChildren(...(file ? [file.pre.cloneNode(true)] : []));
  container.scrollTop = 0;
}, { flush: "post" });

let frame = 0;
let rescanTimer = 0;
let observer: MutationObserver | undefined;
function onScroll() {
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(updateReached);
}

function selectBlock(index: number) {
  reached.value = Math.max(reached.value, index);
  selectedPath.value = blocks.value[index]?.path;
}

// Each source block gets a class for the wide-screen styles and a click on its name bar.
const releases: (() => void)[] = [];
function releaseSources() {
  for (const release of releases.splice(0)) release();
}
function markSources(list: Block[]) {
  list.forEach((block, index) => {
    // Filename metadata lives on the `<pre>` for collection, but that node is
    // hidden on wide screens. Bind the selection handler to the visible header
    // sibling instead of the hidden code element.
    const bar = [...block.wrapper.children].find(
      (child) => child !== block.pre && !child.matches("button"),
    ) as HTMLElement | undefined;
    const onClick = () => selectBlock(index);
    block.wrapper.classList.add("vh-code-panel-source");
    bar?.addEventListener("click", onClick);
    releases.push(() => {
      block.wrapper.classList.remove("vh-code-panel-source", "is-active");
      bar?.removeEventListener("click", onClick);
    });
  });
}

function scan(body: HTMLElement | null | undefined) {
  releaseSources();
  blocks.value = body ? collectBlocks(body) : [];
  reached.value = 0;
  selectedPath.value = blocks.value[0]?.path;
  markSources(blocks.value);
  if (body) updateReached();
}

watch(() => props.body, (body) => {
  observer?.disconnect();
  scan(body);
  if (!body) return;
  observer = new MutationObserver(() => {
    window.clearTimeout(rescanTimer);
    rescanTimer = window.setTimeout(() => scan(body), 0);
  });
  observer.observe(body, { childList: true, subtree: true });
}, { immediate: true, flush: "post" });

watch(selectedPath, (path) => {
  for (const block of blocks.value) block.wrapper.classList.toggle("is-active", block.path === path);
}, { flush: "post" });

onMounted(() => window.addEventListener("scroll", onScroll, { passive: true }));
onBeforeUnmount(() => {
  window.removeEventListener("scroll", onScroll);
  cancelAnimationFrame(frame);
  window.clearTimeout(rescanTimer);
  observer?.disconnect();
  releaseSources();
});
</script>

<template>
  <aside v-if="blocks.length" class="vh-code-panel" aria-label="Files in this tutorial">
    <nav class="vh-code-panel-tree" aria-label="Files so far">
      <template v-for="row in rows" :key="row.path">
        <div v-if="row.kind === 'folder'" class="vh-code-panel-row is-folder" :style="{ '--depth': row.depth }">
          <UIcon name="i-lucide-folder-open" class="size-3.5 shrink-0" aria-hidden="true" />
          <span>{{ row.name }}</span>
        </div>
        <button
          v-else
          type="button"
          class="vh-code-panel-row is-file"
          :class="{ 'is-active': row.path === selectedPath }"
          :style="{ '--depth': row.depth }"
          :aria-current="row.path === selectedPath ? 'true' : undefined"
          :aria-label="row.path"
          @click="selectedPath = row.path"
        >
          <UIcon name="i-lucide-file" class="size-3.5 shrink-0" aria-hidden="true" />
          <span>{{ row.name }}</span>
        </button>
      </template>
    </nav>

    <div class="vh-code-panel-file">
      <p class="vh-code-panel-path">{{ selected?.path }}</p>
      <div ref="code" class="vh-code-panel-code" />
    </div>
  </aside>
</template>

<style scoped>
/* The panel fills the right half and stays in view, like an editor beside the tutorial. Narrow screens keep the code inline. */
.vh-code-panel {
  position: sticky;
  top: var(--ui-header-height);
  display: none;
  height: calc(100dvh - var(--ui-header-height));
  grid-template-columns: max-content minmax(0, 1fr);
  border-left: 1px solid var(--ui-border);
  background: var(--ui-bg);
}

@media (min-width: 80rem) {
  .vh-code-panel {
    display: grid;
  }
}

.vh-code-panel-tree {
  display: flex;
  min-width: 10rem;
  flex-direction: column;
  overflow-y: auto;
  border-right: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
  padding: 0.5rem 0.375rem;
  font-family: var(--font-mono);
  font-size: 0.75rem;
  white-space: nowrap;
}

.vh-code-panel-row {
  display: flex;
  min-height: 1.75rem;
  align-items: center;
  gap: 0.4375rem;
  border-radius: var(--ui-radius);
  padding-inline: calc(0.375rem + var(--depth) * 0.75rem) 0.5rem;
  color: var(--ui-text-muted);
  text-align: start;
}

.vh-code-panel-row.is-folder {
  color: var(--ui-text-dimmed);
}

.vh-code-panel-row.is-file {
  cursor: pointer;
  transition:
    background-color 150ms ease,
    color 150ms ease;
}

.vh-code-panel-row.is-file:hover {
  color: var(--ui-text-highlighted);
}

.vh-code-panel-row.is-file.is-active {
  background: color-mix(in srgb, var(--ui-text-highlighted) 7%, transparent);
  color: var(--ui-text-highlighted);
}

.vh-code-panel-row.is-file:focus-visible {
  outline: 2px solid var(--ui-text-highlighted);
  outline-offset: -2px;
}

.vh-code-panel-file {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
}

.vh-code-panel-path {
  display: flex;
  min-height: 2.75rem;
  flex: none;
  align-items: center;
  margin: 0;
  border-bottom: 1px solid var(--ui-border);
  padding-inline: 1rem;
  color: var(--ui-text-dimmed);
  font-family: var(--font-mono);
  font-size: 0.75rem;
}

.vh-code-panel-code {
  min-height: 0;
  flex: 1;
  overflow: auto;
  overscroll-behavior: contain;
  padding: 1rem;
}

.vh-code-panel-code :deep(pre) {
  margin: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  padding: 0;
  font-size: 0.75rem;
  line-height: 1.85;
  /* Long lines wrap instead of scrolling sideways, so the whole file stays readable in half the page. */
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>

<!-- The source blocks live in the article, outside this component, so these rules are global. They apply only where the panel shows. -->
<style>
@media (min-width: 80rem) {
  .vh-code-panel-source > pre,
  .vh-code-panel-source > button {
    display: none;
  }

  .vh-code-panel-source > :first-child {
    border-bottom-width: 1px;
    cursor: pointer;
    transition:
      background-color 150ms ease,
      color 150ms ease;
  }

  .vh-code-panel-source > :first-child:hover,
  .vh-code-panel-source.is-active > :first-child {
    background: color-mix(in srgb, var(--ui-text-highlighted) 5%, var(--ui-bg));
    color: var(--ui-text-highlighted);
  }
}
</style>
