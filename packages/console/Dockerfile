# The Console on a VPS. Build the Node output on Linux with glibc and Node.js 24,
# matching this image's CPU architecture, with the data folder of the container:
#   VITEHUB_DATA_DIR=/data vp build
# then build this image from packages/console. The database lives in /data, so mount a volume there.
FROM node:24-slim
WORKDIR /app
COPY .output ./.output
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
VOLUME /data
EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]
