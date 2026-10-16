<script setup lang="ts">
import { useRoute } from "vue-router";

import { resolveConsoleRouteName } from "../console-route";
import { consoleSectionDetails } from "../sections";

/**
 * The media library page of a section. Blob media records do not exist yet, so the page says where uploaded files live
 * and links to the Blob section when the user may open it.
 */
defineProps<{
  /** The signed-in user may open the Blob section. */
  blobAllowed: boolean;
  label: string;
}>();

const route = useRoute();
</script>

<template>
  <UDashboardNavbar :ui="{ root: 'border-b border-default' }" :toggle="{ 'aria-label': 'Open section navigation' }">
    <template #title>
      <span class="truncate text-sm font-semibold text-highlighted">{{ label }}</span>
    </template>
  </UDashboardNavbar>
  <UEmpty
    class="min-h-0 flex-1"
    variant="naked"
    icon="i-lucide-image"
    title="No media library yet"
    :description="blobAllowed
      ? 'Files that documents reference live in Blob. Browse them there until the library can upload, describe, and crop media.'
      : 'Files that documents reference live in Blob. Ask an admin for the Blob section to browse them.'"
    :actions="blobAllowed ? [{ label: 'Open Blob', color: 'neutral', variant: 'outline', trailingIcon: 'i-lucide-arrow-right', to: { name: resolveConsoleRouteName(route.name, consoleSectionDetails.blob.routeName) } }] : []"
  />
</template>
