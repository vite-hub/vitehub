<template>
  <section class="border-b border-default bg-default">
    <div
      class="mx-auto grid min-h-[calc(100svh-var(--ui-header-height))] max-w-[90rem] items-center gap-12 px-4 py-14 sm:px-8 sm:py-16 lg:grid-cols-[minmax(25rem,0.88fr)_minmax(0,1.12fr)] lg:gap-16 lg:px-12 lg:py-20"
    >
      <div class="vh-landing-reveal min-w-0">
        <h1 class="vh-hero-title max-w-[9ch] font-semibold text-highlighted text-balance">
          Agents, built like applications.
        </h1>
        <p class="mt-7 max-w-[44ch] text-lg/8 text-muted text-pretty sm:text-xl/8">
          If Nuxt makes web apps obvious, ViteHub does the same for agents. Write instructions and
          skills in Markdown, tools in TypeScript, and run them on any Vite host.
        </p>

        <LandingInstallCommand class="mt-9" />

        <div class="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
          <NuxtLink
            to="/docs/getting-started/first-agent"
            class="group inline-flex min-h-10 items-center gap-1.5 font-medium text-highlighted focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary"
          >
            Start building
            <UIcon
              name="i-lucide-arrow-right"
              class="size-4 shrink-0 transition-transform duration-200 group-hover:translate-x-1 motion-reduce:transition-none"
              aria-hidden="true"
            />
          </NuxtLink>
          <NuxtLink
            to="/docs"
            class="inline-flex min-h-10 items-center text-muted transition-colors hover:text-default focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary"
          >
            Read the docs
          </NuxtLink>
        </div>
      </div>

      <LandingAgentDiagram class="vh-landing-reveal vh-landing-reveal-delay min-w-0" />
    </div>
  </section>
</template>

<style scoped>
.vh-hero-title {
  font-size: clamp(3.75rem, 5.8vw, 6.25rem);
  letter-spacing: -0.06em;
  line-height: 0.92;
}
</style>
