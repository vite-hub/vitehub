<script setup lang="ts">
import type { DropdownMenuShortcutSlots } from "./types.ts";

defineSlots<DropdownMenuShortcutSlots>();
</script>

<template>
  <span data-slot="dropdown-menu-shortcut" aria-hidden="true"><slot /></span>
</template>
