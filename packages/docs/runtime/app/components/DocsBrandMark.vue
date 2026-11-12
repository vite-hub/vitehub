<script setup lang="ts">
// The site mark beside its name in the header, the rail, and the sidebar. A one-color mark is a mask filled with the
// text color, so it follows light and dark mode. A colored logo shows as it is, with its dark version in dark mode.
// The parent sets its size with `--vh-docs-mark-size`.
const { site } = useDocsConfig()
// Nuxt turns a `null` in runtime config into "", so an empty value means no logo.
const logo = site.logo || null
// A mask image is fetched only once the CSS applies to the mark, after the text around it has painted. The preload
// fetches it with the HTML, in CORS mode like a mask.
if (logo?.mask) {
  useHead({ link: [{ key: "vh-docs-logo", rel: "preload", as: "image", href: logo.src, crossorigin: "anonymous", fetchpriority: "high" }] })
}
</script>

<template>
  <span v-if="logo?.mask" class="vh-docs-mark is-mask" :style="{ '--vh-docs-logo': `url(${logo.src})` }" aria-hidden="true" />
  <span v-else-if="logo" class="vh-docs-mark" aria-hidden="true">
    <img :src="logo.src" alt="" :class="{ 'is-light': logo.dark }">
    <img v-if="logo.dark" :src="logo.dark" alt="" class="is-dark">
  </span>
</template>

<style scoped>
.vh-docs-mark {
  display: block;
  flex: none;
  width: var(--vh-docs-mark-size, 1.25rem);
  height: var(--vh-docs-mark-size, 1.25rem);
}

.vh-docs-mark.is-mask {
  background-color: var(--ui-text-highlighted);
  mask: var(--vh-docs-logo) center / contain no-repeat;
}

.vh-docs-mark img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}

/* `:global(.dark) .a` compiles to `.dark` alone, so each rule names the whole selector inside `:global()`. */
.vh-docs-mark .is-dark,
:global(.dark .vh-docs-mark .is-light) {
  display: none;
}

:global(.dark .vh-docs-mark .is-dark) {
  display: block;
}
</style>
