<script setup lang="ts">
import { Avatar, AvatarFallback, AvatarImage } from "../avatar/index.ts";
</script>

<template>
  <div data-slot="example-avatar" style="display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem">
    <Avatar src="https://github.com/vite-hub.png" alt="ViteHub" fallback="VH" />
    <Avatar size="sm" fallback="AB" />
    <Avatar size="lg">
      <AvatarImage src="https://example.invalid/missing.png" alt="Missing image" />
      <AvatarFallback>MI</AvatarFallback>
    </Avatar>
  </div>
</template>
