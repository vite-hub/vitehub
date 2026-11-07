<script setup lang="ts">
const people = [
  { color: "#E11D48", id: "ana", name: "Ana Ruiz" },
  { color: "#2563EB", id: "ben", name: "Ben Ito" },
  { color: "#059669", id: "cleo", name: "Cleo Park" },
  { color: "#7C3AED", id: "dev", name: "Dev Shah" },
];
</script>

<template>
  <div class="flex items-center gap-6">
    <AvatarStack :people="people" size="sm" />
    <AvatarStack :people="people" />
    <AvatarStack :people="people" size="lg" />
  </div>
</template>
