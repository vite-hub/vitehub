<script setup lang="ts">
import { ref } from "vue";
import { useChoices } from "vite-hub/decisions/vue";

interface Selection {
  supplier: { exclude: string[]; include: string[] };
}

const suppliers = ["Acme", "Nordic Parts", "Vakuum AG"];
const selected = ref<Selection["supplier"]>({ exclude: [], include: [] });

// This stands in for your route. A real `resolve` sends the text to the server and returns its selection.
const input = useChoices<Selection>({
  onSelect: (selection) => {
    selected.value = selection.supplier;
  },
  async resolve(text, { signal }) {
    await new Promise((done) => setTimeout(done, 800));
    signal.throwIfAborted();
    if (/error/i.test(text)) throw new Error("The gateway timed out. Try again.");
    const [, rest = ""] = text.split(/except/i);
    const exclude = suppliers.filter((name) => rest.toLowerCase().includes(name.slice(0, 3).toLowerCase()));
    return { supplier: { exclude, include: suppliers.filter((name) => !exclude.includes(name)) } };
  },
});

const choices = {
  ...input,
  clear: () => {
    input.clear();
    selected.value = { exclude: [], include: [] };
  },
};
</script>

<template>
  <div class="w-full max-w-md space-y-3">
    <FilterSearch :choices="choices" label="Filter demand" placeholder="Try: suppliers except those starting with vak" />
    <div class="flex flex-wrap gap-2">
      <UBadge v-for="name in selected.include" :key="`in-${name}`" color="neutral" variant="subtle">{{ name }}</UBadge>
      <UBadge v-for="name in selected.exclude" :key="`out-${name}`" color="error" variant="subtle">not {{ name }}</UBadge>
    </div>
  </div>
</template>
