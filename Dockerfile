FROM node:26-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY skills ./skills
RUN npm run build

FROM node:26-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY ORGANIZATION.md REQUIREMENTS.md ./
RUN mkdir -p /app/.data && chown -R node:node /app
USER node
CMD ["npm", "start"]
