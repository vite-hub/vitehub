<script setup lang="ts">
import { CommandShortcut as CommandShortcutPart } from "@ui-sdk/vue/command";
import type { CommandShortcutSlots } from "./types.ts";

defineSlots<CommandShortcutSlots>();
</script>

<template>
  <!-- Empty, it shows the item's `shortcut` in the keys of the platform. -->
  <CommandShortcutPart data-slot="command-shortcut"><slot /></CommandShortcutPart>
</template>
