FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages ./packages
RUN npm ci
COPY tsconfig.json ./
COPY apps/worker ./apps/worker
RUN npm run build -w @seo-agent/worker
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/worker/dist ./dist
COPY --from=build /app/packages/database/migrations ./packages/database/migrations
CMD ["node", "dist/index.js"]
