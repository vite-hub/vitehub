<script setup lang="ts">
import { shallowRef } from "vue";

const input = shallowRef("");
const submitted = shallowRef("");
const user = { id: "ana", name: "Ana Ruiz" };
</script>

<template>
  <div class="w-full max-w-sm space-y-3">
    <CommentComposer
      v-model="input"
      :user
      :autofocus="false"
      :guard="false"
      @submit="submitted = $event.body"
    />
    <p v-if="submitted" role="status" class="text-sm text-muted">
      Comment: {{ submitted }}
    </p>
  </div>
</template>
