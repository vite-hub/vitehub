<script setup lang="ts">
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@ui-sdk/vue/menu"
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
