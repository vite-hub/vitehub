<script setup lang="ts">
import { Kbd, KbdGroup } from "../kbd/index.ts";
</script>

<template>
  <div data-slot="example-kbd" style="display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem">
    <KbdGroup>
      <Kbd label="Ctrl" />
      <Kbd label="K" />
    </KbdGroup>
    <Kbd size="sm" label="Esc" />
  </div>
</template>
