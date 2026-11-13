<script setup lang="ts">
import { CheckIcon } from "../icons"
import { Checkbox, CheckboxIndicator } from "@vite-hub/kit/checkbox"
</script>

<template>
  <label data-slot="label">
    <Checkbox>
      <CheckboxIndicator>
        <CheckIcon aria-hidden="true" />
      </CheckboxIndicator>
    </Checkbox>
    Accept terms and conditions
  </label>
</template>
