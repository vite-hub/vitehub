<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { computed } from "vue";
import { ChevronRightIcon, LoaderCircleIcon, WrenchIcon } from "@lucide/vue";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@ui-sdk/vue/collapsible";
import { badgeVariants } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { ToolCallState } from "./states";
import { toolCallStates } from "./states";

const props = defineProps<{
  name: string;
  state: ToolCallState;
  input?: unknown;
  output?: unknown;
  errorText?: string;
  defaultOpen?: boolean;
  class?: HTMLAttributes["class"];
}>();

const status = computed(() => toolCallStates[props.state]);
const working = computed(() => props.state === "input-streaming" || props.state === "input-available");
const format = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value, null, 2));
</script>

<template>
  <Collapsible
    :data-tool-state="props.state"
    :default-open="props.defaultOpen ?? props.state === 'approval-requested'"
    :class="cn('group/tool w-full min-w-0 overflow-hidden rounded-lg border text-sm', props.class)"
  >
    <CollapsibleTrigger data-focus-inset="" class="flex w-full cursor-pointer items-center gap-2 bg-transparent px-3 py-2 text-start hover:bg-accent/60">
      <WrenchIcon aria-hidden="true" class="size-4 shrink-0 text-muted-foreground" />
      <span class="min-w-0 truncate font-mono text-[0.8125rem]">{{ props.name }}</span>
      <span :class="cn(badgeVariants({ variant: status.tone }), 'ms-auto')">
        <LoaderCircleIcon v-if="working" aria-hidden="true" class="animate-spin motion-reduce:animate-none" />
        {{ status.label }}
      </span>
      <ChevronRightIcon aria-hidden="true" class="size-4 shrink-0 text-muted-foreground transition-transform duration-200 ease-out group-data-open/tool:rotate-90 motion-reduce:transition-none rtl:rotate-180" />
    </CollapsibleTrigger>
    <CollapsiblePanel class="border-t">
      <div class="flex flex-col gap-3 p-3">
        <section v-if="props.input !== undefined" class="flex flex-col gap-1.5">
          <h4 class="m-0 text-xs font-medium text-muted-foreground">Input</h4>
          <pre class="m-0 max-h-64 overflow-auto rounded-md bg-muted p-2.5 font-mono text-xs leading-5 whitespace-pre-wrap break-words">{{ format(props.input) }}</pre>
        </section>
        <section v-if="props.errorText" class="flex flex-col gap-1.5">
          <h4 class="m-0 text-xs font-medium text-muted-foreground">Error</h4>
          <p class="m-0 text-sm text-vh-text-error">{{ props.errorText }}</p>
        </section>
        <section v-else-if="props.output !== undefined" class="flex flex-col gap-1.5">
          <h4 class="m-0 text-xs font-medium text-muted-foreground">Output</h4>
          <pre class="m-0 max-h-64 overflow-auto rounded-md bg-muted p-2.5 font-mono text-xs leading-5 whitespace-pre-wrap break-words">{{ format(props.output) }}</pre>
        </section>
        <slot />
      </div>
    </CollapsiblePanel>
  </Collapsible>
</template>
