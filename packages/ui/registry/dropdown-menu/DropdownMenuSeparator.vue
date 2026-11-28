<script setup lang="ts">
import { MenuSeparator } from "@ui-sdk/vue/menu";
</script>

<template>
  <MenuSeparator>
    <template #render="{ props: part }">
      <div v-bind="part" data-slot="dropdown-menu-separator" />
    </template>
  </MenuSeparator>
</template>
