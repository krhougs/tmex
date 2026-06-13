// gateway workspace 测试 preload（apps/gateway/bunfig.toml 引用）。
// 用相对路径：loadEnv 是 Node-only，未从 @tmex/shared 浏览器侧主入口导出。
import { loadEnv } from '../../packages/shared/src/env/load-env';

const PROD_MARKER = 'Application Support/tmex';

// 单元测试接线键：未设或继承到生产库标记时强制内存库，杜绝写入继承的生产库。
// 显式给定的非生产测试路径则保留。
const db = process.env.DATABASE_URL;
if (!db || db.includes(PROD_MARKER)) {
  process.env.DATABASE_URL = ':memory:';
}

// bun test 已将 NODE_ENV 设为 test：loadEnv 命中 test.env，并净化继承的安装版路径键。
loadEnv();
