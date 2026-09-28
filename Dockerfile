FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

FROM node:20-slim
ENV NODE_ENV=production
# ffmpeg: convierte las notas de voz (ogg/opus) al PCM que exige la Live API (respaldo de transcripción).
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY public ./public
COPY docker-entrypoint.sh /usr/local/bin/cca
RUN chmod +x /usr/local/bin/cca && mkdir -p /app/data && chown node:node /app/data
USER node
ENTRYPOINT ["cca"]
