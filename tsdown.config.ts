import { defineConfig } from 'tsdown'

// host 半 → lib/index.js；client 半 → lib/client.js（浏览器模块，由 web 侧
// __ModuleLoader__ 加载）。两个入口分开打，不要合并。
export default defineConfig({
  entry: ['src/index.ts', 'src/client/index.ts'],
  outDir: 'lib',
  format: 'esm',
  platform: 'neutral',
  dts: false,
  sourcemap: true,
})
