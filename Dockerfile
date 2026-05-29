FROM node:20-alpine AS base
WORKDIR /app
ENV NODE_ENV=production

RUN apk add --no-cache ffmpeg

COPY package*.json ./
RUN npm ci --omit=dev

COPY public ./public
COPY server ./server

EXPOSE 3000
CMD ["npm", "start"]
