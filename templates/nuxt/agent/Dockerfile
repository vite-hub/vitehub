FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
COPY .output .output
EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]
