FROM node:22-alpine

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY server.js ./

ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://localhost:3000/healthz || exit 1

CMD ["node", "server.js"]
