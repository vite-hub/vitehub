<script setup lang="ts">
import { EyeIcon, EyeOffIcon } from "../icons"
import { Field, FieldDescription, FieldLabel } from "@vite-hub/kit/field"
import {
  PasswordInput,
  PasswordInputControl,
  PasswordInputToggle,
} from "@vite-hub/kit/password-input"
</script>

<template>
  <Field name="password">
    <FieldLabel>Password</FieldLabel>
    <PasswordInput>
      <PasswordInputControl />
      <PasswordInputToggle v-slot="{ state }" aria-label="Show password">
        <EyeOffIcon v-if="state.visible" aria-hidden="true" />
        <EyeIcon v-else aria-hidden="true" />
      </PasswordInputToggle>
    </PasswordInput>
    <FieldDescription>Use at least 8 characters.</FieldDescription>
  </Field>
</template>
