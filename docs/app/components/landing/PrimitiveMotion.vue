<script setup lang="ts">
defineProps<{ name: string }>();
</script>

<template>
  <svg v-if="name === 'workspace'" viewBox="0 0 96 56" class="size-full" aria-hidden="true">
    <path d="M12 12h18l5 5h22" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".42" />
    <rect
      x="12"
      y="9"
      width="72"
      height="38"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      opacity=".22"
    />
    <rect x="24" y="22" width="31" height="3" fill="currentColor" opacity=".34" />
    <rect x="24" y="29" width="22" height="3" fill="currentColor" opacity=".24" />
    <path
      d="M24 38l4 3-4 3"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      opacity=".62"
    />
    <rect x="32" y="39.5" width="18" height="3" fill="currentColor" opacity=".4" />
    <rect x="52" y="38.5" width="2" height="5" fill="currentColor" class="pm-blink" />
  </svg>

  <svg v-else-if="name === 'kv'" viewBox="0 0 96 56" class="size-full" aria-hidden="true">
    <circle
      cx="20"
      cy="28"
      r="9"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      opacity=".42"
    />
    <line x1="29" y1="28" x2="57" y2="28" stroke="currentColor" stroke-width="1.5" opacity=".28" />
    <rect x="62" y="18" width="22" height="20" fill="currentColor" class="pm-kv-value" />
    <circle cx="38" cy="28" r="3" fill="currentColor" class="pm-kv-dot" />
  </svg>

  <svg v-else-if="name === 'queue'" viewBox="0 0 96 56" class="size-full" aria-hidden="true">
    <line
      x1="10"
      y1="28"
      x2="86"
      y2="28"
      stroke="currentColor"
      stroke-width="1.25"
      stroke-dasharray="3 4"
      opacity=".25"
    />
    <circle
      v-for="index in 4"
      :key="index"
      cx="12"
      cy="28"
      r="6"
      fill="currentColor"
      class="pm-queue-dot"
      :style="{ animationDelay: `${(index - 1) * -1.15}s` }"
    />
  </svg>

  <svg v-else-if="name === 'workflow'" viewBox="0 0 96 56" class="size-full" aria-hidden="true">
    <line
      x1="20"
      y1="24"
      x2="76"
      y2="24"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-dasharray="3 3"
      opacity=".28"
    />
    <path
      d="M76 31c-18 20-38 20-56 0"
      fill="none"
      stroke="currentColor"
      stroke-width="1.25"
      stroke-dasharray="3 3"
      opacity=".18"
    />
    <circle
      v-for="x in [20, 48, 76]"
      :key="x"
      :cx="x"
      cy="24"
      r="7"
      fill="var(--ui-bg)"
      stroke="currentColor"
      stroke-width="1.5"
      opacity=".5"
    />
    <circle cx="20" cy="24" r="3" fill="currentColor" class="pm-workflow-token" />
  </svg>

  <svg v-else-if="name === 'schedule'" viewBox="0 0 96 56" class="size-full" aria-hidden="true">
    <circle
      cx="48"
      cy="28"
      r="19"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      opacity=".26"
    />
    <circle
      cx="48"
      cy="28"
      r="19"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      class="pm-radar"
    />
    <circle cx="48" cy="28" r="2.5" fill="currentColor" opacity=".65" />
    <line
      x1="48"
      y1="28"
      x2="48"
      y2="14"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      class="pm-hand"
    />
  </svg>

  <svg v-else viewBox="0 0 96 56" class="size-full" aria-hidden="true">
    <path
      d="M48 8l26 12v25L48 50 22 45V20z"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      opacity=".34"
    />
    <path
      d="M22 20l26 12 26-12M48 32v18"
      fill="none"
      stroke="currentColor"
      stroke-width="1.25"
      opacity=".22"
    />
    <path d="M31 17l26 12v14L31 38z" fill="currentColor" opacity=".12" class="pm-sandbox-scan" />
    <circle cx="48" cy="30" r="4" fill="currentColor" class="pm-sandbox-core" />
  </svg>
</template>

<style scoped>
.pm-blink {
  animation: pm-blink 1.1s step-end infinite;
}

.pm-kv-dot {
  animation: pm-kv-dot 2.4s cubic-bezier(0.65, 0, 0.35, 1) infinite;
}

.pm-kv-value {
  animation: pm-kv-value 2.4s cubic-bezier(0.65, 0, 0.35, 1) infinite;
}

.pm-queue-dot {
  opacity: 0;
  animation: pm-queue 4.6s linear infinite;
}

.pm-workflow-token {
  animation: pm-workflow 3s steps(2, jump-none) infinite;
}

.pm-hand {
  animation: pm-hand 4s linear infinite;
  transform-origin: 48px 28px;
}

.pm-radar {
  animation: pm-radar 3s cubic-bezier(0.22, 1, 0.36, 1) infinite;
  transform-origin: 48px 28px;
}

.pm-sandbox-scan {
  animation: pm-sandbox-scan 3.2s cubic-bezier(0.65, 0, 0.35, 1) infinite;
}

.pm-sandbox-core {
  animation: pm-sandbox-core 3.2s cubic-bezier(0.65, 0, 0.35, 1) infinite;
  transform-origin: 48px 30px;
}

@keyframes pm-blink {
  0%,
  49% {
    opacity: 0.72;
  }
  50%,
  100% {
    opacity: 0;
  }
}

@keyframes pm-kv-dot {
  0% {
    opacity: 0;
    transform: translateX(0);
  }
  20% {
    opacity: 0.72;
  }
  78% {
    opacity: 0.72;
  }
  100% {
    opacity: 0;
    transform: translateX(24px);
  }
}

@keyframes pm-kv-value {
  0%,
  58%,
  100% {
    opacity: 0.16;
  }
  78% {
    opacity: 0.58;
  }
}

@keyframes pm-queue {
  0% {
    opacity: 0;
    transform: translateX(-8px);
  }
  16% {
    opacity: 0.54;
  }
  84% {
    opacity: 0.54;
  }
  100% {
    opacity: 0;
    transform: translateX(80px);
  }
}

@keyframes pm-workflow {
  from {
    transform: translateX(0);
  }
  to {
    transform: translateX(56px);
  }
}

@keyframes pm-hand {
  to {
    transform: rotate(360deg);
  }
}

@keyframes pm-radar {
  0% {
    opacity: 0.38;
    transform: scale(0.8);
  }
  45%,
  100% {
    opacity: 0;
    transform: scale(1.35);
  }
}

@keyframes pm-sandbox-scan {
  0%,
  100% {
    opacity: 0.08;
    transform: translateY(-7px);
  }
  50% {
    opacity: 0.3;
    transform: translateY(7px);
  }
}

@keyframes pm-sandbox-core {
  0%,
  100% {
    opacity: 0.3;
    transform: scale(0.8);
  }
  50% {
    opacity: 0.7;
    transform: scale(1);
  }
}

@media (prefers-reduced-motion: reduce) {
  .pm-blink,
  .pm-kv-dot,
  .pm-kv-value,
  .pm-queue-dot,
  .pm-workflow-token,
  .pm-hand,
  .pm-radar,
  .pm-sandbox-scan,
  .pm-sandbox-core {
    animation: none;
  }

  .pm-queue-dot,
  .pm-kv-dot,
  .pm-radar {
    opacity: 0.5;
  }

  .pm-queue-dot:nth-of-type(2) {
    transform: translateX(20px);
  }

  .pm-queue-dot:nth-of-type(3) {
    transform: translateX(40px);
  }

  .pm-queue-dot:nth-of-type(4) {
    transform: translateX(60px);
  }
}
</style>
