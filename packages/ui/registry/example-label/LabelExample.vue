<script setup lang="ts">
import { Label } from "../label/index.ts";
import { Input } from "../input/index.ts";
</script>

<template>
  <div data-slot="example-label" style="display: flex; flex-direction: column; gap: 0.75rem; max-width: 24rem">
    <Label for="example-label-email" label="Email" />
    <Input id="example-label-email" type="email" placeholder="you@example.com" />
  </div>
</template>
