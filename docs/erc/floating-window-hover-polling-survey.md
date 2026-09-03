# 悬浮窗 hover：cursor 轮询模式先例调研

> 聚焦问题：Electron 主进程用 `setInterval` + `screen.getCursorScreenPoint()` + `win.getBounds()` 比对，驱动悬浮窗/overlay 的 hover 展开/收起，是否有开源先例？该模式是否被认可？
>
> 上游报告：`docs/erc/floating-window-survey.md` §5.2 列了 5 种成熟 hover 模式（debounce+delay、isHover lock、pointer-events:none 中间态、CSS transform 滑入滑出、setIgnoreMouseEvents 主动穿透），**均不含 cursor 轮询**。本报告补这块缺口。

---

## 1. TL;DR

**有先例，但不是"推荐做法"，而是"事件通路坏了之后的逃生舱"。**

最硬的先例是 **Electron 自家源码**：`notify_icon_host.cc` 里的 `MouseEnteredExitedDetector` 用 250ms 重复定时器轮询 `GetCursorScreenPoint()` 并与 `icon->GetBounds().Contains()` 比对，来检测系统托盘图标的 mouse enter/exit——因为托盘图标的事件模型本身就受限，拿不到正常的 enter/exit 事件。社区还有针对 issue #611（mouseleave 不触发，wontfix）的 1000ms 轮询 workaround gist，且明确写了"在 `-webkit-app-region: drag` 区也工作"。

但这套模式**不在官方推荐的 hover 模式里**，也**不在主流应用（VS Code/Slack/Discord 等）的 hover 实现里**。它出现的场景统一是"正常指针事件路径被破坏"——托盘事件模型受限、#611 wontfix、drag 区吞事件、setIgnoreMouseEvents forward 吞 WM_MOUSELEAVE。在这些场景下它是合理的兜底，但作为**主 hover 机制**有明确的 CPU、时序、事件重复、坐标系陷阱。

**最终推荐**：`no-drag` hover 薄条作为主机制（官方文档化、主流、复杂度低）；cursor 轮询作为**兜底守卫**（JingRanTodo 的混合模式：事件为主 + mouseleave 触发前 IPC 校验光标确在外），仅在 no-drag 仍失效的边缘 case（macOS 顶部 NSWindow tracking zone、#611 残留、transparent+forward bug）启用。纯 cursor 轮询做唯一 hover 机制不推荐。

---

## 2. Electron 生态先例清单

### 2.1 先例一（最强）：Electron 自家源码 — 托盘图标 enter/exit 轮询

`shell/browser/ui/win/notify_icon_host.cc` 里的 `MouseEnteredExitedDetector` 类：

```cpp
constexpr unsigned int kMouseLeaveCheckFrequency = 250;

// 在 mouse move 时启动重复定时器，轮询光标是否还在图标上
void StartObservingIcon(raw_ptr<NotifyIcon> icon) {
  current_mouse_entered_ = icon->GetWeakPtr();
  mouse_exit_timer_.Start(
    FROM_HERE, base::Milliseconds(kMouseLeaveCheckFrequency),
    base::BindRepeating(
      &MouseEnteredExitedDetector::CheckCursorPositionOverIcon,
      weak_factory_.GetWeak...));
}

bool IsCursorOverIcon(raw_ptr<NotifyIcon> icon) {
  gfx::Point cursor_pos = display::Screen::Get()->GetCursorScreenPoint();
  return icon->GetBounds().Contains(cursor_pos);
}

void CheckCursorPositionOverIcon() {
  if (!current_mouse_entered_ ||
      IsCursorOverIcon(current_mouse_entered_.get()))
    return;
  SendExitedEvent();  // 光标已离开图标 → 发 mouse-exited
}
```

**模式**：250ms `base::RepeatingTimer` + `GetCursorScreenPoint()` + `GetBounds().Contains(cursor_pos)` 比对，检测 enter/exit。

**为何这么做**：Windows 托盘图标（NotifyIcon）走 `Shell_NotifyIcon` 的 `NIN_*` 消息模型，**不提供可靠的 mouse-leave 事件**（只有 `NIN_BALLOON_HIDE` 等），所以 Electron 自己用轮询补齐 leave 检测。这与你遇到的情况同构——"正常事件通路坏了，于是轮询光标位置兜底"。

（来源：[electron/shell/browser/ui/win/notify_icon_host.cc](https://github.com/electron/electron/blob/main/shell/browser/ui/win/notify_icon_host.cc)）

> ⚠️ 注意：这是托盘图标 hover，不是 BrowserWindow hover。但**机制完全一致**（定时器 + getCursorScreenPoint + bounds 比对），且是 Electron 官方代码，证明该模式在 Electron 生态里被官方接受用于"事件受限场景的 enter/exit 检测"。

### 2.2 先例二：louisameline 的 #611 workaround gist（直接对应 BrowserWindow hover）

`windowMouseOutFix.js`，针对 Electron issue #611（mouseleave 不触发，2014 年报，**wontfix**）：

```js
// the interval at which we'll check if the mouse has left the window
var intervalValue = 1000,
    window = electron.remote.getCurrentWindow(),
    mouseIsOut = function(){
      var systemMouseCoord = electron.screen.getCursorScreenPoint(),
          winCoord = window.getPosition(),
          winSize = window.getSize();
      return (systemMouseCoord.x < winCoord[0]
           || systemMouseCoord.x > winCoord[0] + winSize[0]
           || systemMouseCoord.y < winCoord[1]
           || systemMouseCoord.y > winCoord[1] + winSize[1]);
    },
    out = mouseIsOut(), windowMouseCoord, lastEl;

setInterval(function(){
  if(mouseIsOut()){
    if(out === false){ out = true; /* 触发 mouseleave */ }
  } else {
    if(out === true){
      if(window.isFocused() || regionAppOptimized){
        out = false; /* 触发 mouseenter */
      }
    }
  }
}, intervalValue);
```

**关键自述**（gist 顶部注释）：

> "This snippet will check if the cursor has left the window, and trigger mouse events accordingly. **It even works with `-webkit-app-region` areas, which usually don't send any mouse events, so it's pretty cool.**"

**作者自陈的 caveat**：

> "it triggers too many events. For example when the mouse comes back to the window, the mouseenter listener of the hovered element may be triggered twice... too many events are better than none, right? Just need to ignore the extra ones."

**对应的问题 #611**：标题即 "mouseleave event isn't fired when moving the mouse outside the window (Windows)"，状态 `status/wontfix 🚫`。即 Electron 官方承认 Windows 下鼠标移出窗口时 mouseleave 会被吞，且不修。

（来源：[louisameline/windowMouseOutFix.js gist](https://gist.github.com/louisameline/1213bb112c6cb12a98b2ab525dfb8b07)、[electron #611 wontfix](https://github.com/electron/electron/issues/611)）

> ✅ 这是最贴近你需求的先例：BrowserWindow + drag 区吞事件 + cursor 轮询触发 mouseenter/leave。但它用的是 1000ms（响应较差），且是 workaround 性质，不是推荐模式。

### 2.3 先例三：JingRanTodo — 混合模式（事件为主 + 光标校验兜底）

`疑难问题解决方案.md` 描述了一个贴边收起/展开浮窗的修复。根因与你的场景高度一致：

> "标题栏使用 `WebkitAppRegion: 'drag'` 启用窗口拖拽，但这会导致该区域内的鼠标事件不正常冒泡，Electron 会认为鼠标离开了普通网页区域。"

修复二（系统级鼠标位置检查）——在 `handleEdgeMouseLeave` 收起定时器触发**前**，通过 IPC 取系统级光标位置，确认鼠标确实在窗口外：

```js
const checkMousePosition = () => {
  const windowX = window.screenX, windowY = window.screenY;
  const windowW = window.innerWidth, windowH = window.innerHeight;
  if ((window as any).electronAPI?.getMousePosition) {
    return (window as any).electronAPI.getMousePosition()
      .then((pos) => {
        const isInside = pos.x >= windowX && pos.x <= windowX + windowW
                      && pos.y >= windowY && pos.y <= windowY + windowH;
        return !isInside;  // 返回 true 表示应该收起
      });
  }
};
```

**模式**：mouseenter/mouseleave 仍是主信号，但在 mouseleave 即将触发收起前，用一次 `getCursorScreenPoint`（经 IPC）做"二次确认"，避免 drag 区吞事件导致的误判。**这是混合模式，不是纯轮询**。

（来源：[HaibinZhang1/JingRanTodo 疑难问题解决方案.md](https://github.com/HaibinZhang1/JingRanTodo/blob/main/%E7%96%91%E9%9A%BE%E9%97%AE%E9%A2%98%E8%A7%A3%E5%86%B3%E6%96%B9%E6%A1%88.md)）

### 2.4 相关但非 hover：透明窗 click-through 轮询、拖拽光标锚定

这些不是 hover，但用同一套"主进程轮询 getCursorScreenPoint + 窗口 bounds"模式，证明该模式在 Electron 生态被广泛用于"窗口与光标关系判断"：

- **CSDN sevendemage**：`setInterval(100ms)` + `getCursorScreenPoint` + `getPosition` + `getSize` 比对，驱动 `updateIgnoreMouseEvents` 做透明窗局部穿透。明确标注"定时监听鼠标，触屏不行"。（来源：[electron 透明窗口鼠标穿透问题](https://blog.csdn.net/sevendemage/article/details/134475821)）
- **clawd-on-desk PR #111**：桌面宠物拖拽，把定位锚点从渲染层 `screenX/screenY` 改到主进程 `screen.getCursorScreenPoint()`（DIP），修高 DPI 下光标漂移。（来源：[clawd-on-desk #111 Fix high-DPI drag cursor drift](https://github.com/rullerzhou-afk/clawd-on-desk/pull/111)）
- **OpenScreen PR #110**：HUD 拖拽 + 光标采样（cursor-sampler），把坐标系统一到物理像素，仅在 Electron API 边界转回 DIP。（来源：[openscreen #110 make Windows capture and HUD drag DPI-safe](https://github.com/getopenscreen/openscreen/pull/110)）

### 2.5 小结

| 先例 | 是否 BrowserWindow hover | 间隔 | 性质 | 是否官方 |
|---|---|---|---|---|
| notify_icon_host.cc（托盘） | 否（托盘图标），但机制同构 | 250ms | 官方实现 | ✅ Electron 源码 |
| louisameline gist | ✅ 直接 | 1000ms | 社区 workaround（#611 wontfix） | ❌ 社区 |
| JingRanTodo | ✅（混合） | 按需单次 | 事件为主 + 光标校验 | ❌ 社区 |
| sevendemage（穿透） | 否（click-through） | 100ms | 社区 workaround | ❌ 社区 |

**结论**：cursor 轮询做 hover 在 Electron 生态**有直接先例**（gist #611 + JingRanTodo 混合），且有官方同构先例（托盘 250ms 轮询）。但**没有**任何主流应用（VS Code/Slack/Discord 等）用纯 cursor 轮询做 BrowserWindow hover 展开/收起——它们都用 `app-region: drag` + `no-drag` 分区。cursor 轮询是"事件通路坏了"的兜底，不是首选。

---

## 3. 跨框架类比

### 3.1 Qt

Qt 的 `QWidget::underMouse()` 在未开 `setMouseTracking(true)` 时返回**陈旧值**（无按键时收不到 mousemove，"在鼠标下"状态不更新）。社区给出的"从事件处理器外检查光标是否在 widget 上"的做法就是轮询：

```cpp
// 在定时器事件或外部槽里检查
bool isCursorOverWidget(QWidget *widget) {
  QPoint globalPos = QCursor::pos();           // 全局屏幕坐标
  QPoint localPos = widget->mapFromGlobal(globalPos);
  return widget->rect().contains(localPos);
}
```

但社区明确表态：**这只是"如果你必须从事件处理器外检查"的 workaround**，首选是重写 `enterEvent()`/`leaveEvent()`——

> "If you just want to know when the mouse enters or leaves a widget to change its appearance (like a hover effect), it's much better to reimplement the `enterEvent()` and `leaveEvent()` handlers. These events are triggered precisely when the mouse pointer crosses the boundary into or out of the widget."

即：Qt 生态里轮询光标做 hover **存在但被视为次选**，事件驱动才是 idiomatic。

（来源：[Qt Mouse Tracking Made Easy: A Look at underMouse() Alternatives](https://runebook.dev/en/docs/qt/qwidget/underMouse)）

另一类 Qt 用例是截图/录屏软件的"窗口选择"（鼠标移到某窗口上自动框选），用 200ms 定时器 + `GetCursorPos` + `WindowFromPoint`——但这是**窗口拾取**，不是 hover 展开/收起，动机不同。

（来源：[Qt实现跨平台窗口选择功能](https://blog.csdn.net/qq_43627907/article/details/128218840)）

### 3.2 Win32 / 原生

Win32 有 `WM_MOUSELEAVE`（需 `TrackMouseEvent` 注册），是事件驱动的 leave 检测。但当窗口是分层窗/透明窗、或子窗口链复杂时，`WM_MOUSELEAVE` 不可靠——这时社区也会回退到 `GetCursorRect`/`GetCursorPos` + `GetWindowRect` 轮询。Electron 的托盘轮询本质就是 Win32 托盘 `Shell_NotifyIcon` 拿不到可靠 leave 的 Win32 根因。

### 3.3 Tauri / Wails / Flutter

未找到这些框架用 cursor 轮询做 hover 的成熟先例。Tauri 的 `data-tauri-drag-region` 与 Electron `-webkit-app-region: drag` 同模型（drag 区也吞事件），其 hover 解法同样是 `no-drag` 分区，而非轮询。

**跨框架结论**：cursor 轮询做 hover 在所有桌面框架里都属于"事件模型受限时的 workaround"，不是任何框架的推荐 hover 模式。Electron 生态因为有 #611 wontfix + 托盘事件限制，反而比别的框架多了一些"被迫轮询"的真实用例。

---

## 4. 该模式的已知陷阱

| 陷阱 | 现象 / 机理 | 出处 |
|---|---|---|
| **CPU 占用** | 定时器常驻轮询；Electron 托盘选 250ms、社区 gist 选 1000ms 都是 CPU 与响应时延的折中。间隔越短越跟手但越耗电（尤其笔记本） | notify_icon_host.cc `kMouseLeaveCheckFrequency=250`；louisameline gist `intervalValue=1000` |
| **事件重复触发** | 轮询与真实 mouseenter 抢跑：光标回来时，轮询可能比真实 mouseenter 监听器先看到"已进入"，于是手动触发一次 mouseover，随后真实 mouseenter 又来一次 → hover 监听器触发两次 | louisameline gist 注释："it triggers too many events... the mouseenter listener of the hovered element may be triggered twice" |
| **时序差 / 响应滞后** | 1000ms 间隔意味着移出后最多 1 秒才检测到 leave 并收起；250ms 也仍有最高 250ms 延迟。事件驱动的 mouseleave 是即时的 | 同上 gist（1000ms）；托盘 250ms |
| **坐标系不一致（高 DPI / 多屏）** | `getCursorScreenPoint()` 返回 DIP，若与物理像素坐标的 bounds 直接比，分数缩放或非主屏/旋转屏下光标会被"归到错误坐标空间" | OpenScreen PR #110："cursor could be normalized against a rectangle from a different coordinate space"；clawd-on-desk #111："renderer screenX/screenY deltas diverge from Electron's DIP coordinate space, so repeated movement can accumulate cursor drift" |
| **与 OS 拖拽中的反馈环冲突** | 透明非可调窗在拖拽中改尺寸，会触发 Chromium viewport 重算，再回喂原生窗口尺寸，形成两个耦合反馈环 | OpenScreen PR #110："The HUD had two coupled feedback loops. Moving a transparent non-resizable BrowserWindow at fractional DPI could publish a slightly different Chromium viewport..." 修复：拖拽期间冻结 content measurement，用不可变 drag-start 光标 + bounds |
| **静止时一般不抖动，但动画中边界穿越会抖** | 鼠标停窗口边缘、窗口尺寸动画（setBounds）让鼠标在"在/不在"间反复跳变，轮询与事件驱动一样会遇到 | 上游报告 §5.1 已列此 bug |
| **Wayland 不支持** | `screen.getCursorScreenPoint()` 在 Wayland 下不工作，轮询方案在 Linux/Wayland 直接失效 | Electron screen API 文档："Not supported on Wayland (Linux)" |
| **与 setIgnoreMouseEvents forward 的叠加 bug** | 若同时用 forward:true 做穿透，Windows 上 `SubclassProc` 故意吞 WM_MOUSELEAVE，`setIgnoreMouseEvents(false)` 时不会重发 → hover 残留。轮询能"绕过"此 bug，但需注意 Electron 版本是否含 #51539 修复 | 上游报告 §5.2；PR #51539、#49682 |

---

## 5. 坐标系一致性核查（getCursorScreenPoint vs getBounds）

### 5.1 官方文档逐项确认

| API | 返回坐标系 | 官方依据 |
|---|---|---|
| `screen.getCursorScreenPoint()` | **DIP**（设备无关像素） | screen API 文档原文："The return value is a DIP point, not a screen physical point."（来源：[screen API](https://www.electronjs.org/docs/latest/api/screen)） |
| `Display.bounds` | **DIP** | Display Object 文档原文："bounds: Rectangle - the bounds of the display in DIP points."（来源：[Display Object](https://www.electronjs.org/docs/latest/api/structures/display)） |
| `Display.workArea` | **DIP** | 同上："workArea: Rectangle - the work area of the display in DIP points." |
| `win.getBounds()` | **DIP**（推断） | BrowserWindow 文档未显式标注，但 issue #51679 期望"HWND rect（`user32!GetWindowRect` 物理像素）equals `screen.dipToScreenRect(win.getBounds())`"——即需把 getBounds 的 DIP 转成物理像素才能与 HWND 物理矩形相比，反推 getBounds 返回 DIP。且 `screen.getDisplayMatching(win.getBounds())` 与 DIP 的 Display.bounds 比对，坐标系须一致才工作。（来源：[#51679](https://github.com/electron/electron/issues/51679)） |

### 5.2 结论

**`getCursorScreenPoint()` 与 `win.getBounds()` 同为 DIP，直接比对在多显示器/不同 DPI 下原则上可靠**——这也是 Electron 自家托盘轮询源码（`icon->GetBounds().Contains(cursor_pos)`）能工作的前提。

### 5.3 但仍有两个坐标系坑要注意

1. **Windows frameless + thickFrame 自 Electron 41.3 起 HWND 外扩**：`getBounds()` 返回的是逻辑（inset 前的）矩形，而**可见 HWND** 向 L/R/B 各外扩 `SM_CXSIZEFRAME + SM_CXPADDEDBORDER` DIP。即 getBounds 与"肉眼可见的窗口边"**不再一致**。若你的 hover 触发区是可见边缘，用 getBounds 比对可能让光标"已进入可见窗口但 getBounds 判为仍在界外"。（来源：[#51679 Breaking Change: frameless+thickFrame HWND grows 16×8 DIP, no longer matches getBounds()](https://github.com/electron/electron/issues/51679)）

2. **Wayland 不支持 getCursorScreenPoint**：轮询方案在 Linux/Wayland 直接无返回（或返回传入点不变），需平台降级。（来源：[screen API — screenToDipPoint/dipToScreenPoint "Not currently supported on Wayland"](https://www.electronjs.org/docs/latest/api/screen)）

3. **混入渲染层坐标会漂移**：若把渲染层 `MouseEvent.screenX/screenY` 与主进程 DIP 混算，高 DPI 下会累积漂移。clawd-on-desk #111 的修法是**把所有光标数学统一到主进程 DIP**，渲染层只发信号不算位移。（来源：[clawd-on-desk #111](https://github.com/rullerzhou-afk/clawd-on-desk/pull/111)）

---

## 6. 与"no-drag hover 薄条"方案对比

上游报告 §3.2 已立的官方依据：

> "Setting `app-region: drag` marks a rectangular area as draggable. It is important to note that **draggable areas ignore all pointer events**... Setting `app-region: no-drag` reenables pointer events by excluding a rectangular area from a draggable region."
> （来源：[Custom Window Interactions — Custom draggable regions](https://www.electronjs.org/docs/latest/tutorial/custom-window-interactions#custom-draggable-regions)）

即"在 drag-bar 下方放一条 `no-drag` 薄条、mouseenter 在 no-drag 区正常触发"是**官方文档直接支持**的做法。

### 6.1 优劣对比表

| 维度 | A. no-drag hover 薄条（官方） | B. cursor 轮询做 hover |
|---|---|---|
| 官方支持 | ✅ 官方文档化（Custom Window Interactions） | ⚠️ 无文档；但 Electron 源码托盘用过同构模式 |
| 主流采用度 | ⭐⭐⭐⭐⭐ VS Code/Slack/Discord/Postman/Notion 全用 drag+no-drag 分区 | ⭐ 无主流应用用纯轮询做 BrowserWindow hover |
| 复杂度 | 低：纯 CSS 分区 + 标准 mouseenter/leave | 中：主进程 setInterval + IPC + 状态机 + 坐标处理 |
| CPU | 几乎 0（事件驱动） | 常驻定时器（250–1000ms） |
| 响应时延 | 即时（鼠标事件原生） | 最高 = 轮询间隔（250ms–1s） |
| DPI/多屏 | OS 免费处理，无需关心 | 需确保全链路 DIP；frameless+thickFrame 41.3 后 getBounds 与可见边不一致 |
| 与 drag 区冲突 | 不冲突（no-drag 区在 drag 区外/挖洞，事件恢复） | 不冲突（轮询独立于指针事件，这正是它的卖点） |
| 事件抖动 | 动画中边界穿越仍会抖（§5.1） | 同样会抖（轮询也检测"在/不在"状态翻转） |
| macOS 顶部 NSWindow tracking zone | ⚠️ 顶部 ~28–38px 即使 no-drag，OS 仍拦 cursor update（Electron #5723/#21632 wontfix）。VS Code 的解法是**结构绕开**：顶部只放非交互元素，交互按钮放 y≥40px | ✅ 不受影响（轮询不看 OS cursor update） |
| Wayland | ✅ 事件正常 | ❌ getCursorScreenPoint 不支持 |
| 已知事件 bug | #611 mouseleave wontfix、setIgnoreMouseEvents forward 吞 WM_MOUSELEAVE（#51539 修） | ✅ 绕过这些事件 bug（这正是其存在理由） |
| 事件重复 | 无 | ⚠️ gist 自陈 mouseenter 可能触发两次 |
| 与 setBounds 动画的耦合 | 需配合 debounce/delay/transform 滑入（§5.2） | 同样需配合，且拖拽中要冻结 content measurement（OpenScreen #110） |

### 6.2 关键洞察

- **no-drag 薄条失效的精确场景**：macOS 顶部 NSWindow tracking zone（#5723、#21632，wontfix 至今）。VS Code 的官方解法不是轮询，而是**结构绕开**——把需要 hover 的交互元素移出顶部 28–38px 区域。（来源：[wake/purdex #300 详述 VSCode 做法](https://github.com/wake/purdex/issues/300)、[electron #5723](https://github.com/electron/electron/issues/5723)、[electron #21632](https://github.com/electron/electron/issues/21632)）

- **cursor 轮询的真正价值**：当 drag 区吞事件 + macOS tracking zone + #611 wontfix + forward bug **同时**作祟，且无法用结构绕开时，轮询是唯一独立于这些事件通路缺陷的机制。但它代价是 CPU、时延、重复事件、坐标系维护。

- **drag 区吞事件的根因**：不是 CSS 冒泡问题，而是引擎/OS 层的 frameless drag hook 在光标位置存在 drag 元素时**先吞掉所有鼠标事件**，即使 z-index 更高的元素在上面也不行。所以"把 hover 区放在 drag 区下方一条 no-drag 薄条"能工作，前提是这条薄条**不在任何 drag 元素的光标命中范围内**。（来源：[footballay-core discussion #13](https://github.com/PhysicksKim/footballay-core/discussions/13)）

### 6.3 推荐

**主机制用 no-drag hover 薄条，cursor 轮询仅作兜底守卫。**

具体落地：

1. **主路径（no-drag 薄条）**
   - drag-bar（`-webkit-app-region: drag`）只覆盖不需要 hover 的窄条
   - 在 drag-bar 下方放一条 `app-region: no-drag` 的 hover 触发薄条（哪怕 2–4px），mouseenter/mouseleave 在此区正常触发
   - 保证这条薄条不在任何 drag 元素的光标命中矩形内（参考 footballay-core #13）
   - macOS 上若薄条落在顶部 28–38px NSWindow tracking zone 内，用 VS Code 的结构绕开：把薄条/交互元素下移到 y≥40px

2. **兜底守卫（cursor 校验，混合模式）**
   - 仿 JingRanTodo：mouseleave 即将触发收起前，IPC 调一次主进程 `getCursorScreenPoint()` 与 `getBounds()` 比对，确认光标确在窗外才真收起
   - 这是**按需单次校验**，不是常驻轮询，CPU 几乎为 0，却能在 #611/forward bug 残留时挡住误收
   - 仅当上述 no-drag 薄条在某平台确证持续失效，才升级为常驻低频轮询（如 250ms，对齐 Electron 托盘源码的频率选择）

3. **不建议**：把 cursor 轮询作为唯一 hover 机制。理由——无主流先例、CPU 常驻、时延、事件重复、坐标系需手动维护，且 Wayland 直接不可用。它该是"事件通路的兜底"，不是"替代事件"。

### 6.4 一句话决策

> no-drag 薄条是正路（官方 + 主流 + 低复杂度），cursor 轮询是逃生舱（有 Electron 自家托盘源码与 #611 gist 为先例，但只在事件通路确证失效时按需启用，不做主机制）。

---

## 参考来源索引

- [Electron screen API 官方文档](https://www.electronjs.org/docs/latest/api/screen) — getCursorScreenPoint 返回 DIP；Wayland 不支持
- [Electron Display Object 官方文档](https://www.electronjs.org/docs/latest/api/structures/display) — bounds/workArea 为 DIP
- [Electron Custom Window Interactions 官方文档](https://www.electronjs.org/docs/latest/tutorial/custom-window-interactions) — drag 区吞所有指针事件；no-drag 恢复
- [electron/shell/browser/ui/win/notify_icon_host.cc 源码](https://github.com/electron/electron/blob/main/shell/browser/ui/win/notify_icon_host.cc) — 250ms 轮询 GetCursorScreenPoint + GetBounds.Contains 做托盘 enter/exit
- [electron issue #611 wontfix — mouseleave 不触发](https://github.com/electron/electron/issues/611)
- [louisameline windowMouseOutFix.js gist — #611 轮询 workaround](https://gist.github.com/louisameline/1213bb112c6cb12a98b2ab525dfb8b07)
- [HaibinZhang1/JingRanTodo 疑难问题解决方案.md — 混合模式（事件+光标校验）](https://github.com/HaibinZhang1/JingRanTodo/blob/main/%E7%96%91%E9%9A%BE%E9%97%AE%E9%A2%98%E8%A7%A3%E5%86%B3%E6%96%B9%E6%A1%88.md)
- [clawd-on-desk PR #111 — 高 DPI 拖拽光标漂移，统一到主进程 DIP](https://github.com/rullerzhou-afk/clawd-on-desk/pull/111)
- [openscreen PR #110 — HUD drag DPI-safe，坐标系统一物理像素，拖拽中冻结 content measurement](https://github.com/getopenscreen/openscreen/pull/110)
- [electron issue #51679 — frameless+thickFrame 41.3 起 HWND 外扩，getBounds 不再匹配可见边](https://github.com/electron/electron/issues/51679)
- [electron issue #5723 — CSS cursor 在 titleBarStyle hidden 顶部不生效](https://github.com/electron/electron/issues/5723)
- [electron issue #21632 — hiddenInset 顶部 38px 鼠标交互异常](https://github.com/electron/electron/issues/21632)
- [wake/purdex issue #300 — 详述 VSCode 结构绕开 NSWindow tracking zone 的做法](https://github.com/wake/purdex/issues/300)
- [footballay-core discussion #13 — drag 区在引擎/OS 层吞事件，z-index 无用](https://github.com/PhysicksKim/footballay-core/discussions/13)
- [electron 透明窗口鼠标穿透问题（CSDN sevendemage）— 100ms 轮询做穿透](https://blog.csdn.net/sevendemage/article/details/134475821)
- [Qt underMouse() Alternatives — QCursor::pos() 轮询是次选，enterEvent/leaveEvent 是 idiomatic](https://runebook.dev/en/docs/qt/qwidget/underMouse)
- [Qt实现跨平台窗口选择功能 — 200ms 定时器+GetCursorPos 做窗口拾取](https://blog.csdn.net/qq_43627907/article/details/128218840)
