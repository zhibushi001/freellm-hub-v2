import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 开发代理的后端地址: 默认 3030; 非默认端口的机器用 HUB_HOST_PORT 环境变量覆盖
const hubTarget = `http://localhost:${process.env.HUB_HOST_PORT || '3030'}`;

export default defineConfig({
  plugins: [react()],
  base: '/admin/static/',
  server: {
    proxy: {
      '/api': hubTarget,
      '/v1': hubTarget,
      '/admin': hubTarget,
      '/health': hubTarget,
      '/static': hubTarget,
    },
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
  },
});
