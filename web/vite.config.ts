import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';

// 构建产物写入仓库根的 static/。文件名保持稳定（不加哈希）：服务端对所有响应
// 下发 Cache-Control: no-store，哈希毫无收益，稳定名便于部署打包与测试断言。
// publicDir 关闭——图标/manifest/sw/vendor 等静态资源由 static/ 手工维护，
// 构建只产出 index.html 与 assets/。
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../static',
    emptyOutDir: false,
    assetsDir: 'assets',
    modulePreload: {polyfill: false},
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
});
