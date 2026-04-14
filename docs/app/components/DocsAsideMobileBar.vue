<script setup lang="ts">
import { ref } from "vue";
import { useAppConfig } from "#imports";
import { useDocsNavigation } from "~/composables/useDocsNavigation";
import { useFrameworkPreference } from "~/composables/useFrameworkPreference";

type ContentTocLink = {
  id: string;
  depth: number;
  text: string;
  children?: ContentTocLink[];
};

defineProps<{
  links?: ContentTocLink[];
}>();

const appConfig = useAppConfig() as { toc?: { title?: string } };
const { activeSection, sidebarNavigation } = useDocsNavigation();
const { current } = useFrameworkPreference();

const menuDrawerOpen = ref(false);
const tocDrawerOpen = ref(false);
</script>

<template>
  <div class="sticky top-(--ui-header-height) z-10 -mx-4 flex justify-between border-b border-dashed border-default bg-default/75 p-2 backdrop-blur lg:hidden">
    <UDrawer
      v-model:open="menuDrawerOpen"
      direction="left"
      :title="activeSection?.title || 'Docs'"
      :handle="false"
      inset
      side="left"
      :ui="{ content: 'w-full max-w-2/3' }"
    >
      <UButton
        label="Menu"
        icon="i-lucide-text-align-start"
        color="neutral"
        variant="link"
        size="xs"
        aria-label="Menu"
      />

      <template #body>
        <UContentNavigation
          :key="current"
          :navigation="sidebarNavigation"
          default-open
          trailing-icon="i-lucide-chevron-right"
          :ui="{ linkTrailingIcon: 'group-data-[state=open]:rotate-90' }"
          highlight
        />
      </template>
    </UDrawer>

    <UDrawer
      v-model:open="tocDrawerOpen"
      direction="right"
      :handle="false"
      inset
      side="right"
      no-body-styles
      :ui="{ content: 'w-full max-w-2/3' }"
    >
      <UButton
        :label="appConfig.toc?.title || 'On this page'"
        trailing-icon="i-lucide-chevron-right"
        color="neutral"
        variant="link"
        size="xs"
        :aria-label="appConfig.toc?.title || 'On this page'"
      />

      <template #body>
        <UContentToc
          v-if="links?.length"
          :links="links"
          :open="true"
          default-open
          :ui="{
            root: '!mx-0 !px-1 top-0 overflow-visible',
            container: '!pt-0 border-b-0',
            trailingIcon: 'hidden',
            bottom: 'flex flex-col',
          }"
        >
          <template #bottom>
            <DocsAsideRightBottom />
          </template>
        </UContentToc>
      </template>
    </UDrawer>
  </div>
</template>
