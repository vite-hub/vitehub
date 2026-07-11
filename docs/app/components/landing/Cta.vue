<template>
  <section class="bg-inverted text-inverted">
    <div class="mx-auto grid max-w-[90rem] gap-6 px-4 py-10 sm:px-8 sm:py-12 lg:grid-cols-[minmax(18rem,0.8fr)_minmax(24rem,1.2fr)_auto] lg:items-center lg:gap-10 lg:px-12">
      <h2 class="max-w-[22ch] text-2xl/8 font-semibold tracking-[-0.025em] text-inverted sm:text-3xl/9">
        Give your coding agent the ViteHub skill.
      </h2>
      <code class="min-w-0 overflow-x-auto border border-inverted/25 px-4 py-3 font-mono text-sm/6 whitespace-nowrap text-inverted">npx skills add https://vitehub.dev</code>
      <NuxtLink
        to="/docs/ai-resources/agent-instructions-skills"
        class="inline-flex min-h-12 items-center justify-center gap-2 border border-inverted bg-default px-5 py-3 font-medium text-default transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-inverted"
      >
        Install the skill
        <UIcon name="i-lucide-arrow-up-right" class="size-4 shrink-0" aria-hidden="true" />
      </NuxtLink>
    </div>
  </section>
</template>
