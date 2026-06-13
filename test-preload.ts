const PROD_MARKER = 'Application Support/tmex'

// 仓库根的测试 preload。覆盖"从根目录直接 `bun test <path>`"的场景——
// 这种调用不会走某个 workspace 的 bunfig.toml（如 apps/gateway/bunfig.toml），
// 会直接继承 shell 里安装版 app.env 的 DATABASE_URL 而写进生产库。
const dbUrl = process.env.DATABASE_URL
if (!dbUrl) {
  process.env.DATABASE_URL = ':memory:'
} else if (dbUrl.includes(PROD_MARKER)) {
  throw new Error(
    `拒绝运行测试：DATABASE_URL 指向生产数据库（${dbUrl}）。` +
      '这是 shell 继承安装版 app.env 导致的，请用 `bun run test` 或显式设置 DATABASE_URL=:memory:',
  )
}

for (const key of ['TMEX_MIGRATIONS_DIR', 'TMEX_FE_DIST_DIR'] as const) {
  const value = process.env[key]
  if (value?.includes(PROD_MARKER)) {
    delete process.env[key]
  }
}
