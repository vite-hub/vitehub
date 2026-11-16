<script setup lang="ts">
import { Button } from "@ui-sdk/vue/button"
import { CircleCheckIcon, FileIcon, PlusIcon, SearchIcon } from "../icons"
</script>

<template>
  <div data-slot="stack">
    <div data-slot="vh-empty" role="status">
      <span data-slot="vh-empty-icon"><SearchIcon aria-hidden="true" /></span>
      <h2 data-slot="vh-empty-title">No spans match</h2>
      <p data-slot="vh-empty-description">Try another name or clear the filter.</p>
    </div>
    <div data-slot="vh-empty" data-size="xs">
      <span data-slot="vh-empty-icon"><SearchIcon aria-hidden="true" /></span>
      <h2 data-slot="vh-empty-title">No keys match “user:”</h2>
      <p data-slot="vh-empty-description">Try another prefix.</p>
      <div data-slot="vh-empty-actions">
        <Button>Clear filter</Button>
      </div>
    </div>
    <div data-slot="vh-empty" data-size="sm">
      <span data-slot="vh-empty-icon"><FileIcon aria-hidden="true" /></span>
      <h2 data-slot="vh-empty-title">No linked accounts</h2>
      <p data-slot="vh-empty-description">This user signs in with email only.</p>
    </div>
    <div data-slot="vh-empty" data-variant="outline">
      <span data-slot="vh-empty-icon"><CircleCheckIcon aria-hidden="true" /></span>
      <h2 data-slot="vh-empty-title">Everything is published</h2>
      <p data-slot="vh-empty-description">Drafts and edits show here until someone publishes them.</p>
      <div data-slot="vh-empty-actions">
        <Button data-variant="solid"><PlusIcon aria-hidden="true" />New document</Button>
      </div>
    </div>
    <div data-slot="vh-empty" data-variant="outline" data-size="sm">
      <h2 data-slot="vh-empty-title">No usage yet</h2>
      <p data-slot="vh-empty-description">Nov 1 to Nov 14 UTC</p>
    </div>
  </div>
</template>
