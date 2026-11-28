<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { Markdown } from "@comark/vue";
import { cn } from "@/lib/utils";

const props = defineProps<{ value: string; streaming?: boolean; class?: HTMLAttributes["class"] }>();
</script>

<template>
  <div
    data-slot="message-markdown"
    :class="cn(
      'min-w-0 text-sm leading-6 break-words',
      '[&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_p]:my-3 [&_ul]:my-3 [&_ul]:list-disc [&_ul]:ps-5 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:ps-5 [&_li]:my-1',
      '[&_h1]:mt-6 [&_h1]:mb-3 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:mt-6 [&_h2]:mb-3 [&_h2]:text-base [&_h2]:font-semibold [&_h3]:mt-4 [&_h3]:mb-2 [&_h3]:font-semibold',
      '[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 [&_strong]:font-semibold [&_blockquote]:border-s-2 [&_blockquote]:ps-3 [&_blockquote]:text-muted-foreground [&_hr]:my-4 [&_hr]:border-border',
      '[&_:not(pre)>code]:rounded-sm [&_:not(pre)>code]:bg-muted [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:py-0.5 [&_:not(pre)>code]:font-mono [&_:not(pre)>code]:text-[0.8125rem]',
      '[&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-muted [&_pre]:p-3 [&_pre]:font-mono [&_pre]:text-[0.8125rem] [&_pre]:leading-5',
      '[&_table]:my-3 [&_table]:w-full [&_table]:text-left [&_table]:tabular-nums [&_th]:border-b [&_th]:px-2 [&_th]:py-1.5 [&_th]:font-medium [&_td]:border-b [&_td]:px-2 [&_td]:py-1.5',
      props.class,
    )"
  >
    <Markdown :value="props.value" :streaming="props.streaming" :caret="props.streaming ? { class: 'ms-0.5 inline-block h-4 w-1.5 translate-y-0.5 animate-pulse rounded-xs bg-foreground motion-reduce:animate-none' } : false" />
  </div>
</template>
