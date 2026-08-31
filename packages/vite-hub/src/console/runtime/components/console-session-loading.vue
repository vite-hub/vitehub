<template>
  <div
    aria-label="Loading session"
    class="h-full overflow-hidden px-6 py-10 sm:px-10 lg:px-14"
    role="status"
  >
    <div class="mx-auto grid w-full max-w-4xl gap-6">
      <USkeleton class="h-14 rounded-lg" />
      <div class="mx-auto grid w-full max-w-3xl gap-4 rounded-3xl bg-elevated/60 p-7">
        <USkeleton class="h-8 w-44 rounded-md" />
        <USkeleton class="mt-2 h-5 w-4/5 rounded" />
        <USkeleton class="h-5 w-full rounded" />
        <USkeleton class="h-5 w-2/3 rounded" />
      </div>
      <USkeleton class="h-12 rounded-lg" />
      <div class="grid gap-3 px-1">
        <USkeleton class="h-5 w-1/3 rounded" />
        <USkeleton class="h-5 w-4/5 rounded" />
        <USkeleton class="h-5 w-3/5 rounded" />
      </div>
    </div>
  </div>
</template>
