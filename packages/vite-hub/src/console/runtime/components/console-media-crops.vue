<script setup lang="ts">
import { computed, ref } from "vue";

import { consoleErrorMessage } from "../client/documents";
import { consoleAspectRatio, consoleCropName, consoleFocalCropPosition, consoleMediaAspects, consoleMediaUrl, consoleMediaVariantUrl } from "../client/media-library";
import { useConsoleToast } from "../client/toast";

import type { ConsoleMediaClient, ConsoleMediaFile } from "../client/media-library";

/**
 * Named crops of an image for art direction, such as `mobile` at 4:5 next to the original for wide screens. Each crop
 * cuts the original around the focal point, or serves an uploaded replacement: a separate image made for that size.
 * Sites ask for a crop with `?crop=<name>` on the served URL or `responsiveImage({ crops })`.
 */
const props = defineProps<{
  client: ConsoleMediaClient;
  disabled?: boolean;
  file: ConsoleMediaFile;
  served: string | null;
}>();

const emit = defineEmits<{ updated: [file: ConsoleMediaFile] }>();

const toast = useConsoleToast();
const crops = computed(() => Object.entries(props.file.crops ?? {}).map(([name, crop]) => ({ name, ...crop, ratio: consoleAspectRatio(crop.aspect) ?? 1 })));
const originalUrl = computed(() => props.file.url ?? consoleMediaUrl(props.served, props.file.pathname));
const busy = ref<string>();
const adding = ref(false);
const newName = ref("");
const newAspect = ref("4:5");
const customAspect = ref("");
const aspectItems = [...consoleMediaAspects.map(entry => ({ label: `${entry.aspect} · ${entry.label}`, value: entry.aspect })), { label: "Custom…", value: "custom" }];
const nameValue = computed(() => consoleCropName(newName.value));
const aspectValue = computed(() => (newAspect.value === "custom" ? customAspect.value.trim() : newAspect.value));
const nameTaken = computed(() => Boolean(nameValue.value && props.file.crops?.[nameValue.value]));
const canAdd = computed(() => Boolean(nameValue.value) && !nameTaken.value && Boolean(consoleAspectRatio(aspectValue.value)));
const inputs = ref<Record<string, HTMLInputElement | null>>({});

/**
 * A small variant of the crop from the serve route, which shows the replacement or the focal crop as sites get it.
 * Replacements live in Blob's reserved namespace, so only `?crop=` reaches them.
 */
function variant(crop: (typeof crops.value)[number]): string | undefined {
  if (!originalUrl.value) return undefined;
  return consoleMediaVariantUrl(originalUrl.value, { crop: crop.name, version: `${props.file.updatedAt}`, width: 256 });
}

async function run(name: string, action: () => Promise<ConsoleMediaFile>, failure: string): Promise<boolean> {
  busy.value = name;
  try {
    emit("updated", await action());
    return true;
  }
  catch (error) {
    toast.error(`${failure} ${consoleErrorMessage(error, "Try again.")}`);
    return false;
  }
  finally {
    busy.value = undefined;
  }
}

async function add(): Promise<void> {
  if (!canAdd.value) return;
  const name = nameValue.value;
  const added = await run(name, () => props.client.update(props.file.pathname, { crops: { [name]: { aspect: aspectValue.value } } }), "Couldn't add the crop.");
  if (!added) return;
  newName.value = "";
  adding.value = false;
  toast.show({ title: `Crop ${name} added` });
}

async function replace(name: string, event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  const done = await run(name, async () => (await props.client.upload(file, { crop: { name, pathname: props.file.pathname } })).file, "Couldn't upload the replacement.");
  if (done) toast.show({ title: `Replacement for ${name} uploaded` });
}

async function removeReplacement(name: string): Promise<void> {
  const done = await run(name, () => props.client.removeCropReplacement(props.file.pathname, name), "Couldn't remove the replacement.");
  if (done) toast.show({ title: `${name} crops the original again` });
}

async function remove(name: string): Promise<void> {
  const done = await run(name, () => props.client.update(props.file.pathname, { crops: { [name]: null } }), "Couldn't delete the crop.");
  if (done) toast.show({ title: `Crop ${name} deleted` });
}
</script>

<template>
  <div class="grid gap-2">
    <p v-if="!crops.length && !adding" class="text-xs text-muted">
      No crops. Add one for each layout that needs its own framing, such as <span class="font-mono">mobile</span> at 4:5.
    </p>
    <ul v-if="crops.length" class="grid gap-2">
      <li v-for="crop in crops" :key="crop.name" class="flex items-center gap-3 rounded-md border border-default p-2">
        <div class="h-14 shrink-0 overflow-hidden rounded-sm bg-elevated" :style="{ aspectRatio: String(crop.ratio), background: file.color }">
          <img
            v-if="variant(crop)"
            :src="variant(crop)"
            alt=""
            class="size-full object-cover"
            :style="crop.replacement ? undefined : { objectPosition: consoleFocalCropPosition(crop.focal ?? file.focal, file, crop.ratio) }"
          >
        </div>
        <div class="grid min-w-0 flex-1 gap-0.5">
          <p class="flex min-w-0 items-baseline gap-2">
            <span class="truncate font-mono text-xs text-highlighted">{{ crop.name }}</span>
            <span class="text-xs text-dimmed tabular-nums">{{ crop.aspect }}</span>
          </p>
          <p class="truncate text-xs text-muted">
            <template v-if="crop.replacement">
              Replacement<template v-if="crop.replacement.width"> · {{ crop.replacement.width }}×{{ crop.replacement.height }}</template>
            </template>
            <template v-else>From the focal point</template>
          </p>
        </div>
        <input
          :ref="(element) => { inputs[crop.name] = element as HTMLInputElement | null }"
          type="file"
          accept="image/jpeg,image/png,image/webp,image/avif"
          class="hidden"
          :aria-label="`Replacement image for ${crop.name}`"
          @change="replace(crop.name, $event)"
        >
        <UDropdownMenu
          :disabled="disabled"
          :content="{ align: 'end' }"
          :items="[
            [
              { label: crop.replacement ? 'Upload another replacement' : 'Upload replacement', icon: 'i-lucide-upload', onSelect: () => inputs[crop.name]?.click() },
              ...(crop.replacement ? [{ label: 'Use the focal point', icon: 'i-lucide-crosshair', onSelect: () => removeReplacement(crop.name) }] : []),
            ],
            [{ label: 'Delete crop', icon: 'i-lucide-trash-2', color: 'error' as const, onSelect: () => remove(crop.name) }],
          ]"
        >
          <UButton
            variant="ghost"
            size="xs"
            icon="i-lucide-ellipsis"
            :loading="busy === crop.name"
            :disabled="disabled"
            :aria-label="`Actions for crop ${crop.name}`"
          />
        </UDropdownMenu>
      </li>
    </ul>

    <form v-if="adding" class="grid gap-2 rounded-md border border-default p-2" @submit.prevent="add">
      <div class="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
        <UInput v-model="newName" size="sm" placeholder="mobile" aria-label="Crop name" autofocus :ui="{ base: 'font-mono text-xs' }" />
        <USelect v-model="newAspect" size="sm" class="w-36" :items="aspectItems" aria-label="Aspect ratio" />
      </div>
      <UInput v-if="newAspect === 'custom'" v-model="customAspect" size="sm" placeholder="3:2" aria-label="Custom aspect ratio" :ui="{ base: 'font-mono text-xs' }" />
      <p v-if="nameTaken" class="text-xs text-error">A crop named {{ nameValue }} exists.</p>
      <p v-else-if="newName && nameValue !== newName" class="text-xs text-dimmed">Saved as <span class="font-mono">{{ nameValue }}</span>.</p>
      <div class="flex justify-end gap-2">
        <UButton variant="ghost" size="xs" label="Cancel" @click="adding = false" />
        <UButton type="submit" size="xs" label="Add crop" :disabled="!canAdd" :loading="busy === nameValue" />
      </div>
    </form>
    <UButton v-else-if="!disabled" variant="outline" size="xs" icon="i-lucide-plus" label="Add crop" class="w-fit" @click="adding = true" />
  </div>
</template>
