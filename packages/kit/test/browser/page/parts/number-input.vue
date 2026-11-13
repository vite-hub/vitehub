<script setup lang="ts">
import { MinusIcon, MoveHorizontalIcon, PlusIcon } from "../icons"
import { Field, FieldLabel } from "@vite-hub/kit/field"
import {
  NumberInput,
  NumberInputControl,
  NumberInputDecrement,
  NumberInputGroup,
  NumberInputIncrement,
  NumberInputScrubArea,
  NumberInputScrubAreaCursor,
} from "@vite-hub/kit/number-input"
import { useLog } from "../log"

const log = useLog()
</script>

<template>
  <Field>
    <NumberInput
      :default-value="1"
      :min="1"
      @value-commit="(value) => log(`Quantity ${value ?? 'empty'}`)"
    >
      <NumberInputScrubArea :pixels-per-step="4">
        <FieldLabel>Quantity</FieldLabel>
        <NumberInputScrubAreaCursor>
          <MoveHorizontalIcon aria-hidden="true" />
        </NumberInputScrubAreaCursor>
      </NumberInputScrubArea>
      <NumberInputGroup>
        <NumberInputDecrement aria-label="Decrease">
          <MinusIcon aria-hidden="true" />
        </NumberInputDecrement>
        <NumberInputControl />
        <NumberInputIncrement aria-label="Increase">
          <PlusIcon aria-hidden="true" />
        </NumberInputIncrement>
      </NumberInputGroup>
    </NumberInput>
  </Field>
</template>
