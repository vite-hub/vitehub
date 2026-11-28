<script setup lang="ts">
import type { PromptInputToolbarSlots } from "./types.ts";

defineSlots<PromptInputToolbarSlots>();
</script>

<template>
  <div data-slot="prompt-input-toolbar"><slot /></div>
</template>
