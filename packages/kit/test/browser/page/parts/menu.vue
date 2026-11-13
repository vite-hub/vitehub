<script setup lang="ts">
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@vite-hub/kit/menu"
</script>

<template>
  <Menu>
    <MenuTrigger>Actions</MenuTrigger>
    <MenuContent>
      <MenuItem value="rename">Rename</MenuItem>
      <MenuItem value="duplicate">Duplicate</MenuItem>
    </MenuContent>
  </Menu>
</template>
