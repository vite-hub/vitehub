<script setup lang="ts">
import { Toaster, toast } from "../toast/index.ts";
import { Button } from "../button/index.ts";

function show() {
  toast("Deployed", { description: "app.example.com is live.", action: { label: "Open", onAction: () => {} } });
}
</script>

<template>
  <div data-slot="example-toast" style="display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem">
    <Button label="Show a toast" @click="show" />
    <Toaster />
  </div>
</template>
