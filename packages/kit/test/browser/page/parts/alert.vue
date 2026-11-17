<script setup lang="ts">
import { Button } from "@ui-sdk/vue/button"
import { CircleCheckIcon, CircleQuestionMarkIcon, UserIcon, XIcon } from "../icons"
import { useLog } from "../log"

const log = useLog()
</script>

<template>
  <div data-slot="stack">
    <div data-slot="vh-alert" role="status">
      <UserIcon aria-hidden="true" />
      <div data-slot="vh-alert-content">
        <div data-slot="vh-alert-title">Sign in to edit</div>
        <div data-slot="vh-alert-description">You are not signed in, or your session ended. Sign in, then reload.</div>
        <div data-slot="vh-alert-actions"><Button @click="log('Reload')">Reload</Button></div>
      </div>
    </div>
    <div data-slot="vh-alert" data-tone="error" role="alert">
      <CircleQuestionMarkIcon aria-hidden="true" />
      <div data-slot="vh-alert-content">
        <div data-slot="vh-alert-title">Couldn't load collections</div>
        <div data-slot="vh-alert-description">The server answered 500.</div>
      </div>
    </div>
    <div data-slot="vh-alert" data-tone="warning" role="alert">
      <CircleQuestionMarkIcon aria-hidden="true" />
      <div data-slot="vh-alert-content">
        <div data-slot="vh-alert-title">Connection lost</div>
        <div data-slot="vh-alert-description">Showing the last loaded session.</div>
      </div>
      <div data-slot="vh-alert-actions"><Button>Reconnect</Button></div>
    </div>
    <div data-slot="vh-alert" data-tone="success" role="status">
      <CircleCheckIcon aria-hidden="true" />
      <div data-slot="vh-alert-content">
        <div data-slot="vh-alert-title">Queue is on</div>
        <div data-slot="vh-alert-description">Changed vite.config.ts. The dev server restarted.</div>
      </div>
    </div>
    <div data-slot="vh-alert" data-tone="warning" data-variant="outline" role="alert">
      <CircleQuestionMarkIcon aria-hidden="true" />
      <div data-slot="vh-alert-content">
        <div data-slot="vh-alert-title">Nothing was published</div>
        <div data-slot="vh-alert-description">Welcome changed on the server. Open it, then publish again.</div>
      </div>
      <button type="button" data-slot="vh-alert-close" aria-label="Dismiss" @click="log('Dismiss')"><XIcon aria-hidden="true" /></button>
    </div>
    <div data-slot="vh-alert" data-variant="outline" role="status">
      <UserIcon aria-hidden="true" />
      <div data-slot="vh-alert-content">
        <div data-slot="vh-alert-description">Ana is editing this page. You can read it.</div>
      </div>
    </div>
  </div>
</template>
