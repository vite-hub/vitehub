<script setup lang="ts">
import type { CommentComposerSubmit } from "@vite-hub/ui";
import { shallowRef } from "vue";

const input = shallowRef("");
const mentions = shallowRef<string[]>([]);
const files = shallowRef<File[]>([]);
const submitted = shallowRef<CommentComposerSubmit>();
const user = { id: "ana", name: "Ana Ruiz" };
const people = [user, { id: "ben", name: "Ben Soto" }, { id: "sofia", name: "Sofía Benítez" }];

function send(submit: CommentComposerSubmit) {
  submitted.value = submit;
  input.value = "";
  mentions.value = [];
  files.value = [];
}
</script>

<template>
  <div class="w-full max-w-sm space-y-3">
    <CommentComposer
      v-model="input"
      v-model:mentions="mentions"
      v-model:files="files"
      :user
      :people
      :autofocus="false"
      :guard="false"
      placeholder="Type @ to mention someone"
      @submit="send"
    />
    <p v-if="submitted" role="status" class="text-sm text-muted">
      Comment: {{ submitted.body }} ({{ submitted.mentions.length }} mentioned, {{ submitted.files.length }} files)
    </p>
  </div>
</template>
