<script setup lang="ts">
import {
  ColorPicker,
  ColorPickerArea,
  ColorPickerAreaThumb,
  ColorPickerInput,
  ColorPickerSlider,
  ColorPickerSliderThumb,
} from "@vite-hub/kit/color-picker"
</script>

<template>
  <ColorPicker aria-label="Brand color" default-value="#0ea5e9">
    <ColorPickerArea>
      <ColorPickerAreaThumb />
    </ColorPickerArea>
    <ColorPickerSlider channel="hue">
      <ColorPickerSliderThumb />
    </ColorPickerSlider>
    <ColorPickerInput aria-label="Hex" />
  </ColorPicker>
</template>
