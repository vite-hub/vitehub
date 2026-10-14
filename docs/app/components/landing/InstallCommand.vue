<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useId, watch } from "vue";
import { motion, MotionConfig } from "motion-v";
import { installOptions } from "./content";

const commandTabs = [
  {
    ...installOptions.skill,
    label: "For Agents",
  },
  {
    label: "For humans",
    value: "package",
    icon: "i-lucide-package",
  },
] as const;

type CommandTab = (typeof commandTabs)[number]["value"];
type PackageManager = (typeof installOptions.packages)[number]["value"];

const activeTab = ref<CommandTab>("package");
const activePackageManager = ref<PackageManager>("pnpm");
const copied = ref(false);
const indicatorId = `install-tab-${useId()}`;
let copiedTimer: ReturnType<typeof setTimeout> | undefined;

const selectedPackageManager = computed(
  () =>
    installOptions.packages.find((option) => option.value === activePackageManager.value) ??
    installOptions.packages[0],
);
const activeCommand = computed(() =>
  activeTab.value === "skill" ? installOptions.skill.command : selectedPackageManager.value.command,
);
const copyLabel = computed(() =>
  copied.value ? "Copied install command" : "Copy install command",
);

async function copyCommand() {
  let didCopy = false;

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(activeCommand.value);
      didCopy = true;
    }
  } catch {}

  if (!didCopy) {
    const textarea = document.createElement("textarea");
    textarea.value = activeCommand.value;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    didCopy = document.execCommand("copy");
    textarea.remove();
  }

  if (!didCopy) return;

  copied.value = true;
  if (copiedTimer) clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => {
    copied.value = false;
  }, 1500);
}

watch([activeTab, activePackageManager], () => {
  copied.value = false;
});

onBeforeUnmount(() => {
  if (copiedTimer) clearTimeout(copiedTimer);
});
</script>

<template>
  <div class="flex w-full flex-col border border-default bg-default">
    <MotionConfig reduced-motion="user">
      <div class="flex min-h-10 flex-wrap items-stretch justify-between border-b border-default">
        <div class="flex items-stretch text-sm" role="group" aria-label="Install ViteHub">
          <button
            v-for="tab in commandTabs"
            :key="tab.value"
            type="button"
            :aria-pressed="activeTab === tab.value"
            class="relative inline-flex items-center gap-1.5 border-r border-default px-3 font-medium whitespace-nowrap transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary sm:px-4"
            :class="activeTab === tab.value ? 'text-highlighted' : 'text-muted hover:text-default'"
            @click="activeTab = tab.value"
          >
            <UIcon :name="tab.icon" class="hidden size-3.5 shrink-0 sm:block" aria-hidden="true" />
            <span>{{ tab.label }}</span>
            <motion.span
              v-if="activeTab === tab.value"
              :layout-id="indicatorId"
              :initial="false"
              :transition="{ type: 'spring', stiffness: 450, damping: 36 }"
              class="absolute inset-x-0 -bottom-px h-px bg-inverted"
              aria-hidden="true"
            />
          </button>
        </div>

        <div
          class="package-managers flex items-stretch max-sm:w-full max-sm:justify-end"
          :class="activeTab === 'package' ? 'package-managers-visible' : 'package-managers-hidden'"
          role="group"
          aria-label="Package manager"
          :aria-hidden="activeTab !== 'package'"
        >
          <button
            v-for="option in installOptions.packages"
            :key="option.value"
            type="button"
            :tabindex="activeTab === 'package' ? 0 : -1"
            :aria-pressed="activePackageManager === option.value"
            :aria-label="option.label"
            :title="option.label"
            class="inline-flex w-9 items-center justify-center border-l sm:w-10 border-default transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary"
            :class="
              activePackageManager === option.value
                ? 'bg-muted text-highlighted'
                : 'text-muted grayscale hover:text-default'
            "
            @click="activePackageManager = option.value"
          >
            <UIcon :name="option.icon" class="size-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>
    </MotionConfig>

    <button
      type="button"
      :aria-label="copyLabel"
      class="group inline-flex min-h-12 w-full items-center gap-2 bg-muted/30 px-4 py-2.5 text-left transition-colors duration-200 hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary"
      @click="copyCommand"
    >
      <span class="font-mono text-xs text-dimmed select-none sm:text-sm" aria-hidden="true">$</span>
      <span class="relative min-w-0 flex-1 overflow-hidden font-mono text-xs text-highlighted sm:text-sm">
        <Transition name="command-swap" mode="out-in">
          <code
            :key="activeCommand"
            class="block overflow-x-auto whitespace-nowrap py-1 [scrollbar-width:none]"
          >
            {{ activeCommand }}
          </code>
        </Transition>
      </span>
      <span
        class="relative ml-1 inline-flex size-8 shrink-0 items-center justify-center text-muted transition-colors group-hover:text-highlighted"
      >
        <Transition name="copy-icon" mode="out-in">
          <UIcon
            :key="copied ? 'check' : 'copy'"
            :name="copied ? 'i-lucide-check' : 'i-lucide-copy'"
            class="size-3.5"
            :class="copied ? 'text-highlighted' : ''"
            aria-hidden="true"
          />
        </Transition>
      </span>
    </button>

    <span class="sr-only" aria-live="polite">{{ copied ? "Install command copied" : "" }}</span>
  </div>
</template>

<style scoped>
.package-managers {
  transition:
    opacity 200ms ease-out,
    visibility 0s linear 200ms;
}

.package-managers-visible {
  visibility: visible;
  opacity: 1;
  transition-delay: 0s;
}

.package-managers-hidden {
  display: none;
  visibility: hidden;
  pointer-events: none;
  opacity: 0;
}

.command-swap-enter-active,
.command-swap-leave-active {
  transition:
    opacity 180ms cubic-bezier(0.23, 1, 0.32, 1),
    transform 180ms cubic-bezier(0.23, 1, 0.32, 1);
}

.command-swap-enter-from,
.command-swap-leave-to {
  opacity: 0;
  transform: translateY(2px);
}

.copy-icon-enter-active,
.copy-icon-leave-active {
  transition:
    opacity 200ms cubic-bezier(0.23, 1, 0.32, 1),
    transform 200ms cubic-bezier(0.23, 1, 0.32, 1);
}

.copy-icon-enter-from,
.copy-icon-leave-to {
  opacity: 0;
  transform: scale(0.95);
}

@media (prefers-reduced-motion: reduce) {
  .package-managers {
    transition: none;
  }

  .command-swap-enter-active,
  .command-swap-leave-active,
  .copy-icon-enter-active,
  .copy-icon-leave-active {
    transition: none;
  }

  .command-swap-enter-from,
  .command-swap-leave-to,
  .copy-icon-enter-from,
  .copy-icon-leave-to {
    transform: none;
  }
}
</style>
