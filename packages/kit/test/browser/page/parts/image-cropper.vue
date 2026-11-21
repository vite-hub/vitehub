<script setup lang="ts">
import {
  ImageCropper,
  ImageCropperHandle,
  ImageCropperImage,
  ImageCropperSelection,
  ImageCropperViewport,
} from "@ui-sdk/vue/image-cropper"
import { picture as src } from "../media"
</script>

<template>
  <ImageCropper aria-label="Cover photo" :src="src" :aspect-ratio="3">
    <ImageCropperViewport>
      <ImageCropperImage alt="Your cover photo" />
      <ImageCropperSelection>
        <ImageCropperHandle position="nw" />
        <ImageCropperHandle position="se" />
      </ImageCropperSelection>
    </ImageCropperViewport>
  </ImageCropper>
</template>
