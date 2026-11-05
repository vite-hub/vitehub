<script setup lang="ts">
// The share image of every docs page, in the `vercel` theme: the site, the page title and description, and the section.
// The build renders it once per page while prerendering, so the Worker carries no renderer.
withDefaults(defineProps<{
  title?: string
  description?: string
  site?: string
  section?: string
  logo?: string
  host?: string
}>(), { title: "", description: "", site: "", section: "", logo: "", host: "" })
</script>

<template>
  <div class="w-full h-full flex flex-col justify-between bg-white text-black p-[72px]" style="font-family: Geist">
    <div class="flex items-center gap-4">
      <img v-if="logo" :src="logo" alt="" class="w-12 h-12">
      <span class="text-[36px] font-semibold" style="letter-spacing: -0.02em">{{ site }}</span>
      <span v-if="section" class="text-[36px] text-neutral-400">/</span>
      <span v-if="section" class="text-[36px] text-neutral-500">{{ section }}</span>
    </div>

    <div class="flex flex-col gap-6">
      <span class="text-[76px] font-semibold" style="line-height: 1.05; letter-spacing: -0.045em; text-wrap: balance">{{ title }}</span>
      <span v-if="description" class="text-[34px] text-neutral-500" style="line-height: 1.35; line-clamp: 2; text-overflow: ellipsis; overflow: hidden">{{ description }}</span>
    </div>

    <div class="flex items-center justify-between border-t border-neutral-200 pt-8">
      <span class="text-[26px] text-neutral-500" style="font-family: 'Geist Mono'">{{ host }}</span>
      <div class="flex w-[56px] h-[8px] bg-black" />
    </div>
  </div>
</template>
