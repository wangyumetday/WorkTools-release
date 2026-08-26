<!-- ============================================================
     App.vue - 渲染层根组件
     职责：路由出口 + 全局 reset 样式 + 全局自动更新监听器（仅 1 次）
     说明：主壳（带左侧边栏）和悬浮窗壳（紧凑布局）由路由分别挂载，本组件不参与具体布局
     ============================================================ -->

<template>
  <router-view />
</template>

<script setup>
// ============================================================
// 全局自动更新监听器（整个应用只注册一次，不随路由切换反复绑定/解绑）
//   - 配合主进程改造：查到新版本 → 直接 autoDownload 后台下，不再弹原生确认框
//   - 事件由主进程 push（update:state { type, data }），此处消费
//   - 用的是 Naive UI 内部弹窗（离散 API），不弹原生对话框
// ============================================================
import { onBeforeUnmount, onMounted } from 'vue'
import message from '@/shared/message.js'
import dialog from '@/shared/dialog.js'

// 防重复：当前是否已经显示过"下载中"的提示，避免 downloading 事件每 200ms 刷一次都去弹
let downloadingHintShown = false

function handleUpdateState({ type, data }) {
  switch (type) {
    case 'available':
      // 用户选了方案 B：message 提示一条就够，不刷屏
      const v = data && data.version ? `v${data.version}` : ''
      message.info(`发现新版本 ${v}，已开始后台下载…`)
      downloadingHintShown = false
      break

    case 'downloading':
      // downloading 事件推送很频繁（约每 200ms 一次），不弹窗
      //   进度提示交给 Windows 任务栏进度条（mainWindow.setProgressBar 已实现）
      break

    case 'downloaded': {
      const v2 = data && data.version ? `v${data.version}` : ''
      // releaseNotes 来自 GitHub Release body（Markdown 原样透传，dialog 用换行渲染）
      // 如果 Release body 为空就只显示提示文案，不强行塞空字符串
      const notes = data?.releaseNotes ? `\n\n更新内容：\n${data.releaseNotes}` : ''
      dialog.confirm({
        type: 'warning',
        title: `新版本 ${v2} 已下载完成`,
        content: `是否立即重启安装？\n（软件会自动重启）${notes}`,
        positiveText: '立即重启安装',
        negativeText: '稍后再说'
      }).then((ok) => {
        if (ok) {
          // 调主进程 quitAndInstall：退出 + 装更新 + 自动重启
          if (window.api && typeof window.api.update?.quitAndInstall === 'function') {
            window.api.update.quitAndInstall()
          }
        }
        // 用户选"稍后再说"：不做任何事
        //   autoInstallOnAppQuit=true 已经开着，下次用户关软件时会自动装完再退出
      })
      break
    }

    case 'error':
      // 下载或检查出错：弹一条错误，不打断正常使用
      const msg = (data && data.message) ? data.message : '未知错误'
      message.error(`更新失败：${msg}`)
      break

    // checking / not-available：静默，不打扰用户
    default:
      break
  }
}

let updateListener = null

onMounted(() => {
  // 仅当真实 Electron 环境注入了 api.update 时才绑定（dev mock 模式不绑定，避免多次触发 mockNotReady）
  if (window.api && typeof window.api.update?.onStateChange === 'function') {
    // preload 签名：callback(data) 只传一个参数，不是 (event, data)
    updateListener = (payload) => handleUpdateState(payload || {})
    window.api.update.onStateChange(updateListener)
  }
})

onBeforeUnmount(() => {
  // 根组件 onBeforeUnmount 一般不会触发（整个应用退出时才卸载），这里做一个兜底清除
  if (updateListener) {
    try {
      // 兜底：通过 ipcRenderer 直连去掉 listener；若环境里拿不到就跳过，反正进程退出时监听器也会被 OS 回收
      if (typeof window.require === 'function') {
        const { ipcRenderer } = window.require('electron')
        ipcRenderer.removeListener('update:state', updateListener)
      }
    } catch (_) {
      /* 非 Electron 环境不处理 */
    }
    updateListener = null
  }
})
</script>

<style>
/* 全局 reset + html/body/#app 撑满视口 */
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

html, body, #app {
  height: 100%;
  width: 100%;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
}

/* ============================================================
   阶段3：门禁失败闪烁抖动引导动画（全局工具类）
   收到 pcp:pipeline:gateFail 时由 store.blinkTarget 触发对应元素加此类
   3.5s 后 store 自动清空 blinkTarget，动画停止
   各组件只需 :class="{ 'pcp-blink-shake': shouldBlink }" 即可复用
   ============================================================ */
@keyframes pcp-blink-shake-anim {
  0%, 100% { transform: translateX(0); box-shadow: 0 0 0 0 rgba(255, 80, 80, 0); }
  10%, 30%, 50%, 70%, 90% { transform: translateX(-3px); box-shadow: 0 0 8px 2px rgba(255, 80, 80, 0.85); }
  20%, 40%, 60%, 80% { transform: translateX(3px); box-shadow: 0 0 8px 2px rgba(255, 80, 80, 0.85); }
}
.pcp-blink-shake {
  animation: pcp-blink-shake-anim 0.8s ease-in-out infinite;
  outline: 2px solid rgba(255, 80, 80, 0.85);
}
</style>
