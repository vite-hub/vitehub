<script setup lang="ts">
import { ref } from "vue";

const saved = ref(false);
const saves = ref(41);

function toggle() {
  saved.value = !saved.value;
  saves.value += saved.value ? 1 : -1;
}
</script>

<template>
  <div class="flex flex-wrap items-center gap-4">
    <UButton variant="outline" @click="toggle">
      <template #leading>
        <SwapIcon :name="saved ? 'i-lucide-check' : 'i-lucide-bookmark'" :enter="saved ? 'draw' : undefined" />
      </template>
      Save
    </UButton>
    <MorphText :text="saved ? 'Saved to your list' : 'Not saved'" class="text-sm text-muted" />
    <span class="text-sm text-muted"><RollNumber :value="saves" /> saves</span>
  </div>
</template>
