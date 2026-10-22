<script setup lang="ts">
import { computed, ref, watch } from "vue";

import { consoleErrorMessage } from "../client/documents";
import { consoleFolderName } from "../client/media-library";

import type { ConsoleMediaClient } from "../client/media-library";

/**
 * Chooses a destination folder, and a new name when one file or folder moves. The tree loads each level when it opens.
 * A folder cannot move into itself.
 */
const props = defineProps<{
  client: ConsoleMediaClient;
  /** The folder that holds what moves, opened and selected at first. */
  folder: string;
  /** A folder that moves, which the tree leaves out with everything inside it. */
  moving?: string;
  /** The current name when one file or folder moves. */
  name?: string;
  title: string;
  /** Uses (warns) before the move, such as `Used in 2 documents. Their links will break.` */
  warning?: string;
}>();

const emit = defineEmits<{ confirm: [destination: { folder: string, name?: string }] }>();
const open = defineModel<boolean>("open", { required: true });

interface Node { depth: number, path: string }
const children = ref<Record<string, string[]>>({});
const expanded = ref(new Set<string>([""]));
const loading = ref(new Set<string>());
const selected = ref(props.folder);
const name = ref(props.name ?? "");
const error = ref<string>();
const busy = ref(false);

async function load(path: string): Promise<void> {
  if (children.value[path] || loading.value.has(path)) return;
  loading.value = new Set(loading.value).add(path);
  try {
    const listing = await props.client.list({ folder: path });
    children.value = { ...children.value, [path]: listing.folders.filter(folder => folder !== props.moving) };
  }
  catch (requestError) {
    error.value = consoleErrorMessage(requestError, "Couldn't load the folders.");
  }
  finally {
    const next = new Set(loading.value);
    next.delete(path);
    loading.value = next;
  }
}

watch(open, async (value) => {
  if (!value) return;
  selected.value = props.folder;
  name.value = props.name ?? "";
  error.value = undefined;
  busy.value = false;
  children.value = {};
  // Open the path down to the current folder.
  const parts = props.folder.split("/").filter(Boolean);
  const trail = ["", ...parts.map((_part, index) => parts.slice(0, index + 1).join("/"))];
  expanded.value = new Set(trail);
  await Promise.all(trail.map(load));
}, { immediate: true });

const nodes = computed<Node[]>(() => {
  const list: Node[] = [{ depth: 0, path: "" }];
  const walk = (path: string, depth: number) => {
    if (!expanded.value.has(path)) return;
    for (const child of children.value[path] ?? []) {
      list.push({ depth, path: child });
      walk(child, depth + 1);
    }
  };
  walk("", 1);
  return list;
});

function toggle(path: string): void {
  const next = new Set(expanded.value);
  if (next.has(path)) next.delete(path);
  else {
    next.add(path);
    void load(path);
  }
  expanded.value = next;
}

const unchanged = computed(() => selected.value === props.folder && (props.name === undefined || name.value.trim() === props.name));

function confirm(): void {
  if (unchanged.value || (props.name !== undefined && !name.value.trim())) return;
  busy.value = true;
  emit("confirm", props.name === undefined ? { folder: selected.value } : { folder: selected.value, name: name.value.trim() });
}

defineExpose({
  /** Ends the busy state after a failed move, so the person can try another destination. */
  failed(message: string) {
    busy.value = false;
    error.value = message;
  },
});
</script>

<template>
  <UModal v-model:open="open" :title="title" :ui="{ content: 'sm:max-w-[440px]' }">
    <template #body>
      <form id="vitehub-media-move" class="grid gap-3" @submit.prevent="confirm">
        <UFormField v-if="props.name !== undefined" label="Name" :ui="{ label: 'text-xs' }">
          <UInput v-model="name" class="w-full" :ui="{ base: 'font-mono text-[13px]' }" autocomplete="off" autofocus />
        </UFormField>
        <div class="grid gap-1">
          <span class="text-xs text-muted">Folder</span>
          <div class="max-h-72 overflow-y-auto rounded-md border border-default p-1" role="tree" aria-label="Destination folder">
            <div
              v-for="node in nodes"
              :key="node.path || '/'"
              role="treeitem"
              :aria-selected="selected === node.path"
              :aria-expanded="node.path === '' ? true : expanded.has(node.path)"
              class="flex h-8 cursor-default items-center gap-1 rounded-md pe-2 text-[13px]"
              :class="selected === node.path ? 'bg-accented text-highlighted' : 'text-muted hover:bg-elevated hover:text-highlighted'"
              :style="{ paddingInlineStart: `${node.depth * 1}rem` }"
              @click="selected = node.path"
            >
              <UButton
                v-if="node.path"
                variant="link"
                size="xs"
                class="p-0.5 text-dimmed"
                :icon="loading.has(node.path) ? 'i-lucide-loader-circle' : expanded.has(node.path) ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
                :aria-label="expanded.has(node.path) ? `Collapse ${consoleFolderName(node.path)}` : `Expand ${consoleFolderName(node.path)}`"
                @click.stop="toggle(node.path)"
              />
              <span v-else class="w-1" />
              <UIcon :name="node.path ? 'i-lucide-folder' : 'i-lucide-images'" class="size-4 shrink-0 opacity-70" aria-hidden="true" />
              <span class="truncate">{{ consoleFolderName(node.path) }}</span>
              <span v-if="node.path === folder" class="ms-auto shrink-0 text-xs text-dimmed">Current</span>
            </div>
          </div>
        </div>
        <p v-if="warning" class="flex gap-2 rounded-md bg-elevated/60 px-3 py-2 text-xs text-muted">
          <UIcon name="i-lucide-triangle-alert" class="mt-px size-3.5 shrink-0 text-warning" aria-hidden="true" />
          <span>{{ warning }}</span>
        </p>
        <p v-if="error" class="text-xs text-error">{{ error }}</p>
      </form>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton variant="ghost" label="Cancel" @click="open = false" />
        <UButton type="submit" form="vitehub-media-move" :label="props.name !== undefined && selected === folder ? 'Rename' : 'Move'" :disabled="unchanged" :loading="busy" />
      </div>
    </template>
  </UModal>
</template>
