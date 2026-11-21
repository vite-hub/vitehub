<script setup lang="ts">
import { Button } from "@ui-sdk/vue/button"
import { SettingsIcon } from "../icons"
</script>

<template>
  <div data-slot="row">
    <Button aria-label="Filter sessions, 2 active">
      <span data-slot="vh-chip"><SettingsIcon aria-hidden="true" /><span data-slot="vh-chip-indicator" /></span>
    </Button>
    <Button aria-label="Filter sessions">
      <span data-slot="vh-chip"><SettingsIcon aria-hidden="true" /></span>
    </Button>
  </div>
</template>
