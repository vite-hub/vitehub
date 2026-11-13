<script setup lang="ts">
import { Switch, SwitchThumb } from "@vite-hub/kit/switch"
</script>

<template>
  <label data-slot="label">
    Airplane mode
    <Switch>
      <SwitchThumb />
    </Switch>
  </label>
</template>
