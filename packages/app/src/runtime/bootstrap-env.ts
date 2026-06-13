// 生产 runtime 入口最早期加载环境变量：必须在 import 任何读取 config 的模块前求值。
// production 下 loadEnv 走 applyProductionEnv（校验契约 + 打印摘要，不读仓库文件）。
import { loadEnv } from '../../../shared/src/env/load-env';

loadEnv();
