<script setup lang="ts">
import { picture } from "../media"
import { Avatar, AvatarFallback, AvatarImage } from "@ui-sdk/vue/avatar"

const person = {
  name: "shadcn",
  src: picture,
}
</script>

<template>
  <div data-slot="row">
    <Avatar>
      <AvatarImage :src="person.src" :alt="person.name" />
      <AvatarFallback
        ><span aria-hidden="true">CN</span
        ><span data-slot="visually-hidden">shadcn</span></AvatarFallback
      >
    </Avatar>
  </div>
</template>
