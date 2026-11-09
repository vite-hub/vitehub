<script setup lang="ts">
const people = [
  { color: "#E11D48", id: "ana", name: "Ana Ruiz" },
  { color: "#2563EB", id: "ben", name: "Ben Ito" },
  { color: "#059669", id: "cleo", name: "Cleo Park" },
  { color: "#7C3AED", id: "dev", name: "Dev Shah" },
  { color: "#D97706", id: "eli", name: "Eli Moss" },
];
</script>

<template>
  <div class="flex items-center gap-3">
    <AvatarStack :people="people" />
    <span class="text-sm text-muted">5 people are editing</span>
  </div>
</template>
