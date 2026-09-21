import { defineConfig } from 'tsdown'

// Host 与 Client 必须独立构建：两边的运行环境不同，也不能产生未声明的共享 chunk。
// 输出名与 package.json exports 严格一致：lib/index.js、lib/client.js。
export default defineConfig([
  {
    name: 'dsh-crwu-workbench:host',
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    fixedExtension: false,
    dts: false,
    sourcemap: true,
    clean: true,
  },
  {
    name: 'dsh-crwu-workbench:client',
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    fixedExtension: false,
    dts: false,
    sourcemap: true,
    clean: false,
    deps: {
      // Client 产物由 DSH 的模块表提供 React；其余依赖必须打进插件，不能留下浏览器 import。
      neverBundle: (specifier) => specifier === 'react' || specifier === 'react/jsx-runtime',
      alwaysBundle: (specifier) => specifier !== 'react' && specifier !== 'react/jsx-runtime',
    },
    outputOptions: {
      entryFileNames: 'client.js',
      sourcemapExcludeSources: false,
      banner: 'window.__ModuleLoader__.load({ id: "dsh-crwu-workbench", factory: (require) => {',
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
