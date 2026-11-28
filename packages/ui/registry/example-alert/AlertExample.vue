<script setup lang="ts">
import { Alert, AlertActions, AlertClose, AlertContent, AlertDescription, AlertTitle } from "../alert/index.ts";
import { Button } from "../button/index.ts";
</script>

<template>
  <div data-slot="example-alert" style="display: flex; flex-direction: column; gap: 0.75rem; max-width: 24rem">
    <Alert tone="info">
      <AlertContent>
        <AlertTitle>A new version is out</AlertTitle>
        <AlertDescription>ViteHub 0.7 adds the registry.</AlertDescription>
      </AlertContent>
    </Alert>
    <Alert tone="error" variant="outline">
      <AlertContent>
        <AlertTitle>The deploy failed</AlertTitle>
        <AlertDescription>The build step exited with code 1.</AlertDescription>
        <AlertActions><Button size="xs" label="Open logs" /></AlertActions>
      </AlertContent>
      <AlertClose />
    </Alert>
  </div>
</template>
