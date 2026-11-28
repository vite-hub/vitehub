<script setup lang="ts">
import { Input } from "../input/index.ts";
import { ref } from "vue";

const name = ref("");
</script>

<template>
  <div data-slot="example-input" style="display: flex; flex-direction: column; gap: 0.75rem; max-width: 24rem">
    <Input v-model="name" aria-label="Project name" placeholder="my-app" />
    <Input size="sm" aria-label="Search" placeholder="Search" />
    <Input aria-label="Domain" default-value="app.example.com" invalid />
    <Input aria-label="Region" default-value="auto" disabled />
  </div>
</template>
