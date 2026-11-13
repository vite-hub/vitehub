<script setup lang="ts">
import {
  Select,
  SelectContent,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@vite-hub/kit/select"
</script>

<template>
  <Select default-open placeholder="Select a role">
    <SelectLabel>Role</SelectLabel>
    <SelectTrigger>
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      <SelectItem value="viewer">Viewer</SelectItem>
      <SelectItem value="editor">Editor</SelectItem>
    </SelectContent>
  </Select>
</template>
