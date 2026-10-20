<script setup lang="ts">
const people = ["Ana Ruiz", "Ben Ito", "Cleo Park", "Dev Shah", "Eli Moss", "Fay Ng"].map(name => ({ id: name, name }));
</script>

<template>
  <div class="flex flex-col items-start gap-4">
    <AvatarStack :max="2" :people="people" />
    <AvatarStack :max="4" :people="people" />
    <AvatarStack :max="null" :people="people" />
  </div>
</template>
