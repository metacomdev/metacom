# metacom share: code-protected hosting of what agents build. One file, no dependencies.
#   docker compose -f share/compose.yml up -d --build
FROM node:24-bookworm-slim
WORKDIR /app
COPY server.js ./
RUN mkdir -p /data && chown node:node /data
USER node
ENV SHARE_DATA=/data NODE_ENV=production
EXPOSE 8910 8911
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:8910/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server.js"]
