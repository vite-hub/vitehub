<script setup lang="ts">
import { Icon } from "../icon/index.ts";
import { Rocket } from "@lucide/vue";
</script>

<template>
  <div data-slot="example-icon" style="display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem">
    <Icon size="xs"><Rocket /></Icon>
    <Icon size="sm"><Rocket /></Icon>
    <Icon><Rocket /></Icon>
    <Icon size="lg" label="Deployed"><Rocket /></Icon>
  </div>
</template>
