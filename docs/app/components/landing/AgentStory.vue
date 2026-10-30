<script setup lang="ts">
import { tokenize } from "./code";
import { agentStory } from "./content";

interface Note {
  id: string;
  line: number;
  lines: readonly number[];
  text: string;
  to: string;
}

// The Agent file and the route that reads its store. Each file carries notes on the lines they explain.
const files = [
  { path: agentStory.path, lines: agentStory.code.map(tokenize), notes: agentStory.notes as readonly Note[] },
  { path: agentStory.route.path, lines: agentStory.route.code.map(tokenize), notes: agentStory.route.notes as readonly Note[] },
];

// Pointing at a note lights the lines it explains. Nothing plays on its own.
const activeNote = shallowRef<Note | null>(null);

function noteOn(file: (typeof files)[number], line: number) {
  return file.notes.find((note) => note.line === line);
}

function lineState(file: (typeof files)[number], line: number) {
  const note = activeNote.value;
  if (!note || !file.notes.includes(note)) return undefined;
  return note.lines.includes(line) ? "is-active" : "is-dimmed";
}
</script>

<template>
  <section class="border-b border-default bg-muted/20">
    <div class="mx-auto max-w-[90rem] px-4 py-16 sm:px-8 sm:py-20 lg:px-12 lg:py-24">
      <div class="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,0.6fr)] lg:items-end lg:gap-16">
        <h2
          class="max-w-[13ch] text-4xl/10 font-semibold tracking-[-0.04em] text-highlighted text-balance sm:text-5xl/12 lg:text-6xl/14"
        >
          Define an Agent in one file.
        </h2>
        <p class="max-w-[38ch] text-lg/8 text-muted lg:justify-self-end">
          {{ agentStory.positioning }}
        </p>
      </div>

      <div class="mt-12 flex flex-col gap-6 lg:mt-16">
        <figure v-for="file in files" :key="file.path" class="story-file">
          <figcaption class="flex min-h-11 items-center gap-2 border-b border-default px-4 font-mono text-xs text-muted">
            <UIcon name="i-lucide-file-code-2" class="size-3.5 shrink-0" aria-hidden="true" />
            <span class="truncate">{{ file.path }}</span>
          </figcaption>

          <div class="story-code font-mono text-xs/6 sm:text-[0.8125rem]/7 xl:text-sm/8">
            <template v-for="(line, index) in file.lines" :key="index">
              <div class="story-line" :class="lineState(file, index)">
                <span class="story-line-number" aria-hidden="true">{{ index + 1 }}</span>
                <span class="whitespace-pre"><span
                  v-for="(token, tokenIndex) in line"
                  :key="tokenIndex"
                  :class="`token-${token.kind}`"
                >{{ token.text }}</span></span>
                <span v-if="noteOn(file, index)" class="story-leader" aria-hidden="true" />
              </div>
              <div class="story-note">
                <NuxtLink
                  v-if="noteOn(file, index)"
                  :to="noteOn(file, index)!.to"
                  class="story-note-link"
                  @pointerenter="activeNote = noteOn(file, index)!"
                  @pointerleave="activeNote = null"
                  @focus="activeNote = noteOn(file, index)!"
                  @blur="activeNote = null"
                >
                  <span class="story-note-label">{{ noteOn(file, index)!.id }}</span>
                  <span class="text-muted">{{ noteOn(file, index)!.text }}</span>
                </NuxtLink>
              </div>
            </template>
          </div>

          <!-- Below xl the code takes the full width, so the notes follow it as a list. -->
          <ul class="border-t border-default px-4 py-3 text-sm/6 xl:hidden">
            <li v-for="note in file.notes" :key="note.id">
              <NuxtLink :to="note.to" class="story-note-link py-1">
                <span class="story-note-label">{{ note.id }}</span>
                <span class="text-muted">{{ note.text }}</span>
              </NuxtLink>
            </li>
          </ul>
        </figure>
      </div>

      <div class="mt-8 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
        <NuxtLink
          :to="agentStory.tutorialPath"
          class="group inline-flex min-h-10 items-center gap-2 border-b border-highlighted font-medium text-highlighted focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary"
        >
          Build your first Agent
          <UIcon name="i-lucide-arrow-right" class="landing-cta-arrow size-4 shrink-0 transition-transform duration-200 motion-reduce:transition-none" aria-hidden="true" />
        </NuxtLink>
        <NuxtLink
          :to="agentStory.route.to"
          class="inline-flex min-h-10 items-center text-muted transition-colors hover:text-highlighted focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary"
        >
          How Capabilities use primitives
        </NuxtLink>
      </div>
    </div>
  </section>
</template>

<style scoped>
.story-file {
  min-width: 0;
  border: 1px solid var(--ui-border);
  background: var(--ui-bg);
}

.story-code {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  overflow-x: auto;
  padding-block: 1.25rem;
  color: var(--ui-text-muted);
}

.story-note {
  display: none;
}

/* Both files share one code column width, so their notes start on the same vertical line. */
@media (min-width: 80rem) {
  .story-code {
    grid-template-columns: minmax(max-content, 46rem) minmax(0, 1fr);
  }

  .story-note {
    display: flex;
    min-width: 0;
    align-items: center;
    padding-inline: 0 1.5rem;
    font-family: var(--font-sans);
    font-size: 0.8125rem;
  }
}

.story-line {
  position: relative;
  display: flex;
  min-width: max-content;
  align-items: center;
  padding-right: 1.5rem;
  transition: opacity 200ms ease, background-color 200ms ease;
}

.story-line.is-active {
  background: color-mix(in srgb, var(--ui-bg-muted) 80%, transparent);
}

.story-line.is-dimmed {
  opacity: 0.4;
}

.story-line-number {
  display: inline-block;
  width: 3rem;
  flex: none;
  padding-right: 1.25rem;
  color: var(--ui-text-dimmed);
  text-align: right;
  user-select: none;
}

/* A dotted leader joins a line to its note, like a table of contents. */
.story-leader {
  display: none;
}

@media (min-width: 80rem) {
  .story-leader {
    display: block;
    min-width: 1.5rem;
    flex: 1;
    margin-left: 1rem;
    border-bottom: 1px dotted var(--ui-border-accented);
  }

  .story-line {
    padding-right: 0.75rem;
  }
}

.story-note-link {
  display: flex;
  min-width: 0;
  align-items: baseline;
  gap: 0.625rem;
}

.story-note-label {
  flex: none;
  color: var(--ui-text-highlighted);
  font-family: var(--font-mono);
  font-size: 0.75rem;
  text-decoration: underline dotted var(--ui-border-accented);
  text-underline-offset: 0.25rem;
}

.story-note-link:focus-visible {
  outline: 2px solid var(--ui-primary);
  outline-offset: 2px;
}

@media (hover: hover) and (pointer: fine) {
  .story-note-link:hover .story-note-label {
    text-decoration-color: currentcolor;
  }

  .group:hover .landing-cta-arrow {
    transform: translateX(0.25rem);
  }
}

.token-keyword,
.token-call {
  color: var(--ui-text-highlighted);
}

.token-keyword {
  font-weight: 500;
}

.token-string {
  color: var(--ui-text-toned);
}

@media (prefers-reduced-motion: reduce) {
  .story-line {
    transition: none;
  }
}
</style>
