// xlsx worker 入口（2026-09-30）
//
// 为什么单独一个文件：`?nodeWorker` 是 electron-vite 打包期的后缀（构建时替换成
//   `new Worker(new URL(产物路径, import.meta.url))` 的包装函数）。把它收在这一个文件里，
//   xlsxWorkerClient 就能用动态 import 容错加载 —— 纯 Node 环境（单测）下拿不到工厂，
//   自动回退进程内实现，不会因为解析不了该后缀而崩。
import createXlsxWorker from './xlsxWorker.js?nodeWorker'

export default createXlsxWorker
