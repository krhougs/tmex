import { readFileSync } from 'node:fs';
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react-swc';
import { defineConfig } from 'vite';

// monorepo 版本真相源：发布的 tmex-cli（packages/app）版本。读取失败退回 0.0.0。
function readMonorepoVersion(): string {
  try {
    const pkgPath = path.resolve(__dirname, '../../packages/app/package.json');
    return (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export default defineConfig(({ mode }) => {
  // 前端只需要两个非密钥的接线值：网关地址与前端端口。
  // 这两者由 launcher 经 process.env 提供（dev-supervisor source development.env；
  // e2e 由 playwright 注入）。刻意不在这里加载后端 env 文件——否则会把
  // TMEX_MASTER_KEY 等后端密钥拉进 vite 进程，存在被打进前端 bundle 的风险。
  const gatewayUrl = process.env.TMEX_GATEWAY_URL || 'http://localhost:9663';
  const fePort = Number(process.env.FE_PORT) || 9883;
  const gatewayWsUrl = gatewayUrl.replace('http://', 'ws://').replace('https://', 'wss://');
  const monorepoVersion = readMonorepoVersion();
  const isProd = mode === 'production';

  console.log(`[vite] Gateway URL: ${gatewayUrl}`);
  console.log(`[vite] Frontend port: ${fePort}`);
  console.log(`[vite] Monorepo version: ${monorepoVersion} (prod=${isProd})`);

  return {
    plugins: [tailwindcss(), react()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      port: fePort,
      host: '0.0.0.0',
      allowedHosts: true,
      proxy: {
        '/api': {
          target: gatewayUrl,
          changeOrigin: true,
        },
        '/ws': {
          target: gatewayWsUrl,
          ws: true,
        },
      },
    },
    preview: {
      port: fePort,
      host: '0.0.0.0',
    },
    build: {
      outDir: 'dist',
      sourcemap: true,
    },
    define: {
      // 将关键配置暴露给前端代码
      __GATEWAY_URL__: JSON.stringify(gatewayUrl),
      __MONOREPO_VERSION__: JSON.stringify(monorepoVersion),
      __IS_PROD__: JSON.stringify(isProd),
    },
  };
});
