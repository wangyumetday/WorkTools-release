# Electron 透明悬浮窗（floating window / overlay window）业内方案调研报告

- 报告版本：`v1.0`

- 报告日期：`2026-09-02`

- 适用模块：`erc`（汇率换算悬浮窗）

- 适用平台：Windows（仅针对 Windows 10/11，附 macOS/Linux 差异说明）

- 证据形式：联网调研，引用 Electron 官方文档、`electron/electron` 仓库 issue/PR、知名开源库 README/源码

- 现状源文件：`electron/shared/floatingWindow.js`

***

## 1. TL;DR（最关键 5 条结论 + 推荐方案）

1. **`transparent: true`** **在 Windows 上是"高维护成本"特性**：官方文档明确列出限制清单——不可点击穿透透明区域、不可调整大小、DevTools 打开时不再透明、不能用系统菜单/双击标题栏最大化、DWM 禁用时整窗失效。**当前实现已经踩中"不可 resize"这条**,所以才有了自定义 IPC + `setBounds` resize 方案。（来源：[Custom Window Styles — Limitations](https://www.electronjs.org/docs/latest/tutorial/custom-window-styles#limitations)）

2. **`-webkit-app-region: drag`** **吞鼠标事件是"按设计行为"，不是 bug，且 wontfix**：官方文档明确说"可拖拽区域会忽略所有的指针事件"，issue #741 被关闭为 wontfix，issue #41002 维护者回复"expected behavior from an implementation perspective"。**业内主流做法不是放弃它，而是用** **`no-drag`** **在交互元素上挖洞**——VS Code、electron-seamless-titlebar-tutorial、code-meeseeks 都是这么做的。当前实现"完全放弃 drag 改用 IPC 轮询"是**与业内主流相反的方向**。（来源：[#741 wontfix](https://github.com/electron/electron/issues/741)、[Custom Window Interactions](https://www.electronjs.org/docs/latest/tutorial/custom-window-interactions#custom-draggable-regions)）

3. **自定义 IPC +** **`screen.getCursorScreenPoint()`** **+** **`setBounds`** **轮询是已知踩坑路线，但可以工作**：核心陷阱是 DPI 不匹配——`getCursorScreenPoint()` 返回 DIP（设备无关像素），而 `e.screenX` 在 Chromium `use-zoom-for-dsf` 下是 CSS 像素；Windows 11 默认 125% 缩放下，CSS 像素 delta 直接加到 DIP 基线上会让窗口只移动 80% 距离，且 `setBounds` 回写时窗口在 125% 缩放下会逐次"长大"（issue #27651）。OpenScreen PR #110 总结的根治思路是：**拖拽期间窗口宽高保持不变、冻结内容测量、跨显示器时按帧重读 devicePixelRatio**。（来源：[screen API](https://www.electronjs.org/docs/latest/api/screen)、[#27651 setBounds 让窗口越来越大](https://github.com/electron/electron/issues/27651)、[openscreen PR #110 DPI-safe drag](https://github.com/getopenscreen/openscreen/pull/110)、[agentmux PR #867 Win11 125% fix](https://github.com/agentmuxai/agentmux/pull/867)）

4. **`setIgnoreMouseEvents(true, { forward: true })`** **是 hover 展开/收缩稳定性的关键，但有官方 bug**：Electron 在 Windows 上会吞掉 `WM_MOUSELEAVE` 导致 `<body>` 的 `:hover` 状态在鼠标离开后仍永久残留（issue #51521，PR #51539 修复，2026-05 合入主线）。若本项目用 `setIgnoreMouseEvents` 做透明区域穿透,务必关注 Electron 版本,旧版本需要主进程额外发一次合成 `mouseleave` 兜底。（来源：[PR #51539 reset hover state](https://github.com/electron/electron/pull/51539)、[PR #49682 cursor flicker](https://github.com/electron/electron/pull/49682)）

5. **`alwaysOnTop`** **默认** **`'floating'`** **级在 PowerPoint 演示视图、全屏游戏下会失效**：业内已验证的修复是用 `'screen-saver'` 级 + 周期性 re-assert（heartbeat）。本项目 `alwaysOnTop: true` 等价于 `'floating'`,若用户反馈"在某些场景下被盖住",这是首选排查方向。（来源：[sokuji #326 PowerPoint 盖住字幕](https://github.com/kizuna-ai-lab/sokuji/issues/326)、[sokuji PR #432 topmost band 分析](https://github.com/kizuna-ai-lab/sokuji/pull/432)、[BaseWindow setAlwaysOnTop level 枚举](https://www.electronjs.org/docs/latest/api/base-window)）

### 推荐方案（一句话）

**局部加固，不重写。** 现有"自定义 IPC + `setBounds` 拖拽/resize + 透明窗口"的架构与 OpenScreen、electron-drag-window、chameleon 等业内开源方案同源,不是错路。问题集中在三个具体点：(a) 拖拽未做 DPI 缩放导致 Win11 125% 下"拖不动/拖大";(b) mouseup 监听不稳健,鼠标移出窗口/失焦时轮询不停止;(c) alwaysOnTop 用了默认 floating 级,被全屏应用盖住。详见第 10 节落地清单。

***

## 2. Electron 透明窗口官方限制清单

下列条目均来自 Electron 官方文档 `Custom Window Styles → Limitations` 章节,逐条对照本项目现状。

| 限制条目                           | 官方原文/释义                                                                                                                                                                         | 本项目是否触及                                     | 来源                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 透明区域不可点击穿透                     | "You cannot click through the transparent area. See #1335 for details."                                                                                                         | 否（窗口整体可见,不依赖点击穿透）                           | [#1335](https://github.com/electron/electron/issues/1335)                                                |
| 透明窗口不可 resize                  | "Transparent windows are not resizable. Setting `resizable` to `true` may make a transparent window stop working on some platforms."                                            | **是,这是当前实现放弃** **`resizable:true`** **的根因** | [Custom Window Styles](https://www.electronjs.org/docs/latest/tutorial/custom-window-styles#limitations) |
| `blur()` 仅作用于 web 内容,无法模糊窗下内容  | "The CSS `blur()` filter only applies to the window's web contents"                                                                                                             | 否（未用模糊）                                     | 同上                                                                                                       |
| DevTools 打开时窗口不再透明             | "The window will not be transparent when DevTools is opened."                                                                                                                   | 是（开发期需注意,可能误判 bug）                          | 同上                                                                                                       |
| Windows: 不能用系统菜单/双击标题栏最大化      | "Transparent windows can not be maximized using the Windows system menu or by double clicking the title bar."                                                                   | 否（窗口 `maximizable: false` 且本就不期望最大化）        | 同上 / [PR #28207](https://github.com/electron/electron/pull/28207)                                        |
| Windows: DWM 禁用时整窗失效           | （旧版文档列出 "Transparent windows will not work when DWM is disabled."）                                                                                                              | 否（现代 Win10/11 默认开 DWM,但服务器核心版/精简版 Win 可能中招） | [旧版 docs](https://github.com/cuongta/electron/blob/master/docs/tutorial/custom-window-styles.md)         |
| macOS: 透明窗口无原生阴影               | "The native window shadow will not be shown on a transparent window."                                                                                                           | N/A（本项目仅 Windows）                           | [Custom Window Styles](https://www.electronjs.org/docs/latest/tutorial/custom-window-styles#limitations) |
| Wayland: 创建后无法程序级 resize/移动/失焦 | BaseWindow Platform notices: "It is generally not possible to programmatically resize windows after creation, or to position, move, focus, or blur windows without user input." | N/A（仅 Windows）                              | [BaseWindow Platform notices](https://github.com/electron/electron/blob/main/docs/api/base-window.md)    |

### 透明窗口在 Windows 下的已知 bug

| 现象                                                             | 影响版本                       | 根因/状态                                                             | 来源                                                                                                                         |
| -------------------------------------------------------------- | -------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `resizable: true` 让透明窗口 resize 失效（用户引用的 #48554）                | v39.0.0-beta.3+（2025-10 起） | 由 PR #48378 引入的回归,PR #49428 已修;但官方仍长期建议透明窗口配 `resizable: false`   | [#48554](https://github.com/electron/electron/issues/48554) / [PR #49428](https://github.com/electron/electron/pull/49428) |
| Win10 下透明窗口背景变白/半透白（#48592）                                    | v39.0.0-beta.3+            | 同 PR #48378 引入,最小化还原或拖出显示器再拖回会触发                                  | [#48592](https://github.com/electron/electron/issues/48592)                                                                |
| 透明 + `alwaysOnTop: true` 窗口在与其他 alwaysOnTop 窗口交互时闪烁/消失（#44967） | v26+                       | 当点击其他 alwaysOnTop 窗口时透明窗口被瞬时隐藏,visibility 事件也不触发                  | [#44967](https://github.com/electron/electron/issues/44967)                                                                |
| 透明窗口在某些 Windows 系统变黑/灰底（#40515）                                | v25–v37                    | 与硬件加速有关,禁用硬件加速可缓解,但只能整 app 禁不能按窗口禁                                | [#40515](https://github.com/electron/electron/issues/40515)                                                                |
| 透明窗口 resize/移动有视觉残影、阴影残留                                       | 多版本                        | macOS MAS build 有重影 bug (#46352),Windows 上 `hasShadow` 在透明窗下行为不一致 | [#46352](https://github.com/electron/electron/issues/46352)                                                                |

### 与 click-through / `setIgnoreMouseEvents` 的官方说明

官方在 `Custom Window Interactions → Click-through windows` 章节明确：调用 `win.setIgnoreMouseEvents(true)` 可让窗口忽略所有鼠标事件;**在 Windows 和 macOS 上**,可传 `{ forward: true }` 把鼠标移动消息转发回 web 内容,从而允许 `mouseleave` 等事件被发出。Linux 不支持 `forward`。（来源：[Custom Window Interactions — Click-through windows](https://www.electronjs.org/docs/latest/tutorial/custom-window-interactions#click-through-windows)）

***

## 3. 拖拽方案对比

### 3.1 三套方案优劣表

| 维度          | A. `-webkit-app-region: drag` + `no-drag` 挖洞               | B. 自定义 IPC + `getCursorScreenPoint()` 轮询 + `setBounds`      | C. `app.region: drag` 主体 + 局部自定义 IPC 兜底 |
| ----------- | ---------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------- |
| 官方支持        | ✅ 官方推荐路径,文档示例即此                                            | ⚠️ 未官方文档化,但 API 全公开                                         | ✅ 主路径官方,兜底属自定义                          |
| 鼠标事件        | ❌ drag 区吞所有指针事件（click/enter/leave）                         | ✅ 不影响渲染层事件                                                  | ✅ 主体不影响,局部用兜底                           |
| 拖拽流畅度       | ✅ OS 级,60fps,无 IPC 开销                                      | ⚠️ 受轮询频率限制（16ms/20ms）,跨进程 IPC 有抖动                           | ✅ 主体流畅,兜底局部受轮询限制                        |
| DPI 适配      | ✅ OS 自动处理                                                  | ❌ 需手动按 devicePixelRatio 缩放 delta,Win11 125% 必踩              | ✅ 主体自动,兜底需手动处理                          |
| 跨屏拖拽        | ✅ OS 自动                                                    | ❌ 跨不同 DPI 显示器会"跳变",需按帧重读 DPI                                | ✅ 主体自动                                  |
| mouseup 可靠性 | ✅ OS 保证                                                    | ❌ 鼠标移出窗口/失焦时 document mouseup 不触发,需主进程兜底                    | ✅ 主体可靠                                  |
| 透明窗口兼容      | ✅                                                          | ✅（`setBounds` 不受透明窗口 resize 限制）                             | ✅                                       |
| 业内采用度       | ⭐⭐⭐⭐⭐ 主流（VS Code/Slack/Discord/Postman/Notion/1Password 等） | ⭐⭐⭐ 中等（electron-drag-window、OpenScreen HUD、Typhon Note、本项目） | ⭐⭐ 较少（需明确场景）                            |

### 3.2 `-webkit-app-region: drag` 的官方行为与 workaround

**官方文档明确**（[Custom Window Interactions](https://www.electronjs.org/docs/latest/tutorial/custom-window-interactions#custom-draggable-regions)）：

> "Setting `app-region: drag` marks a rectangular area as draggable. It is important to note that **draggable areas ignore all pointer events**. For example, a button element that overlaps a draggable region will not emit mouse clicks or mouse enter/exit events within that overlapping area. Setting `app-region: no-drag` reenables pointer events by excluding a rectangular area from a draggable region."

**为什么吞事件**：`-webkit-app-region: drag` 是 OS 级 hook,Chromium 在渲染层扫描该 CSS 区域,通过 `WM_NCHITTEST` 把对应区域映射为 `HTCAPTION`（Windows）,此后该区域所有鼠标消息直接进入 OS 的窗口拖拽流程,根本不到 web 内容的事件队列。（来源：[NanmiCoder/cc-haha #874 窗口无法拖动问题分析](https://github.com/NanmiCoder/cc-haha/issues/874) —— 该 issue 用一段反编译式注释解释了 Windows 上 `WS_POPUP` + hit-test 的整个流程,可作为参考,但本质是 Electron/Chromium 既有行为）

**官方 workaround**：文档给出的不是"换方案",而是"挖洞"——对需要交互的元素单独写 `app-region: no-drag`,该矩形区就被排除出拖拽,恢复指针事件。VS Code 的 activitybar、statusbar、tabs-container 全部用 `drag`,而其中的 action-bar、statusbar-item、tab 等交互元素各自 `no-drag`。（来源：[Titlebar-Less VSCode 扩展 CSS](https://marketplace.visualstudio.com/items?itemName=lehni.vscode-titlebar-less-macos)）

**wontfix 状态**：issue #741（"-webkit-app-region drag disables parts of UI"）被关闭为 wontfix,核心维护者 zcbenz 的回复链接到 #1354 的说明：这是 Chromium hit-test 模型固有行为,改不动。（来源：[#741 wontfix](https://github.com/electron/electron/issues/741)、[#1354](https://github.com/electron/electron/issues/1354)）

**已知副作用**：当鼠标从外部进入 `-webkit-app-region: drag` 区域时,`mouseleave` 不被触发,前一元素的 hover 状态残留。社区已知 workaround 是允许 1px 间距让 mouseout 被"看见"。（来源：[#741 评论](https://github.com/electron/electron/issues/741#issuecomment-60480286)）

### 3.3 业内主流应用拖拽方案调研

| 应用                                     | 方案                                                 | 关键证据                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **VS Code**                            | `app-region: drag` + `no-drag` 分区                  | Custom UI Style 扩展复刻 VS Code 风格的 CSS: `.activitybar, .statusbar, .tabs-container, .sidebar .composite.title { -webkit-app-region: drag; }` 加 `.content .monaco-action-bar, .statusbar-item, .tab { -webkit-app-region: no-drag; }`（来源：[Titlebar-Less VSCode for macOS](https://marketplace.visualstudio.com/items?itemName=lehni.vscode-titlebar-less-macos)） |
| **VS Code 主仓**                         | 同上                                                 | 官方 `titleBarStyle: hidden` 配合渲染层 drag/no-drag 分区,Windows 上加 `titleBarOverlay` 让系统继续画最小化/最大化/关闭按钮（来源：[Custom Title Bar 教程](https://www.electronjs.org/zh/docs/latest/tutorial/custom-title-bar)）                                                                                                                                                               |
| **Slack 桌面版**                          | `app-region: drag` + 自绘标题栏                         | Fourier 公司的复刻教程以 Slack 为目标,用 `-webkit-app-region: drag` + `titleBarOverlay`（来源：[FOURIER-Inc/electron-frameless-window](https://github.com/FOURIER-Inc/electron-frameless-window)、[Fourier 博客](https://www.fourier.jp/blog/how-to-customize-the-title-bar-of-electron)）                                                                                        |
| **Hyper terminal**                     | `app-region: drag`                                 | electron-seamless-titlebar-tutorial 明确说"I was inspired by the way Hyper terminal achieved a native look"（来源：[electron-seamless-titlebar-tutorial](https://github.com/binaryfunt/electron-seamless-titlebar-tutorial/blob/master/README.md)）                                                                                                                   |
| **code-meeseeks**                      | `app-region: drag` + `titleBarOverlay`             | PR 描述明确："拖拽实现：整条标题栏 `-webkit-app-region: drag`,其中的按钮/链接/输入等交互元素各自 `no-drag`,否则点击被当成拖窗"（来源：[code-meeseeks PR #30](https://github.com/huhamhire/code-meeseeks/pull/30/files)）                                                                                                                                                                                   |
| **Typhon Note / electron-drag-window** | 自定义 IPC + `getCursorScreenPoint()` + `setPosition` | npm 库,README 明确说不使用 `-webkit-app-region`,但建议"结合 `-webkit-app-region` 一起使用"（来源：[electron-drag-window](https://github.com/TyphonEX/electron-drag-window)）                                                                                                                                                                                                       |
| **OpenScreen HUD**                     | 自定义 IPC + `setBounds`（透明窗口）                        | PR #110 详细描述了"拖拽期间窗口宽高保持不变、冻结内容测量、跨屏按帧重读 DPI"的修复（来源：[openscreen PR #110](https://github.com/getopenscreen/openscreen/pull/110)）                                                                                                                                                                                                                               |

**结论**：业内主流应用（VS Code 系、Slack、Hyper）几乎全部用 `-webkit-app-region: drag` + `no-drag` 挖洞。纯自定义 IPC 路线只在透明窗口 + 鼠标事件必须穿透的非常规场景出现。**本项目"鼠标进入展开"需求确实与 drag 区吞事件冲突**,但解决方案不是放弃整个 drag 机制,而是只把 drag 限定在不需要 hover 展开的窄条上,展开后的内容区单独 `no-drag`。

### 3.4 自定义 IPC + `setBounds` 拖拽的"拖动无效"成因清单

对照本项目 `floatingWindow.js` 的 `startDrag()`,逐条排查：

| 成因                                              | 现象                                                                  | 是否可能命中本项目                                                                   | 来源/证据                                                                                                                                                                                                          |
| ----------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **DPI 缩放不匹配**                                   | Win11 125% 缩放下,鼠标移动 100px,窗口只移动 80px,甚至看起来"拖不动"                     | ⚠️ 高度可疑（用户 Windows 缩放未知）                                                    | [agentmux PR #867](https://github.com/agentmuxai/agentmux/pull/867):`e.screenX` 是 CSS 像素,`get_window_position` 返回物理像素,在 125% 下窗口只移动 80% 距离                                                                     |
| **`setBounds`** **回写让窗口逐次"长大"**                 | 每次拖动后窗口变大,直到塞满屏幕                                                    | ⚠️ 已知 bug,本项目未显式按 DPI 缩放 width/height                                       | [#27651 setBounds make BrowserWindows larger every time on Windows](https://github.com/electron/electron/issues/27651)                                                                                         |
| **`screen.getCursorScreenPoint()`** **坐标系误解**   | 多显示器跨屏时窗口"跳变"                                                       | ⚠️ 该 API 返回 DIP 而非物理像素,主屏 100% + 副屏 150% 下跨屏拖拽会错位                           | [screen API 文档](https://www.electronjs.org/docs/latest/api/screen):"The return value is a DIP point, not a screen physical point."                                                                             |
| **document mouseup 不触发**                        | 鼠标移出窗口外抬起,主进程 `dragTimer` 永不停止,持续 setBounds 到屏幕另一处                  | ⚠️ 本项目监听的是 document mouseup,窗口失焦/鼠标离开时不可靠                                   | [electron-drag-window README](https://github.com/TyphonEX/electron-drag-window)、[OpenScreen PR #110](https://github.com/getopenscreen/openscreen/pull/110) 的"defer content-driven HUD resizing while dragging" |
| **`ipcMain.handle`** **异步开销**                   | `dragStart` 是 `invoke`,返回 Promise 后才启动轮询,首次按下到第一次 setBounds 有 1 帧延迟 | 低（首帧延迟感受不到）                                                                 | [ipcMain.handle 文档](https://www.electronjs.org/docs/latest/api/ipc-main)                                                                                                                                       |
| **窗口未聚焦时拖拽失败**                                  | 用户点击其他应用后,悬浮窗虽然可见,但 drag 不响应                                        | 中（`alwaysOnTop: true` 时窗口仍可见,但 drag 仍需要鼠标 mousedown 才触发,渲染层是否能收到事件依赖窗口焦点状态） | [juejin 文](https://juejin.cn/post/7262945227178786876) 的实现里就检查了 `win.isFocused()`                                                                                                                              |
| **`isAnimating`** **互斥锁卡住**                     | 展开/收缩动画中触发 drag 会被 `if (isAnimating) return` 拦下                     | ⚠️ 中（动画 200ms,期间 mousedown 直接被吞）                                            | 本项目 `floatingWindow.js:193`                                                                                                                                                                                    |
| **`resizable: false`** **透明窗口的 setBounds 行为异常** | `setBounds` 改位置但宽高不生效,或窗口"扭曲"                                       | ⚠️ 已知限制,本项目靠每次 setBounds 都传完整 `{x,y,w,h}` 缓解                                | [#48554](https://github.com/electron/electron/issues/48554) / [Custom Window Styles](https://www.electronjs.org/docs/latest/tutorial/custom-window-styles#limitations)                                         |

### 3.5 mouseup 监听可靠性对比

| 监听方式                                            | 可靠性   | 已知失败场景                         | 建议                      |
| ----------------------------------------------- | ----- | ------------------------------ | ----------------------- |
| 渲染层 `document.addEventListener('mouseup', ...)` | ⚠️ 中  | 鼠标移出窗口边界时 mouseup 不到达 document | 配合主进程兜底                 |
| 渲染层 `window blur` 事件                            | ⚠️ 中  | 拖拽中切到其他应用时触发,但"鼠标抬起但未离开窗口"不会触发 | 作为兜底                    |
| 主进程定时器检测 `win.isFocused()` 失活                   | ✅ 高   | 用户切应用后 1 帧内失活,主动停轮询            | electron-drag-window 采用 |
| 主进程监听 `screen` 的全局鼠标抬起（无原生 API）                 | ❌ 不可行 | Electron 不提供全局 mouseup 事件      | 改用兜底组合                  |
| Windows 全局钩子（uIOhook 等原生模块）                     | ✅ 高   | 引入 native 依赖,跨平台一致性差           | 重型方案,本项目不需要             |

**业内最稳的组合**：渲染层 mousedown → IPC dragStart → 主进程启动轮询;渲染层 document mouseup + window blur → IPC dragStop;**主进程轮询内每帧检查** **`win.isFocused()`** **或** **`screen.getCursorScreenPoint()`** **是否长时间未变,失活则自停**。electron-drag-window、juejin 那篇都用了 `isFocused()` 检查。（来源：[electron-drag-window 源码思路](https://github.com/TyphonEX/electron-drag-window)、[juejin 自定义窗口拖动](https://juejin.cn/post/7262945227178786876)）

### 3.6 更优方案候选

| 候选                                               | 适用性     | 评价                                                                                               |
| ------------------------------------------------ | ------- | ------------------------------------------------------------------------------------------------ |
| `app-region: drag` 在 drag-bar 上 + `no-drag` 在交互区 | ✅ 强烈推荐  | 让 OS 处理拖拽,DPI/多屏/聚焦全免费;只在 drag-bar 窄条上禁用 hover 展开,展开后的内容区照常响应鼠标                                  |
| `will-resize` 事件（BrowserWindow）                  | ⚠️ 不适用  | 只在 OS 级 resize 触发,透明窗口 `resizable: false` 不触发                                                    |
| `setPosition` 替代 `setBounds`                     | ✅ 可选    | 拖拽只改位置时 `setPosition(x,y)` 比 `setBounds({x,y,w,h})` 更稳,不会触发尺寸回算/扭曲。但需要单独传 width/height 给 setSize |
| `screen.getCursorScreenPoint()` vs 全局 mouse hook | ✅ 现状已够用 | 全局 hook（uIOhook）引入 native 依赖,本项目无需                                                               |

***

## 4. Resize 方案对比

### 4.1 透明窗口下程序级 `setBounds` resize 的已知问题

| 问题                            | 现象                                                                                                         | 来源                                                                              |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| DPI 缩放下尺寸漂移                   | Win11 125% 下反复 setBounds 同一尺寸,窗口逐次变大                                                                       | [#27651](https://github.com/electron/electron/issues/27651)                     |
| `minWidth/minHeight` 在缩放下边界异常 | 透明窗口的最小尺寸约束在跨 DPI 屏间表现不一致                                                                                  | [#27651 评论链](https://github.com/electron/electron/issues/27651)                 |
| 与 `alwaysOnTop` 冲突            | setBounds 期间若其他 alwaysOnTop 窗口插入,会触发闪烁/层级重排                                                                | [#44967](https://github.com/electron/electron/issues/44967)                     |
| 内容测量反馈环                       | 透明 + 非 resizable 窗口在分数 DPI 下 setBounds 可能"发布"略有不同的 Chromium viewport,内容测量把瞬态 viewport 反馈回 native 尺寸,形成自我放大 | [OpenScreen PR #110 根因分析](https://github.com/getopenscreen/openscreen/pull/110) |

### 4.2 色键（magenta chroma key）方案 vs 透明窗口

**方案对比**：

| 方案                                                   | 实现                                                                                | 优点                                      | 缺点                                                          |
| ---------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------- |
| 当前：`transparent: true` + rgba 背景                     | Electron 创建 layered window,逐像素 alpha                                              | 真透明,任意形状                                | 不可 `resizable: true`,DWM 异常时失效,DevTools 打开时失效               |
| 替代：`transparent: false` + 纯色背景 + 颜色键穿透               | 设置 `backgroundColor: '#magenta'` 等键色,Win32 用 `SetLayeredWindowAttributes` 把该色当透明键 | 可保留 `resizable: true`,可获 OS 级 resize 边界 | 视觉效果差——键色会"漏色",渲染层不能含该色;Electron 官方未直接暴露颜色键 API,需 native 模块 |
| 替代：`transparent: false` + 矩形不透明 + 圆角阴影模拟             | 普通窗口 + CSS 圆角 + box-shadow                                                        | 最稳,获得全部 OS 能力                           | 不能真正"悬浮"在内容之上（背景必为不透明矩形）                                    |
| 替代：vibrancy/acrylic（`backgroundMaterial: 'acrylic'`） | Windows 11 原生 acrylic 模糊背景                                                        | OS 级视觉效果,稳定                             | 仅 Win11,Win10 退化为纯色                                         |

**业内主流稳定性排序**（从稳到不稳）：

1. `transparent: false` + `titleBarStyle: hidden` + `titleBarOverlay` + 普通矩形窗口（VS Code/Slack 路线）
2. `transparent: true` + `frame: false` + `resizable: false` + 自定义 IPC（本项目、OpenScreen、KoBar 路线）
3. 颜色键穿透（极少见,Electron 不直接支持）

**结论**：本项目"半透明置顶悬浮"业务目标无法用方案 1（背景必为不透明矩形）。颜色键方案需要 native 模块,且 Electron 未暴露 API,投入产出比低。**保留** **`transparent: true`** **+ 自定义 IPC resize 是合理选择**,但必须修复 DPI 缩放问题。

### 4.3 8 方向 resize 手柄的成熟实现参考

`SystemUI-js/chameleon` PR #3 是一份清晰的 8 方向 resize 实现参考,要点：

- 8 个方向：`n, s, e, w, ne, nw, se, sw`

- 用 **Pointer Events**（`pointerdown/move/up`）而非 `mouse*`,统一鼠标/触控/笔

- 用 **`setPointerCapture`** 防止拖拽过程中事件丢失（这是关键——比单纯监听 document mouseup 更稳）

- `minWidth/minHeight` 约束

- `requestAnimationFrame` 节流到 60fps

- 拖拽期间给窗口加 `isDragging` 类,提升 z-index

- 拖拽期间用 `pointer-events: none` 禁用 iframe 穿透

- 两种交互模式：`follow`（实时更新尺寸）、`static`（仅在结束更新）

（来源：[chameleon PR #3](https://github.com/SystemUI-js/chameleon/pull/3)）

本项目 `floatingWindow.js:229-283` 的 `startResize` 用的是 `setInterval(…, 16)` 轮询,没有 `setPointerCapture`,没有 `isFocused()` 兜底,可参考 chameleon 加固。

### 4.4 Tauri 的对比

Tauri v2 对 frameless + transparent 的处理：

- `decorations: false` 去掉 OS title bar

- `transparent: true`（macOS 需要 `macOSPrivateApi: true`）

- 拖拽用 `data-tauri-drag-region` HTML 属性,语义同 `-webkit-app-region: drag`,Tauri 也忽略落在 `no-drag`/交互子元素上的点击（与 Electron 同模型）

- Windows 上的 frameless 窗口仍**有阴影**（`tauri-plugin-frameless-window` 明确："decoration-less window with shadow on Windows"）

- 模糊背景用 `window-vibrancy` crate：macOS `apply_vibrancy`,Windows `apply_acrylic`/`apply_mica`

（来源：[puredashboard DESKTOP.md](https://github.com/madnh/puredashboard/blob/main/docs/DESKTOP.md)、[tauri-plugin-frameless-window](https://lib.rs/crates/tauri-plugin-frameless-window)）

**Tauri 相对 Electron 的优势**：Windows frameless 仍有原生阴影（Electron 透明窗口无阴影）、原生 acrylic/mica 模糊（Electron `backgroundMaterial` 在 v30+ 才支持）。**劣势**：Tauri 生态远小于 Electron,Windows API 暴露面小,自定义 IPC 路线难走。本项目已经基于 Electron,无需迁移。

***

## 5. 展开/收缩 + hover 的稳定性模式

### 5.1 用 `setBounds` 做尺寸动画的常见 bug

本项目 `animateResize()`（`floatingWindow.js:143-166`）用 `setInterval(16ms)` + `setBounds` 做尺寸动画,常见 bug：

| Bug                          | 现象                                            | 根因                                                                 |
| ---------------------------- | --------------------------------------------- | ------------------------------------------------------------------ |
| mouseenter/mouseleave 在动画中抖动 | 鼠标停在窗口边缘,窗口尺寸变化让鼠标"在/不在"窗口内反复跳变               | setBounds 改变窗口边界,mouseenter/leave 在边界穿越时触发                         |
| mouseleave 误触收缩              | 展开动画过程中,鼠标恰好"被推到窗口外"                          | 同上                                                                 |
| 鼠标停在边缘的抖动                    | 窗口尺寸反复小幅震荡                                    | 收缩动画 + mouseenter → 展开 → mouseleave → 收缩…形成反馈环                     |
| 动画期间阻塞 drag/resize           | `isAnimating` 互斥锁导致动画 200ms 内 drag/resize 无响应 | 本项目 `floatingWindow.js:170, 178, 192` 都有 `if (isAnimating) return` |

### 5.2 业内 hover 展开/收缩的成熟模式

| 模式                                  | 描述                                                                                  | 来源                                                |
| ----------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------- |
| **debounce + delay**                | mouseleave 后延迟 N ms 才真正触发收缩,期间 mouseenter 取消                                        | 通用前端模式,本项目 300ms delay 即此                         |
| **isHover lock**                    | 收缩动画启动后,若 mouseenter 在动画完成前到达,立即取消动画                                                | 本项目 `if (isAnimating) return` 是"拒绝",不是"取消",需改为可中断 |
| **pointer-events: none 中间态**        | 动画期间给整个内容区设 `pointer-events: none`,让 mouseenter/leave 暂时失效                          | 防止动画中事件抖动                                         |
| **CSS transform 滑入滑出（窗口尺寸不变）**      | 窗口始终为展开态尺寸,内容区用 `transform: translateY(-100%)` 隐藏到顶上,hover 时 `translateY(0)` 滑下     | 性能最佳,无 setBounds 抖动,但视觉上窗口背景始终展开（仅内容隐藏/显示）        |
| **`setIgnoreMouseEvents`** **主动穿透** | 收缩态下整窗 `setIgnoreMouseEvents(true, {forward: true})`,hover 区元素 mouseenter 时切回 false | 适合"窄条留底"场景                                        |

**`setIgnoreMouseEvents`** **forward 的 Windows bug（必读）**：

PR #51539（2026-05 合入主线）修复了 issue #51521：当 `setIgnoreMouseEvents(true, { forward: true })` 在 Windows 上激活时,`SubclassProc` 故意吞掉 `WM_MOUSELEAVE` 防闪烁,但后续调 `setIgnoreMouseEvents(false)` 重启鼠标事件时,被吞的 `WM_MOUSELEAVE` 不会重发,导致 `<body>` 的 `:hover` 永久残留。修复方案：禁用 forwarding 时检查光标是否仍在 client 区,若已离开则补发一次合成 `WM_MOUSELEAVE`。

（来源：[PR #51539 fix: reset hover state when disabling mouse event forwarding on Windows](https://github.com/electron/electron/pull/51539)、[PR #49682 fix cursor flicker when setIgnoreMouseEvents forwards messages](https://github.com/electron/electron/pull/49682)）

**对本项目的启示**：若 hover 展开/收缩出现"鼠标已经移开但状态卡住",优先排查是否使用了 `setIgnoreMouseEvents` forward 路径,以及 Electron 版本是否已含 #51539 修复。

### 5.3 是否应改用 CSS transform 做内容动画

**结论：强烈建议改。** 当前 `setBounds` 做窗口尺寸动画,触发 mouseenter/leave 抖动 + DPI 缩放下尺寸漂移 + 透明窗口下渲染层 viewport 重算。改为：

- 窗口尺寸**始终维持展开态**（或可切到展开态一次后保持不变）

- 内容区用 CSS `transform: translateY()` / `opacity` 做滑入滑出动画,GPU 合成,无 setBounds 开销

- 收缩态视觉上 = 内容区滑到窗口顶部,留出 drag-bar 窄条区域可见

- 缺点：窗口背景矩形始终展开,需要把"窗口背景的视觉填充"和"内容区"分离——背景可以保持透明,只让内容区滑入滑出

这个改造与 OpenScreen PR #110 的"defer content-driven HUD resizing while dragging"思路一致——尽量减少 `setBounds` 调用频次。

***

## 6. 透明度方案

### 6.1 `setOpacity` vs 渲染层 rgba 背景 vs `transparent: true` 对比

| 维度                 | `win.setOpacity(x)`                  | 渲染层 `background: rgba(...)`    | `transparent: true`（窗口构造参数） |
| ------------------ | ------------------------------------ | ------------------------------ | --------------------------- |
| 作用层                | OS 窗口级（Windows layered window alpha） | web 内容级                        | 窗口是否启用 alpha 通道             |
| 控制粒度               | 整窗（含边框、内容、文字）                        | 仅 web 内容背景                     | 二值开关                        |
| 与 `transparent` 关系 | 独立,可与 `transparent: false` 共用        | 需 `transparent: true` 才能透出窗下内容 | 是启用 rgba 背景透出窗下内容的前提        |
| 性能                 | 高（OS 直接合成）                           | 中（Chromium 合成）                 | 低（透明窗口禁用部分 GPU 优化路径）        |
| Windows bug        | 见下表                                  | 依赖 `transparent` 的 bug 全继承     | 见 §2                        |

### 6.2 `setOpacity` 在 Windows 的已知 bug

| Bug                                  | 现象                    | 来源                                                                                 |
| ------------------------------------ | --------------------- | ---------------------------------------------------------------------------------- |
| 与 `transparent: true` 配合时,某些缩放下透明度抖动 | 调用 setOpacity 后窗口短暂闪烁 | [#44967 透明窗口与 alwaysOnTop 交互闪烁](https://github.com/electron/electron/issues/44967) |
| Win10 某些版本下 setOpacity 不生效           | 透明度无变化                | [#48592 链路相关](https://github.com/electron/electron/issues/48592)                   |
| 与 alwaysOnTop 切换配合时窗口消失              | 改 alwaysOnTop 后整窗不可见  | [#44967](https://github.com/electron/electron/issues/44967)                        |

**本项目现状**：`floatingWindow.js:286-293` 用 `setOpacity` 控制整窗透明度,边界 0.1\~1.0,clamp 后调用。属合理用法。需注意：`setOpacity` 与 `transparent: true` 同时使用时,Windows 上 opacity 会乘到透明窗的 alpha 通道,可能在某些驱动下表现异常。

**业内更稳的做法**：

- 想要"整窗半透明"用 `setOpacity`（OS 级,稳）

- 想要"背景半透明但内容不透明"用渲染层 `rgba` 背景 + 内容元素 `opacity: 1`

- 不要混用两者

***

## 7. 多显示器 / DPI / 高分屏问题

### 7.1 `screen.getCursorScreenPoint()` 坐标系

**官方文档明确**（[screen API](https://www.electronjs.org/docs/latest/api/screen)）：

> "`screen.getCursorScreenPoint()` Returns Point — The current absolute position of the mouse pointer. **The return value is a DIP point, not a screen physical point.**"

DIP（Device Independent Pixel,设备无关像素）= 物理像素 / DPI 缩放因子。Win11 默认 125% 缩放下,DIP=80 对应物理 100px。

### 7.2 `setBounds` 在不同 display 下的行为

- `setBounds({x, y, width, height})` 接受 **DIP** 坐标

- 跨显示器（主屏 100% + 副屏 150%）时,同一个 DIP 数值在不同屏上对应不同物理尺寸

- `minWidth/maxWidth` 在缩放下行为不一致,已知 bug（[#27651](https://github.com/electron/electron/issues/27651)）

- Wayland 下创建后不能程序级 resize（官方说明,本项目仅 Windows 不受影响）

### 7.3 跨显示器拖拽时窗口"跳变"的成因

agentmux PR #867 的 retro 文档精确描述了机制：

> "`e.screenX` in CEF/Chromium with `use-zoom-for-dsf` (default on Windows since Chrome 54) is in **CSS pixels** (physical ÷ devicePixelRatio). `get_window_position` returns and `set_window_position` consumes **physical pixels** in the PMv2-aware host. The original fix added CSS-pixel deltas to a physical-pixel baseline."

Win11 125%（`dpr = 1.25`）下,窗口只移动 80% 距离——同样的可见漂移,不同机制。

**官方 workaround**：

- 用 `screen.screenToDipPoint(point)` 和 `screen.dipToScreenPoint(point)` 在物理像素与 DIP 间转换（仅 Windows/Linux）

- 用 `screen.screenToDipRect(window, rect)` 和 `screen.dipToScreenRect(window, rect)` 转换矩形

- 监听 `display-metrics-changed` 事件,在 scaleFactor 变化时重设 `webPreferences.zoomFactor`

- 拖拽时**按帧重读** **`window.devicePixelRatio`**,跨屏自动适应新值（agentmux 修复方案）

（来源：[screen API](https://www.electronjs.org/docs/latest/api/screen)、[agentmux PR #867 retro BUG\_WINDOW\_DRAG\_CURSOR\_DRIFT](https://github.com/agentmuxai/agentmux/pull/867)）

### 7.4 OpenScreen 的根治思路（值得直接借鉴）

OpenScreen PR #110 "make Windows capture and HUD drag DPI-safe" 的根因分析：

> "Capture crossed Electron DIPs, potentially DPI-virtualized Win32 coordinates, and WGC physical pixels. At fractional scaling or on a non-primary/rotated display, the cursor could be normalized against a rectangle from a different coordinate space. An in-flight request could also be combined with later mutable source state."

修复要点（逐条对应本项目可落地）：

1. **每帧从不可变的 drag-start cursor + 完整 window bounds 计算新位置**（不读取中间态）
2. **`setBounds`** **每帧传入原始 width/height**（不让 setBounds 期间的 viewport 反馈改变尺寸）
3. **拖拽期间冻结内容测量**（pointer down 期间不让渲染层量内容尺寸）
4. **拖拽结束后做一次最终内容测量**
5. 切换横/竖布局前清空 viewport 补偿
6. 大幅 layout 变化绝不当作 DPI 舍入处理

（来源：[OpenScreen PR #110](https://github.com/getopenscreen/openscreen/pull/110)）

***

## 8. 生命周期与事件清理 checklist

### 8.1 关闭顺序与 preload 重复加载

| Checklist                                           | 当前实现                                                                                                                                              | 风险    |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| 悬浮窗 `closed` 事件清理 stopDrag/stopResize/animateResize | ✅ `floatingWindow.js:115-121` 已做                                                                                                                  | 低     |
| 主窗口 `closed` 时销毁悬浮窗                                 | ✅ `floatingWindow.js:314-327` 已做                                                                                                                  | 低     |
| preload 不重复加载                                       | ⚠️ 每次新建窗口都加载 preload,若 preload 有顶层副作用会重复                                                                                                          | 中     |
| 主窗口重新创建后 `registerFloatingController` 是否重复注册 IPC    | ⚠️ **`floatingWindow.js:302-312`** **每次 register 都** **`ipcMain.handle`,二次注册会抛** **`Attempted to register a second handler for 'floating:open'`** | **高** |

### 8.2 IPC handler 重复注册泄漏

**官方行为**：`ipcMain.handle(channel, listener)` 在同一 channel 二次注册会直接抛错（来源：[ipcMain.handle 文档](https://www.electronjs.org/docs/latest/api/ipc-main)、[Test PR #138 fix duplicate IPC handler crash](https://github.com/harryroger798/Test/pull/138)——Electron's `ipcMain.handle()` throws on duplicate channel registration, so the second registration always crashes）。

**正确清理姿势**：

```js
// 注册时
const handleOpen = () => openFloating()
ipcMain.handle('floating:open', handleOpen)

// 卸载时
ipcMain.removeHandler('floating:open')   // 必须显式 remove
// 或 ipcMain.removeAllListeners('floating:open') 适用于 .on 注册的
```

**本项目隐患**：`registerFloatingController` 没有对应的 unregister,如果主窗口多次创建（macOS activate 路径、热重载、主窗口关闭重开）会触发重复注册崩溃。Windows 单实例下通常没事,但开发期 hot reload 必踩。

（来源：[ipcMain API](https://www.electronjs.org/docs/latest/api/ipc-main)、[How to Properly Debug Electron Memory Leaks](https://www.xjavascript.com/blog/how-to-properly-debug-electron-memory-issues/) 列出 "Orphaned IPC Listeners: `ipcMain.on` without `ipcMain.removeListener`" 为典型泄漏）

### 8.3 `alwaysOnTop` 与全屏应用、其他置顶窗口的层级冲突

**`setAlwaysOnTop`** **的 level 枚举**（[BaseWindow API](https://www.electronjs.org/docs/latest/api/base-window)）：

- macOS：`normal > floating > torn-off-menu > modal-panel > main-menu > status`

- Windows：`normal > floating > torn-off-menu > modal-panel > main-menu > status > pop-up-menu > screen-saver`

- Linux：行为依 WM 而定

**`screen-saver`** **级是 Windows 最高**,可压过 PowerPoint 演示视图、全屏游戏等 aggressive topmost 窗口。Electron v21 PR #34388 新增 "Window can float over full-screened apps" 能力（panel-like behavior）。

**sokuji 的实战经验**（字幕悬浮窗,场景与本项目的悬浮窗高度相似）：

- 默认 `'floating'` 级被 PowerPoint 演示视图盖住（[sokuji #326](https://github.com/kizuna-ai-lab/sokuji/issues/326)）

- 修复：升级到 `'screen-saver'` 级

- 但 `'screen-saver'` 级会与同应用的其他子窗口（popover）z-order 冲突,子窗口默认 `'floating'` 被压到 taskbar 下

- 修复：子窗口也 pin 到 `'screen-saver'` 级,且 heartbeat re-assert 时一并 raise 可见 popover（[sokuji PR #432](https://github.com/kizuna-ai-lab/sokuji/pull/432)）

- heartbeat 模式：每 1s 调用 `setAlwaysOnTop` 重新断言,防止其他 topmost 窗口插入后把本项目挤下去

**对本项目的启示**：

- 当前 `alwaysOnTop: true` 等价 `'floating'` 级

- 若用户反馈"在某些全屏应用下被盖住",优先升级到 `'screen-saver'` 级 + heartbeat

- 本项目暂无子窗口,不会触发 sokuji 那种子窗口 z-order 冲突

### 8.4 鼠标抬起监听可靠性差异

详见 §3.5。核心结论：

- **document mouseup**：不可靠,鼠标移出窗口边界外抬起时不到达

- **window blur**：拖拽中切应用可触发,但"鼠标抬起但未切应用"不触发

- **主进程** **`isFocused()`** **兜底**：最稳,electron-drag-window、juejin 实现均采用

- **`setPointerCapture`**（Pointer Events）：渲染层最稳,但需要主进程也接收 pointerup IPC 才能停轮询

***

## 9. 业内开源参考实现清单

| 项目                                                 | 方案                                                                                                       | 取舍                                                                                                                                                                                           | 链接                                                                                                                                                                                             |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **electron-overlay-wind**（npm 库）                   | `transparent: true` + `resizable: true` + `skipTaskbar: true` + `frame: false` + overlay 与目标窗口同步         | 注意：README 的 `OVERLAY_WINDOW_OPTS` 同时设 `transparent: true` 和 `resizable: true`,与官方文档"透明窗口不可 resize"冲突,可能在某些版本/平台不工作;支持 Win/Linux/macOS,事件系统完善（attach/detach/focus/blur/fullscreen/moveresize） | [npm: electron-overlay-wind](https://www.npmjs.com/package/electron-overlay-wind)                                                                                                              |
| **electron-drag-window**（npm 库）                    | 自定义 IPC + `screen.getCursorScreenPoint()` + `win.setPosition`,不使用 `-webkit-app-region`                   | README 自述"建议结合 `-webkit-app-region` 一起使用";源码简单可读;明确指出 125% DPI 下拖拽窗口变大的问题,提供 `force-device-scale-factor=1` 临时修复（治标不治本）                                                                       | [github: electron-drag-window](https://github.com/TyphonEX/electron-drag-window)                                                                                                               |
| **QuarantineCoder/Overlay**                        | Electron + transparent + alwaysOnTop + 多 pane + opacity 10%-100% + "Above Everything / Above Desktop" 两级 | 简单实现,适合学习;支持 color/blur/image pane 类型;Windows only                                                                                                                                           | [github: Overlay](https://github.com/QuarantineCoder/Overlay)                                                                                                                                  |
| **mvanderbend-msoft/demo-overlay-app**             | Electron transparent + alwaysOnTop + click-through + 全局快捷键                                               | "lower-third banner" 场景,设计为 Teams/Zoom/OBS 共享屏幕时仍可见;click-through 不抢焦点                                                                                                                       | [github: demo-overlay-app](https://github.com/mvanderbend-msoft/demo-overlay-app)                                                                                                              |
| **ShenSheiBot/Archy**                              | Electron + 浮窗浏览器 + alwaysOnTop + 自定义 opacity + frameless 选项 + 跨平台                                        | "Cross-platform floating window browser",功能完整,可参考其跨平台 alwaysOnTop 处理                                                                                                                         | [github: Archy](https://github.com/ShenSheiBot/Archy)                                                                                                                                          |
| **arindam-sahoo/KoBar**                            | Electron + React + frameless + transparent + alwaysOnTop 侧边栏                                             | 与本项目最像（frameless transparent alwaysOnTop 桌面工具）,可参考其侧边栏 dock 实现                                                                                                                               | [github: KoBar](https://github.com/arindam-sahoo/KoBar)                                                                                                                                        |
| **getopenscreen/openscreen**                       | Electron + transparent HUD + 自定义 IPC drag + Windows 原生 capture                                           | PR #110 的 DPI-safe drag 修复方案是本项目最值得借鉴的工程文档                                                                                                                                                   | [github: openscreen PR #110](https://github.com/getopenscreen/openscreen/pull/110)                                                                                                             |
| **kizuna-ai-lab/sokuji**                           | Electron + 字幕悬浮窗 + alwaysOnTop `'screen-saver'` 级 + heartbeat                                            | 字幕悬浮窗场景与本项目悬浮窗高度相似,层级冲突处理可借鉴                                                                                                                                                                 | [github: sokuji](https://github.com/kizuna-ai-lab/sokuji)、[sokuji #326](https://github.com/kizuna-ai-lab/sokuji/issues/326)、[sokuji PR #432](https://github.com/kizuna-ai-lab/sokuji/pull/432) |
| **FOURIER-Inc/electron-frameless-window**          | `titleBarStyle: hidden` + `titleBarOverlay` + `-webkit-app-region: drag`                                 | Slack 风标题栏复刻教程,标准 frameless + drag 实现                                                                                                                                                        | [github: electron-frameless-window](https://github.com/FOURIER-Inc/electron-frameless-window)                                                                                                  |
| **binaryfunt/electron-seamless-titlebar-tutorial** | `-webkit-app-region: drag` + `no-drag` 分区                                                                | Windows 10 风 seamless 标题栏教程,经典                                                                                                                                                               | [github: electron-seamless-titlebar-tutorial](https://github.com/binaryfunt/electron-seamless-titlebar-tutorial/blob/master/README.md)                                                         |

***

## 10. 针对本项目的推荐落地方案

### 10.1 总体判断：局部加固,不重写

**理由**：

1. 当前"自定义 IPC + `setBounds`"架构与 electron-drag-window、OpenScreen HUD、chameleon 等业内开源方案同源,不是错路。
2. 业内主流（VS Code/Slack）用 `-webkit-app-region: drag` 是因为他们不需要"窗口任意位置 hover 展开"——他们有固定标题栏。本项目"鼠标进入展开、离开收缩"的需求确实让 drag 机制不便直接用,但可以**混合**：drag-bar 窄条上用 `app-region: drag`,展开后的内容区 `no-drag`,只在窄条上禁用 hover 展开。
3. 完全重写不能解决 DPI、mouseup 兜底、alwaysOnTop 层级这三个真实问题——它们都需要局部修复。

### 10.2 落地清单（按风险/收益排序）

#### P0 - 必修（高风险、影响基本可用性）

| # | 改造点                                                | 风险等级 | 改动量 | 依据                                                                                                                                                                                                                                                                                                                                                           |                                                                                                                                   |
| - | -------------------------------------------------- | ---- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| 1 | **拖拽 delta 按 devicePixelRatio 缩放**                 | 高    | 小   | `startDrag` 轮询内,`newX = dragStartWinPos.x + (cursor.x - dragStartCursor.x)` 改为 `newX = dragStartWinPos.x + (cursor.x - dragStartCursor.x)`（注：`getCursorScreenPoint` 已是 DIP,如果渲染层传的是 CSS 像素 delta 才需要除以 dpr;但本项目主进程直接读 `getCursorScreenPoint`,所以**实际不需要乘 dpr**——这条要复查,真正问题可能在别处）。**优先实测**：在 Win11 125% 缩放下拖拽,确认 cursor delta 与窗口移动距离是否一致,若一致则 DPI 不是当前 bug 根因 | [agentmux PR #867](https://github.com/agentmuxai/agentmux/pull/867)、[#27651](https://github.com/electron/electron/issues/27651)   |
| 2 | **mouseup 兜底：主进程** **`isFocused()`** **检查 + 超时自停** | 高    | 小   | `dragTimer` 回调内加：`if (!floatingWindow.isFocused()) { stopDrag(); return }`,以及 cursor 长时间未变则自停。resize 同理                                                                                                                                                                                                                                                      | [electron-drag-window](https://github.com/TyphonEX/electron-drag-window)、[juejin 实现](https://juejin.cn/post/7262945227178786876)  |
| 3 | **`ipcMain.handle`** **重复注册保护**                    | 高    | 小   | `registerFloatingController` 入口先 `ipcMain.removeHandler('floating:open')` 等 9 个 channel,再 `handle`;或者用 `ipcMain._handlers` 检查（私有 API,不推荐）。最稳：导出 `unregisterFloatingController`,主窗口 `closed` 时调用                                                                                                                                                              | [ipcMain API](https://www.electronjs.org/docs/latest/api/ipc-main)、[Test PR #138](https://github.com/harryroger798/Test/pull/138) |

#### P1 - 应修（中风险、影响体验）

| # | 改造点                                                                          | 风险等级 | 改动量 | 依据                                                                                                                                                |                                                                                                                                                       |
| - | ---------------------------------------------------------------------------- | ---- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4 | **drag/resize 期间窗口宽高保持不变**                                                   | 中    | 小   | `startDrag` 当前已传 `{x, y, width, height}`,但 height/width 来自 `floatingWindow.getSize()`,在 125% 缩放下可能漂移;改为每次 dragStart 时读一次 `getSize()`,轮询内复用同一组 w/h | [OpenScreen PR #110](https://github.com/getopenscreen/openscreen/pull/110) "keep the full BrowserWindow width and height immutable throughout a drag" |
| 5 | **展开/收缩动画改为 CSS transform 内容动画**（窗口尺寸维持展开态）                                  | 中    | 中   | 删 `animateResize`,窗口尺寸切到展开态后保持;内容区用 `transform: translateY(-100%)` 隐藏,hover 时 `translateY(0)`;收缩态视觉=内容滑出窗口顶部,留 drag-bar 可见                        | §5.3、[OpenScreen PR #110 "defer content-driven HUD resizing while dragging"](https://github.com/getopenscreen/openscreen/pull/110)                    |
| 6 | **`alwaysOnTop`** **升级到** **`'screen-saver'`** **级 + heartbeat**（仅当用户反馈被盖住时） | 中    | 小   | `floatingWindow.setAlwaysOnTop(true, 'screen-saver')`;可选每 3s 重断言                                                                                  | [sokuji #326](https://github.com/kizuna-ai-lab/sokuji/issues/326)、[BaseWindow setAlwaysOnTop](https://www.electronjs.org/docs/latest/api/base-window) |
| 7 | **resize 手柄加** **`setPointerCapture`** **+ Pointer Events**                  | 中    | 中   | 渲染层 5 个手柄改用 `pointerdown/move/up` + `setPointerCapture(e.pointerId)`,防 mouseup 不触发;参考 chameleon PR #3                                             | [chameleon PR #3](https://github.com/SystemUI-js/chameleon/pull/3)                                                                                    |

#### P2 - 可选（低风险、长期改进）

| #  | 改造点                                                                       | 风险等级 | 改动量 | 依据                                                                                                                                                                    |                                                                                                                               |
| -- | ------------------------------------------------------------------------- | ---- | --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 8  | **drag-bar 改回** **`-webkit-app-region: drag`** **+** **`no-drag`** **分区** | 低    | 中   | 仅窄条 drag 区禁用 hover 展开,展开后内容区 no-drag,鼠标事件完全正常;OS 级处理 DPI/多屏/聚焦。**前提**：窄条上不需要 hover 展开——hover 展开的触发区改到窄条**下方一点点**的 no-drag 区,或者保留 IPC 但作为 drag 的 fallback。这是与业内主流对齐的方向 | [VS Code/Slack/Hyper 案例](https://www.electronjs.org/docs/latest/tutorial/custom-window-interactions#custom-draggable-regions) |
| 9  | **监听** **`display-metrics-changed`,DPI 变化时重设尺寸**                          | 低    | 小   | `screen.on('display-metrics-changed', ...)` 里重算窗口尺寸                                                                                                                   | [screen API events](https://www.electronjs.org/docs/latest/api/screen)                                                        |
| 10 | **拖拽期间冻结展开/收缩动画 + 内容测量**                                                  | 低    | 小   | drag/resize 期间设 `isDragging` 标志,屏蔽 expand/collapse                                                                                                                    | [OpenScreen PR #110](https://github.com/getopenscreen/openscreen/pull/110)                                                    |
| 11 | **`setOpacity`** **与 rgba 背景不混用**                                         | 低    | 无   | 现状已是 setOpacity 单一来源,保持即可                                                                                                                                             | §6                                                                                                                            |

### 10.3 不建议的方向

| 不建议                                   | 原因                                                 |
| ------------------------------------- | -------------------------------------------------- |
| 完全重写为 `-webkit-app-region: drag` 单一方案 | 与"hover 展开需要 mouseenter"冲突,会回到当前问题原点               |
| 改用颜色键穿透方案                             | Electron 未暴露 API,需 native 模块,投入产出比低                |
| 迁移到 Tauri                             | 生态远小于 Electron,Windows API 暴露面小,且本项目已经稳定在 Electron |
| 用 uIOhook 等全局鼠标钩子                     | 引入 native 依赖,跨平台一致性差,远超当前问题所需                      |

***

## 附：关键来源索引

### Electron 官方文档

- [Custom Window Styles](https://www.electronjs.org/docs/latest/tutorial/custom-window-styles) — 透明窗口限制清单

- [Custom Window Interactions](https://www.electronjs.org/docs/latest/tutorial/custom-window-interactions) — drag 区域行为、click-through、forward mouse events

- [Custom Title Bar](https://www.electronjs.org/zh/docs/latest/tutorial/custom-title-bar) — `titleBarStyle: hidden` + `titleBarOverlay`

- [BaseWindow API](https://www.electronjs.org/docs/latest/api/base-window) — `setAlwaysOnTop` level 枚举、`will-resize` 事件、Platform notices

- [screen API](https://www.electronjs.org/docs/latest/api/screen) — `getCursorScreenPoint` 返回 DIP、`screenToDipPoint`/`dipToScreenPoint`、`display-metrics-changed`

- [ipcMain API](https://www.electronjs.org/docs/latest/api/ipc-main) — `handle` 重复注册抛错、`removeHandler`/`removeAllListeners`

### Electron GitHub issue/PR

- [#741 -webkit-app-region drag disables parts of UI（wontfix）](https://github.com/electron/electron/issues/741)

- [#41002 -webkit-app-region: drag in underlying browserView blocks mouse interaction](https://github.com/electron/electron/issues/41002)

- [#611 mouseleave event isn't fired when moving the mouse outside the window (Windows)](https://github.com/electron/electron/issues/611)

- [#1335 透明区域不可点击穿透](https://github.com/electron/electron/issues/1335)

- [#27651 setBounds make BrowserWindows larger every time on Windows](https://github.com/electron/electron/issues/27651)

- [#28207 透明窗口不能用系统菜单/双击最大化](https://github.com/electron/electron/pull/28207)

- [#34388 v21 新增 panel-like behavior,Window can float over full-screened apps](https://github.com/electron/electron/pull/34388)

- [#40515 transparent not respected on some Windows systems](https://github.com/electron/electron/issues/40515)

- [#44967 transparent + alwaysOnTop 窗口与其他 topmost 窗口交互闪烁](https://github.com/electron/electron/issues/44967)

- [#46352 transparent windows flickering on MAS build](https://github.com/electron/electron/issues/46352)

- [#48378 引入透明窗 resize 限制的 PR](https://github.com/electron/electron/pull/48378)

- [#48554 v39.0.0-beta.3 resizability broken with transparent window](https://github.com/electron/electron/issues/48554) / [PR #49428 修复](https://github.com/electron/electron/pull/49428)

- [#48592 Transparency broken since v39.0.0-beta.3 on win10](https://github.com/electron/electron/issues/48592)

- [#49682 fix cursor flickering when setIgnoreMouseEvents forwards messages](https://github.com/electron/electron/pull/49682)

- [#51521 / PR #51539 reset hover state when disabling mouse event forwarding on Windows](https://github.com/electron/electron/pull/51539)

### 业内开源项目

- [electron-overlay-wind (npm)](https://www.npmjs.com/package/electron-overlay-wind) — overlay 与目标窗口同步

- [electron-drag-window (npm)](https://github.com/TyphonEX/electron-drag-window) — 自定义 IPC drag

- [QuarantineCoder/Overlay](https://github.com/QuarantineCoder/Overlay) — Electron 多 pane overlay

- [mvanderbend-msoft/demo-overlay-app](https://github.com/mvanderbend-msoft/demo-overlay-app) — 演示用 lower-third banner

- [ShenSheiBot/Archy](https://github.com/ShenSheiBot/Archy) — 跨平台浮窗浏览器

- [arindam-sahoo/KoBar](https://github.com/arindam-sahoo/KoBar) — Electron+React 透明侧边栏

- [getopenscreen/openscreen PR #110](https://github.com/getopenscreen/openscreen/pull/110) — DPI-safe drag 修复

- [kizuna-ai-lab/sokuji #326](https://github.com/kizuna-ai-lab/sokuji/issues/326) / [PR #432](https://github.com/kizuna-ai-lab/sokuji/pull/432) — 字幕悬浮窗 alwaysOnTop 层级处理

- [FOURIER-Inc/electron-frameless-window](https://github.com/FOURIER-Inc/electron-frameless-window) — Slack 风标题栏复刻

- [binaryfunt/electron-seamless-titlebar-tutorial](https://github.com/binaryfunt/electron-seamless-titlebar-tutorial/blob/master/README.md) — Windows 10 seamless 标题栏教程

- [SystemUI-js/chameleon PR #3](https://github.com/SystemUI-js/chameleon/pull/3) — 8 方向 resize + Pointer Events

- [code-meeseeks PR #30](https://github.com/huhamhire/code-meeseeks/pull/30/files) — VS Code 风无边框 + 自绘标题栏

- [NanmiCoder/cc-haha #874](https://github.com/NanmiCoder/cc-haha/issues/874) — 拖拽 hit-test 失效分析

- [agentmux PR #867](https://github.com/agentmuxai/agentmux/pull/867) — Win11 125% 下 drag DPI 修复

- [harryroger798/Test PR #138](https://github.com/harryroger798/Test/pull/138) — `ipcMain.handle` 重复注册崩溃修复

### 参考实现与对比

- [Titlebar-Less VSCode 扩展](https://marketplace.visualstudio.com/items?itemName=lehni.vscode-titlebar-less-macos) — VS Code 风 drag/no-drag CSS

- [madnh/puredashboard DESKTOP.md](https://github.com/madnh/puredashboard/blob/main/docs/DESKTOP.md) — Tauri/Wails frameless + drag 对比

- [tauri-plugin-frameless-window](https://lib.rs/crates/tauri-plugin-frameless-window) — Tauri v2 frameless 插件

- [louisameline windowMouseOutFix.js gist](https://gist.github.com/louisameline/1213bb112c6cb12a98b2ab525dfb8b07) — Electron #611 mouseleave 修复 workaround

- [How to Properly Debug Electron Memory Leaks](https://www.xjavascript.com/blog/how-to-properly-debug-electron-memory-issues/) — IPC handler 泄漏列为典型主进程泄漏源

