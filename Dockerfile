FROM node:22-alpine

LABEL org.opencontainers.image.title="Hera Monitor" \
      org.opencontainers.image.description="轻量、零依赖、一键部署的服务器监控面板" \
      org.opencontainers.image.url="https://github.com/tmclsamxy/hera-monitor" \
      org.opencontainers.image.source="https://github.com/tmclsamxy/hera-monitor" \
      org.opencontainers.image.documentation="https://github.com/tmclsamxy/hera-monitor#readme" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app

# 服务端零 npm 依赖，直接拷贝源码即可，无需 npm install
COPY server/ /app/server/
COPY agent/ /app/agent/

# ⚠️ HERA_HOST 必须是 0.0.0.0。
# 如果服务只监听 127.0.0.1，Docker 的端口映射无法把外部流量转发进容器 ——
# 症状就是「容器内 lsof 看端口正常，但外面死活访问不了」。
ENV HERA_PORT=8080 \
    HERA_HOST=0.0.0.0 \
    HERA_DATA_DIR=/data \
    NODE_ENV=production

RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 8080

# 使用 exec 形式，避免 shell 解析引号与管道导致健康检查误判
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.HERA_PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "server/src/index.js"]
