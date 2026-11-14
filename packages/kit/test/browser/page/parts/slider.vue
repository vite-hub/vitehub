<script setup lang="ts">
import {
  Slider,
  SliderValue,
  SliderControl,
  SliderTrack,
  SliderIndicator,
  SliderThumb,
} from "@ui-sdk/vue/slider"
</script>

<template>
  <Slider :default-value="50">
    <SliderValue />
    <SliderControl>
      <SliderTrack>
        <SliderIndicator />
        <SliderThumb aria-label="Volume" />
      </SliderTrack>
    </SliderControl>
  </Slider>
</template>
