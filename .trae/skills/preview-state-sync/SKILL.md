---
name: "preview-state-sync"
description: "Keeps live derived previews (calc results, hints) in sync with controlled inputs. Invoke when building inputs with live previews, or when a preview won't clear after Enter, cross-field linkage, reset, or blur."
---

# 受控输入的派生预览状态同步（preview-state-sync）

## 这个 skill 解决什么问题

受控输入框（Vue/React 的 `:value` + `@input`）旁边挂一个**实时派生预览**（如算式结果 `= 297.00`、校验提示、格式化建议）时，预览是**派生状态**——它从输入框的值推导而来。

值有两类写入路径，预览的失效策略完全不同：

| 写入路径 | 预览该怎么走 |
|---|---|
| **用户在本框亲自敲键**（`onInput`） | 用 `refreshPreview(raw, previewRef)` 重新推导：合法→显示结果，非法→显示 `?`，纯值→清空 |
| **值被程序化覆盖**（回车应用、**另一个框的联动/反算**、重置、失焦恢复） | **必须立即清空预览**——框里显示的已不是用户输入的算式，预览失去依据 |

第二类路径最容易漏。本项目 ERC 悬浮窗曾连续 3 次在这上面出 bug（回车不清理、负数结果不清理、下行反算覆盖上行时上行预览残留）。

## 核心规则：程序化写入一律走统一 setter

不要散落地写 `xxx.value = val` 然后靠"记得顺手清预览"。提供成对的 setter，把"写值 + 清预览"做成原子操作：

```js
// ✅ 正确：联动写值收口到 setter，写值和清预览原子完成
function setSrcValue(val) {
  srcRaw.value = val
  srcPreview.value = null   // 派生预览同步失效
}
function setCnyValue(val) {
  cnyVal.value = val
  cnyPreview.value = null
}
```

**分工约定**：
- 用户亲自输入 → `onXxxInput` 里 `xxx.value = e.target.value` + `refreshPreview(raw, previewRef)`（**不**走 setter）
- 任何"别的逻辑"写这个框（回车应用结果、跨框反算、重置清空、初始化）→ **必须**走 `setXxxValue()`

```js
// ❌ 反例：跨框反算直接赋值，预览残留（本项目真实 bug）
srcRaw.value = srcAmount.toFixed(2)

// ✅ 正例
setSrcValue(srcAmount.toFixed(2))
```

## 三个必清时机（即使有 setter 也要逐一核对）

1. **Enter/= 应用结果后**：算式被替换成结果值，预览必须消失
2. **跨框联动覆盖后**：A 框输入反算/联动覆盖了 B 框，B 框的预览必须清（双向都要：`setSrcValue` 和 `setCnyValue` 在各自反算路径里都要被调用）
3. **失焦/重置时**：编辑缓冲（editingBuffer）清空、值重置为空时，对应预览一并清

多输入框列表（如 v-for 行）用 reactive map 存预览，失焦/应用时 `delete previews[rowId]`。

## 谓词陷阱：前缀符号会让"是否为算式"误判

判断"输入里有没有运算符"时，**开头的正负号是数字符号，不是二元运算符**，必须先剥掉：

```js
// ❌ 反例：负数结果 "-5.00" 被当成含运算符 → 清掉的预览又被 refreshPreview 设回来
function hasOperator(raw) { return /[+\-*/]/.test(raw) }

// ✅ 正例：先剥离开头符号再判断
function hasOperator(raw) {
  const s = (raw ?? '').trim()
  if (!s) return false
  return /[+\-*/]/.test(s.replace(/^[+-]/, ''))
}
```

同理，"是否纯数字"的谓词要允许负号：`/^-?\d+(?:\.\d+)?$/`，否则负数结果过不了校验、不触发联动。

## 上线前审计 checklist

1. `grep` 出所有 `xxx.value =` 写入点，逐个分类：
   - 用户输入（`e.target.value`）→ 应配 `refreshPreview`
   - 其余全部 → 必须走 `setXxxValue()`，不允许裸赋值
2. 三个时机走查：回车应用、跨框联动（**两个方向**）、失焦/重置
3. 边界值测试：负数结果（`5-10` → `-5.00`）、除零、非法算式（`1+3*/52`）、带单位尾巴（`1+5美元`）
4. 预览容器本身：`flex-shrink: 0; white-space: nowrap`，宽度随内容自适应，出现时把输入内容自然顶开而不是挤压换行

## 本项目参考实现

- `src/features/erc/views/FloatingHome.vue`
  - `setSrcValue` / `setCnyValue`：联动写值 + 清预览的统一 setter
  - `refreshPreview(raw, ref)`：用户输入路径的预览推导
  - `applyCalcResult(raw)`：回车应用，返回结果或 null
  - `hasOperator` / `isPureNumber`：剥离前缀符号的谓词
  - `onSrcKeydown` / `onCnyKeydown` / `onRowKeydown`：回车应用三路径
  - `onRowBlur`：失焦清 editingBuffer + `delete rowPreviews[code]`
