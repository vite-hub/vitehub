<script setup lang="ts">
const people = [
  { color: "#E11D48", id: "ana", name: "Ana Ruiz" },
  { color: "#2563EB", id: "ben", name: "Ben Ito" },
  { color: "#059669", id: "cleo", name: "Cleo Park" },
];
</script>

<template>
  <AvatarStack :people="people" variant="outline" />
</template>
