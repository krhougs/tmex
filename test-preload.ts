// 仓库根测试 preload（根 bunfig.toml 引用）。
// 覆盖「从根目录直接 bun test <path>」——这种调用不走某个 workspace 的 bunfig。
// 用相对路径导入：根 node_modules 无 @tmex/shared 的 workspace symlink。
import { loadEnv } from './packages/shared/src/env/load-env';

const PROD_MARKER = 'Application Support/tmex';

// 单元测试接线键：未设或继承到生产库标记时强制内存库，杜绝写入继承的生产库。
// 显式给定的非生产测试路径则保留。
const db = process.env.DATABASE_URL;
if (!db || db.includes(PROD_MARKER)) {
  process.env.DATABASE_URL = ':memory:';
}

// bun test 已将 NODE_ENV 设为 test：loadEnv 命中 test.env，并净化继承的安装版路径键。
loadEnv();
