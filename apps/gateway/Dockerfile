# Gateway Dockerfile
FROM rust:1.90.0-bookworm AS builder

WORKDIR /app

COPY Cargo.toml Cargo.lock ./
COPY crates/ crates/
COPY apps/gateway/Cargo.toml apps/gateway/build.rs apps/gateway/
COPY apps/gateway/drizzle/ apps/gateway/drizzle/
COPY apps/gateway/src-rust/ apps/gateway/src-rust/
COPY packages/shared/src/i18n/locales/ packages/shared/src/i18n/locales/

RUN cargo build --locked --release --package tmex-gateway --bin tmex-gateway

FROM debian:bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl openssh-client tmux \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --uid 1000 tmex \
  && mkdir -p /app /data \
  && chown -R tmex:tmex /app /data

COPY --from=builder /app/target/release/tmex-gateway /usr/local/bin/tmex-gateway

USER tmex
WORKDIR /app

ENV NODE_ENV=production \
  GATEWAY_PORT=8080 \
  TMEX_BIND_HOST=0.0.0.0 \
  DATABASE_URL=/data/tmex.db

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl --fail --silent --show-error http://127.0.0.1:8080/healthz >/dev/null || exit 1

CMD ["tmex-gateway"]
