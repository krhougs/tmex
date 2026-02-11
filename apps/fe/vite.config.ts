import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react-swc';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  // 加载环境变量，包括 .env 文件和 process.env
  const env = loadEnv(mode, process.cwd(), '');
  
  // 读取配置，优先级：环境变量 > 默认值
  const gatewayUrl = env.TMEX_GATEWAY_URL || process.env.TMEX_GATEWAY_URL || 'http://localhost:9663';
  const fePort = Number(env.FE_PORT || process.env.FE_PORT) || 9883;
  const gatewayWsUrl = gatewayUrl.replace('http://', 'ws://').replace('https://', 'wss://');

  console.log(`[vite] Gateway URL: ${gatewayUrl}`);
  console.log(`[vite] Frontend port: ${fePort}`);

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
    },
  };
});
