# Gateway Dockerfile
FROM oven/bun:1 AS builder

WORKDIR /app

# 复制 workspace 配置
COPY package.json bun.lock* ./
COPY packages/shared/package.json packages/shared/
COPY apps/gateway/package.json apps/gateway/

# 安装依赖
RUN bun install

# 复制源代码
COPY packages/shared/ packages/shared/
COPY apps/gateway/ apps/gateway/

# 构建
WORKDIR /app/apps/gateway
RUN bun build src/index.ts --outdir ./dist --target bun

# 生产镜像
FROM oven/bun:1-slim

WORKDIR /app

# 安装 tmux
RUN apt-get update && apt-get install -y tmux openssh-client && rm -rf /var/lib/apt/lists/*

# 创建数据目录
RUN mkdir -p /data

# 复制构建产物
COPY --from=builder /app/apps/gateway/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/apps/gateway/package.json ./

# 非 root 用户运行
RUN useradd -m -u 1000 bunuser && chown -R bunuser:bunuser /app /data
USER bunuser

ENV NODE_ENV=production
ENV DATABASE_URL=/data/tmex.db

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD bun -e "fetch('http://localhost:8080/healthz').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

CMD ["bun", "dist/index.js"]
