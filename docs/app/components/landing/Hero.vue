<template>
  <section class="border-b border-default bg-default">
    <div class="mx-auto max-w-[90rem] px-4 py-12 sm:px-8 sm:py-16 lg:px-12">
      <!-- Seven columns match the catalog, so the install panel starts on a tile border. -->
      <!-- The heading is the largest paint of the page, so it shows at once. Only the grid below fades in. -->
      <div class="grid gap-8 xl:grid-cols-7 xl:items-end xl:gap-0">
        <div class="min-w-0 xl:col-span-4 xl:pr-12">
          <h1 class="vh-hero-title max-w-[13ch] font-semibold text-highlighted text-balance">
            The server layer for Vite apps.
          </h1>
          <p class="mt-5 max-w-[42ch] text-lg/7 text-muted text-pretty">
            Databases, storage, queues, workflows, and more. Use one API in your app and deploy it
            to your choice of cloud.
          </p>
        </div>
        <div class="w-full min-w-0 max-w-[38rem] xl:col-span-3 xl:max-w-none">
          <LandingInstallCommand />
          <div class="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
            <UButton
              to="/docs/getting-started/first-server-primitive"
              label="Start building"
              trailing-icon="i-lucide-arrow-right"
              class="hero-cta"
            />
            <NuxtLink
              to="/docs"
              class="inline-flex min-h-10 items-center gap-1.5 text-muted transition-colors hover:text-highlighted"
            >
              Explore the docs
              <UIcon name="i-lucide-arrow-up-right" class="size-3.5" aria-hidden="true" />
            </NuxtLink>
          </div>
        </div>
      </div>

      <LandingPrimitives class="vh-landing-reveal mt-10 xl:mt-12" />
    </div>
  </section>
</template>

<style scoped>
.vh-hero-title {
  font-size: clamp(3.5rem, 5.6vw, 5.75rem);
  letter-spacing: -0.065em;
  line-height: 0.98;
}

.hero-cta :deep(.iconify) {
  transition: transform 200ms ease;
}

@media (hover: hover) and (pointer: fine) {
  .hero-cta:hover :deep(.iconify) {
    transform: translateX(0.2rem);
  }
}

@media (prefers-reduced-motion: reduce) {
  .hero-cta :deep(.iconify) {
    transition: none;
  }
}
</style>
