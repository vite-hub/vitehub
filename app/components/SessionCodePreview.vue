<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { BundledLanguage, SpecialLanguage } from 'shiki'

const props = defineProps<{ content: string, path: string }>()
const html = ref('')
const loading = ref(false)
let renderId = 0

const language = computed<BundledLanguage | SpecialLanguage>(() => languageForPath(props.path))

watch(() => [props.content, props.path] as const, async ([content]) => {
  const id = ++renderId
  loading.value = true
  try {
    const { codeToHtml } = await import('shiki/bundle/web')
    const rendered = await codeToHtml(content, {
      defaultColor: false,
      lang: language.value,
      themes: { dark: 'github-dark', light: 'github-light' },
    })
    if (id === renderId) html.value = rendered
  }
  finally {
    if (id === renderId) loading.value = false
  }
}, { immediate: true })

function languageForPath(path: string): BundledLanguage | SpecialLanguage {
  const name = path.split('/').at(-1)?.toLowerCase() || ''
  if (name === 'dockerfile') return 'dockerfile'
  if (name === 'makefile') return 'make'
  if (name === '.gitignore' || name === '.npmrc') return 'shellscript'
  const extension = name.split('.').at(-1) || ''
  return ({
    cjs: 'javascript',
    css: 'css',
    html: 'html',
    js: 'javascript',
    json: 'json',
    jsonc: 'jsonc',
    jsx: 'jsx',
    md: 'markdown',
    mdx: 'mdx',
    mjs: 'javascript',
    mts: 'typescript',
    scss: 'scss',
    sh: 'shellscript',
    sql: 'sql',
    ts: 'typescript',
    tsx: 'tsx',
    vue: 'vue',
    yaml: 'yaml',
    yml: 'yaml',
  } as Partial<Record<string, BundledLanguage>>)[extension] || 'text'
}
</script>

<template>
  <div class="session-code-preview">
    <div v-if="loading && !html" class="session-inspector__state"><UIcon name="i-lucide-loader-circle" class="animate-spin" />Highlighting file…</div>
    <div v-else class="session-code-preview__html" v-html="html" />
  </div>
</template>
