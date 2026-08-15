# Build context must be elfina-platform/ (needs access to shared/ and package.json)
FROM node:20-alpine
WORKDIR /app

COPY package.json package-lock.json ./
COPY services/companion-app/package.json services/companion-app/package.json
COPY services/booking-app/package.json services/booking-app/package.json
RUN npm ci --workspace=companion-app --omit=dev

COPY shared shared
COPY services/companion-app services/companion-app

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
CMD ["node", "services/companion-app/src/index.mjs"]
