<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { installOptions } from "./content";

const commandTabs = [
  installOptions.skill,
  {
    label: "App package",
    value: "package",
    icon: "i-lucide-package",
  },
] as const;

type CommandTab = (typeof commandTabs)[number]["value"];
type PackageManager = (typeof installOptions.packages)[number]["value"];

const activeTab = ref<CommandTab>("skill");
const activePackageManager = ref<PackageManager>("pnpm");
const copied = ref(false);
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
  <div class="flex w-full max-w-[38rem] flex-col gap-3">
    <div class="flex min-h-10 flex-wrap items-start justify-between gap-3">
      <div
        class="relative inline-grid grid-cols-2 gap-1 rounded-full bg-muted/80 p-1 text-sm ring-1 ring-default"
        role="group"
        aria-label="Install ViteHub"
      >
        <span
          class="pointer-events-none absolute top-1 bottom-1 left-1 w-[calc((100%_-_0.75rem)/2)] rounded-full bg-default ring-1 ring-accented transition-transform duration-[220ms] ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none"
          :style="{
            transform:
              activeTab === 'package' ? 'translateX(calc(100% + 0.25rem))' : 'translateX(0)',
          }"
          aria-hidden="true"
        />
        <button
          v-for="tab in commandTabs"
          :key="tab.value"
          type="button"
          :aria-pressed="activeTab === tab.value"
          class="relative z-10 inline-flex min-w-[7.75rem] items-center justify-center gap-1.5 rounded-full px-3 py-1.5 font-medium transition-[color,transform] duration-150 active:translate-y-px focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          :class="activeTab === tab.value ? 'text-highlighted' : 'text-muted hover:text-default'"
          @click="activeTab = tab.value"
        >
          <UIcon :name="tab.icon" class="size-3.5 shrink-0" aria-hidden="true" />
          <span>{{ tab.label }}</span>
        </button>
      </div>

      <div
        class="relative h-10 shrink-0"
        :class="activeTab === 'package' ? 'w-[17.25rem]' : 'w-0'"
        role="group"
        aria-label="Package manager"
        :aria-hidden="activeTab !== 'package'"
      >
        <div
          class="package-managers absolute top-0 right-0 flex items-center gap-1 rounded-full bg-muted/80 p-1 text-sm ring-1 ring-default"
          :class="activeTab === 'package' ? 'package-managers-visible' : 'package-managers-hidden'"
          :aria-hidden="activeTab !== 'package'"
        >
          <button
            v-for="option in installOptions.packages"
            :key="option.value"
            type="button"
            :tabindex="activeTab === 'package' ? 0 : -1"
            :aria-pressed="activePackageManager === option.value"
            :aria-label="option.label"
            class="relative inline-flex h-8 w-16 items-center overflow-hidden rounded-full font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            :class="
              activePackageManager === option.value
                ? 'bg-default text-highlighted ring-1 ring-accented'
                : 'text-muted grayscale hover:text-default'
            "
            @click="activePackageManager = option.value"
          >
            <UIcon
              :name="option.icon"
              class="package-manager-icon absolute left-1/2 size-3.5 shrink-0"
              :class="activePackageManager === option.value ? 'package-manager-icon-selected' : ''"
              aria-hidden="true"
            />
            <span
              class="package-manager-label absolute left-[1.875rem] whitespace-nowrap text-xs"
              :class="activePackageManager === option.value ? 'opacity-100' : 'opacity-0'"
              aria-hidden="true"
            >
              {{ option.label }}
            </span>
          </button>
        </div>
      </div>
    </div>

    <button
      type="button"
      :aria-label="copyLabel"
      class="group inline-flex min-h-12 w-full items-center gap-2 rounded-full border border-default bg-default px-3 py-2.5 text-left transition-[border-color,background-color] duration-200 hover:border-accented hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary"
      @click="copyCommand"
    >
      <span class="font-mono text-sm text-dimmed select-none" aria-hidden="true">$</span>
      <span class="relative min-w-0 flex-1 overflow-hidden font-mono text-sm text-highlighted">
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
        class="relative ml-1 inline-flex size-7 shrink-0 items-center justify-center rounded-full text-muted transition-colors group-hover:bg-muted group-hover:text-default"
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
    opacity 220ms cubic-bezier(0.23, 1, 0.32, 1),
    transform 220ms cubic-bezier(0.23, 1, 0.32, 1),
    visibility 0s linear 220ms;
}

.package-managers-visible {
  visibility: visible;
  opacity: 1;
  transform: translateY(0);
  transition-delay: 0s;
}

.package-managers-hidden {
  visibility: hidden;
  pointer-events: none;
  opacity: 0;
  transform: translateY(0.25rem);
}

.package-manager-icon {
  transform: translateX(-50%);
  transition: transform 220ms cubic-bezier(0.23, 1, 0.32, 1);
}

.package-manager-icon-selected {
  transform: translateX(calc(-50% - 1rem));
}

.package-manager-label {
  transition: opacity 220ms cubic-bezier(0.23, 1, 0.32, 1);
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
    transform: none;
    transition:
      opacity 200ms cubic-bezier(0.23, 1, 0.32, 1),
      visibility 0s linear 200ms;
  }

  .package-managers-visible {
    transition-delay: 0s;
  }

  .package-manager-icon {
    transition: none;
  }

  .package-manager-label {
    transition: opacity 200ms cubic-bezier(0.23, 1, 0.32, 1);
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
