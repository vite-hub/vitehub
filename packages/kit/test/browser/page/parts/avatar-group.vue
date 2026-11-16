<script setup lang="ts">
import { Avatar, AvatarFallback, AvatarImage } from "@ui-sdk/vue/avatar"
import { picture } from "../media"
import { UserIcon } from "../icons"
</script>

<template>
  <div data-slot="stack">
    <span data-slot="vh-avatar-group" role="img" aria-label="Live session: Ana, Ben; Ada Lovelace · Editing; shadcn · Viewing; and 2 more">
      <Avatar><AvatarFallback><UserIcon aria-hidden="true" /></AvatarFallback></Avatar>
      <Avatar><AvatarFallback>AL</AvatarFallback></Avatar>
      <Avatar style="opacity: 0.6"><AvatarImage :src="picture" alt="" /><AvatarFallback>CN</AvatarFallback></Avatar>
      <span data-slot="vh-avatar-group-count">+2</span>
    </span>
    <span data-slot="vh-avatar-group" data-size="sm" role="img" aria-label="Ada Lovelace is editing, and 1 more">
      <Avatar><AvatarFallback>AL</AvatarFallback></Avatar>
      <span data-slot="vh-avatar-group-count">+1</span>
    </span>
  </div>
</template>
