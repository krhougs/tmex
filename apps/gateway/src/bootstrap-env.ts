// 入口最早期加载环境变量：必须在 import config 之前求值。
// import 此模块的副作用即执行 loadEnv()，使 config.ts 读到正确的 process.env。
// 用相对路径而非 @tmex/shared：loadEnv 是 Node-only，未从浏览器侧主入口导出。
import { loadEnv } from '../../../packages/shared/src/env/load-env';

loadEnv();
