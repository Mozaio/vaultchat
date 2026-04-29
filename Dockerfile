FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm install
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV VAULTCHAT_SERVE_SPA=1
COPY package.json package-lock.json* ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm install --omit=dev
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/client/dist ./client/dist
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:8787/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/dist/index.js"]
