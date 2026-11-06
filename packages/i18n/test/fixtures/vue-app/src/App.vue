<script setup lang="ts">
import { useLocale } from "@vite-hub/i18n/vue"
import { deployStatus } from "./status"

const props = defineProps<{ name?: string }>()
const { locale, setLocale } = useLocale()
</script>

<template>
  <h1>{{ t`Deploy your agent` }}</h1>
  <p><Trans>Hello <b>{{ props.name }}</b>, read the <a href="/docs">docs</a>.</Trans></p>
  <input :placeholder="t`Search agents`">
  <output>{{ deployStatus(2) }}</output>
  <button @click="setLocale(locale === 'en' ? 'es' : 'en')">{{ locale }}</button>
</template>
