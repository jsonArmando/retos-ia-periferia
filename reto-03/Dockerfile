FROM oven/bun:1.2-alpine
WORKDIR /app
COPY package.json ./
RUN bun install --production
COPY . .
RUN rm -rf out && mkdir -p out && chown -R bun:bun /app
USER bun
ENV PORT=8080 NODE_ENV=production
EXPOSE 8080
HEALTHCHECK CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1
CMD ["bun", "run", "src/server.ts"]
