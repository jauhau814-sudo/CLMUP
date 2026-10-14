FROM node:22.20.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY prisma ./prisma
RUN npx prisma generate
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
COPY public ./public
COPY scripts ./scripts
COPY tests ./tests
RUN mkdir -p uploads && chown -R node:node /app
USER node
EXPOSE 3000
CMD ["sh","-c","npm run db:migrate && npm start"]
