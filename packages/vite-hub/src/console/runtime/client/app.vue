<template>
  <UApp :toaster="null">
    <RouterView v-slot="{ Component }">
      <component :is="Component" v-if="Component" />
      <ConsoleLoading v-else />
    </RouterView>
  </UApp>
</template>

<script setup lang="ts">
import { RouterView } from "vue-router";
import ConsoleLoading from "../components/console-loading.vue";
</script>
