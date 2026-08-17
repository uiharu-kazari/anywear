# Anywear — API server + built web app in one container.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts index.html ./
COPY server ./server
COPY src ./src
COPY public ./public
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
# tsx (used to run the TS server directly) lives in devDependencies, so
# install everything rather than --omit=dev.
RUN npm ci && npm cache clean --force
COPY server ./server
COPY public ./public
COPY --from=build /app/dist ./dist
EXPOSE 8080
CMD ["npx", "tsx", "server/index.ts"]
