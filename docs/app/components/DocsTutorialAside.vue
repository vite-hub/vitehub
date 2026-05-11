<script setup lang="ts">
type ContentTocLink = {
  id: string;
  depth: number;
  text: string;
  children?: ContentTocLink[];
};

defineProps<{
  links?: ContentTocLink[];
}>();

const steps = [
  "Install packages",
  "Configure the runtime",
  "Create the Workspace Agent",
  "Connect Chat",
  "Run locally",
  "Deploy",
];
</script>

<template>
  <UContentToc
    :links="links || []"
    :open="true"
    default-open
    :ui="{
      root: '!mx-0 !px-0',
      container: 'pt-4 sm:pt-6 pb-2.5 sm:pb-4.5 lg:py-8 border-b border-dashed border-default lg:border-0 flex flex-col gap-6',
      top: 'flex flex-col gap-6',
      trailingIcon: 'hidden',
      bottom: 'flex flex-col',
    }"
  >
    <template #top>
      <div class="rounded-lg border border-default bg-muted/40 p-4">
        <p class="mb-3 text-sm font-semibold text-highlighted">
          Follow along
        </p>
        <ol class="space-y-2">
          <li
            v-for="(step, index) in steps"
            :key="step"
            class="flex items-center gap-2 text-sm text-muted"
          >
            <span class="flex size-5 shrink-0 items-center justify-center rounded-full border border-default bg-default text-[11px] font-medium text-toned">
              {{ index + 1 }}
            </span>
            <span>{{ step }}</span>
          </li>
        </ol>
      </div>
    </template>

    <template #bottom>
      <DocsAsideRightBottom />
    </template>
  </UContentToc>
</template>
