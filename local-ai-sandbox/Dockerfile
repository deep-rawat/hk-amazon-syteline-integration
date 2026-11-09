# ---- build stage ----
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- runtime stage ----
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY public ./public
COPY res ./res
# PORT is injected by the platform (Render/Fly); falls back to 9001
ENV PORT=8080
EXPOSE 8080
CMD ["node", "dist/src/index.js"]
