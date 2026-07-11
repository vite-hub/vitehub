<template>
  <section class="border-b border-default bg-default">
    <div class="mx-auto grid min-h-[calc(100svh-var(--ui-header-height))] max-w-[90rem] items-center gap-12 px-4 py-16 sm:px-8 lg:grid-cols-[minmax(26rem,0.82fr)_minmax(0,1.18fr)] lg:gap-16 lg:px-12 lg:py-20">
      <div class="vh-landing-reveal min-w-0">
        <h1 class="vh-hero-title max-w-[9ch] font-semibold text-highlighted text-balance">
          The server layer for Vite.
        </h1>
        <p class="mt-8 max-w-[36ch] text-xl/8 text-muted text-pretty sm:text-2xl/9">
          Use portable Server Primitives directly, or compose them into Agents.
        </p>
        <NuxtLink
          to="/docs/getting-started"
          class="mt-10 inline-flex min-h-12 items-center gap-3 bg-inverted px-5 py-3 text-base/6 font-medium text-inverted transition-colors hover:bg-inverted/85 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary"
        >
          Start building
          <UIcon name="i-lucide-arrow-right" class="size-4 shrink-0" aria-hidden="true" />
        </NuxtLink>
      </div>

      <div class="vh-landing-reveal vh-landing-reveal-delay min-w-0">
        <img
          src="/images/landing/vitehub-backplane.webp"
          alt=""
          width="1536"
          height="1024"
          fetchpriority="high"
          decoding="async"
          class="w-full border border-default bg-[#f4eddf] object-cover"
        >
      </div>
    </div>
  </section>
</template>

<style scoped>
.vh-hero-title {
  font-size: clamp(4rem, 6.1vw, 6.5rem);
  letter-spacing: -0.06em;
  line-height: 0.92;
}
</style>
