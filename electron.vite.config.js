// ============================================================
// electron-vite 配置：构建主进程、preload、渲染层三个 bundle
// 配置参考官方文档：
//   - 项目结构（Customizing）：https://evite.netlify.app/guide/dev#customizing
//   - HMR + Hot Reloading：https://evite.netlify.app/guide/hmr-and-hot-reloading
//
// 工作机制（无需手写 watch 配置，由 package.json 的 dev 脚本 "electron-vite dev -w" 驱动）：
//   ① 改 src/**/*.vue → Vite Dev Server 原生 HMR，页面局部热更新不刷新
//   ② 改 electron/**/*.js → electron-vite 自动 rebuild + 重启 Electron 主进程
//      （preload 改完会触发 renderer reload）
// ============================================================

import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'node:path'

export default defineConfig({
  // 主进程 bundle：入口 electron/main.js，输出 out/main/index.js
  main: {
    build: {
      outDir: 'out/main',
      // dev 模式开 sourcemap：VS Code attach 调试时断点才能从 out/main/index.js 映射回 electron/*.js 源码
      sourcemap: true,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'electron/main.js')
        }
      }
    }
  },

  // Preload bundle：入口 electron/preload.js，输出 out/preload/index.js
  preload: {
    build: {
      outDir: 'out/preload',
      sourcemap: true,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'electron/preload.js')
        }
      }
    }
  },

  // 渲染层 bundle：root 设为项目根目录，入口 index.html，输出 out/renderer
  renderer: {
    root: '.',
    resolve: {
      alias: {
        // @ 指向 src 目录，所有渲染层代码统一用 '@/...' 引用，避免相对路径地狱
        '@': resolve(__dirname, 'src')
      }
    },
    plugins: [vue()],
    server: {
      // Windows 下 IDE 异步保存 / 跨盘 / 网盘场景，fs 事件偶发丢失。
      // 开 polling 兜底是 Vite 官方推荐的 Windows 实践，仅作用于 renderer dev server。
      watch: {
        usePolling: true,
        interval: 300
      }
    },
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'index.html')
        }
      }
    }
  }
})
