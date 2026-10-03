FROM node:22-alpine

LABEL org.opencontainers.image.title="Hera Monitor" \
      org.opencontainers.image.description="轻量、零依赖、一键部署的服务器监控面板" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app

# 服务端零 npm 依赖，直接拷贝源码即可，无需 npm install
COPY server/ /app/server/
COPY agent/ /app/agent/

ENV HERA_PORT=8080 \
    HERA_HOST=0.0.0.0 \
    HERA_DATA_DIR=/data \
    NODE_ENV=production

RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.HERA_PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/src/index.js"]
