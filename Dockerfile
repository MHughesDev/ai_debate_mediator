# Single image for Render (now) and Cloud Run (end state) — ADR-0002.
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public

USER node
# $PORT is provided by the platform (design contract #2); 8080 is the local default.
EXPOSE 8080
CMD ["node", "src/index.js"]
