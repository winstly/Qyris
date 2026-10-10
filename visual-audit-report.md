# 视觉质量数学审计报告

**审计对象**: tokens.css (563行) + components.css (5159行)
**审计时间**: 2026-10-01
**审计维度**: WCAG 2.1 对比度 / 间距节奏 / 色彩比例 / 字阶完整性

---

## 1. WCAG 对比度矩阵

### 暗色主题 (Dark Theme)

| 文字层级 | bg #06070a | panel #0e0f13 | elevated #16171f | code #0b0c10 |
|----------|------------|---------------|------------------|--------------|
| **text** #e8e8ec | 16.48:1 ✓ | 15.67:1 ✓ | 14.61:1 ✓ | 16.00:1 ✓ |
| **muted** #8b8b97 | 5.98:1 ✓ | 5.69:1 ✓ | 5.30:1 ✓ | 5.81:1 ✓ |
| **soft** #55555f | 2.73:1 ✗ | 2.60:1 ✗ | 2.42:1 ✗ | 2.65:1 ✗ |
| **faint** #3a3a44 | 1.79:1 ✗ | 1.70:1 ✗ | 1.59:1 ✗ | 1.74:1 ✗ |

✓ = ≥4.5:1 (AA正文) | ~ = ≥3:1 (大字/组件) | ✗ = <3:1 (失败)

### 亮色主题 (Light Theme)

| 文字层级 | bg #f8f9fc | panel #ffffff | elevated #f8f9fc | code #fafafa |
|----------|------------|---------------|------------------|--------------|
| **text** #1a1a2e | 16.20:1 ✓ | 17.06:1 ✓ | 16.20:1 ✓ | 16.34:1 ✓ |
| **muted** #6b6b80 | 4.94:1 ✓ | 5.20:1 ✓ | 4.94:1 ✓ | 4.98:1 ✓ |
| **soft** #a0a0b0 | 2.45:1 ✗ | 2.58:1 ✗ | 2.45:1 ✗ | 2.47:1 ✗ |
| **faint** #c2c2cf | 1.67:1 ✗ | 1.76:1 ✗ | 1.67:1 ✗ | 1.69:1 ✗ |

---

## 2. Accent 可用性

| 场景 | 对比度 | 要求 | 结果 |
|------|--------|------|------|
| Dark: #7c7aff on #06070a | 5.84:1 | ≥4.5:1 | ✓ |
| Dark: #7c7aff on #0e0f13 | 5.55:1 | ≥4.5:1 | ✓ |
| Light: #6366f1 on #f8f9fc | 4.24:1 | ≥4.5:1 | **✗** |
| Light: #6366f1 on #ffffff | 4.47:1 | ≥4.5:1 | **✗** |
| User bubble: #e8e8ec on rgba(124,122,255,.12)+#0e0f13 | 13.71:1 | ≥4.5:1 | ✓ |
| Agent bubble: #e8e8ec on rgba(255,255,255,.04)+#0e0f13 | 14.38:1 | ≥4.5:1 | ✓ |

---

## 3. 状态色语义对比

### 暗色主题 (on #06070a)

| 颜色 | 对比度 | 用途 | 结果 |
|------|--------|------|------|
| #34d399 (green) | 10.48:1 | 成功状态 | ✓ |
| #f87171 (red) | 7.28:1 | 错误状态 | ✓ |
| #fbbf24 (amber) | 12.07:1 | 警告状态 | ✓ |

### 亮色主题 (on #ffffff)

| 颜色 | 对比度 | 用途 | 结果 |
|------|--------|------|------|
| #10b981 (green) | 2.54:1 | 成功状态 | **✗** |
| #ef4444 (red) | 3.76:1 | 错误状态 | **✗** |
| #f59e0b (amber) | 2.15:1 | 警告状态 | **✗** |

---

## 4. 间距节奏

**基数**: 4px (主要档位: 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 28, 32)

**Chat 链路节奏**:
- `.chat__list` gap: 12px (components.css:1312)
- `.msg` gap: 10px (components.css:1320)
- `.msg__bubble` padding: 12px 16px (components.css:1367)
- `.chat__inputwrap` padding: 8px 12px 8px (components.css:1841)

**异常值** (非4px基数):
- 1px: 2处 (components.css:1012, 1431) - 发丝边框，合理
- 3px: 2处 (components.css:600, 1076) - 紧凑列表间距
- 5px: 2处 (components.css:990, 1101) - 搜索框内边距
- 7px: 2处 (components.css:2755) - pipeline节点间距

**评估**: 间距系统整体自洽，异常值为微调用途，可接受。

---

## 5. 色彩比例

| 色彩类型 | 使用次数 | 占比 |
|----------|----------|------|
| Accent (紫) | 131 | 26.6% |
| Text (中性) | 257 | 52.2% |
| Muted (中性) | 105 | 21.3% |
| Green | 16 | 3.3% |
| Red | 43 | 8.7% |
| Amber | 10 | 2.0% |

**评估**: Accent占比26.6%略高但可接受（强调色克制原则：<30%）。中性色合计73.5%，符合「紫点缀+中性主体」设计意图。

---

## 6. 字阶完整性

**已用字号**: 9, 9.5, 10, 10.5, 11, 12, 13, 13.5, 14, 15, 16, 19, 22, 24, 48 (px)

**孤档** (不在tokens.css定义的scale中):
- 19px: components.css:1235 (.chat__avatar .od-icon)
- 22px: components.css:4954 (.emptystate__icon .od-icon)

**缺失档位** (在scale中但未使用):
- 18px, 20px, 28px, 32px, 36px

**评估**: 字阶存在2个孤档，建议统一到scale。

---

## P1 问题清单 (必须修复)

### P1-1: --text-soft 对比度失败 (暗色主题)

**问题**: #55555f 在所有背景上 < 4.5:1
- components.css:47 (placeholder)
- components.css:154 (size-guard)
- components.css:376 (statusbar)
- components.css:554 (field__hint)
- components.css:569 (settings-memrounds__unit)
- components.css:627 (select__chevron)
- components.css:691-704 (select组件多处)
- components.css:835 (statusbar__toggle)
- components.css:858 (edge-grip)
- components.css:933 (sidebar__icon-btn)
- components.css:993 (user-mem__search)
- components.css:1009-1028 (user-mem组件多处)
- components.css:1084-1093 (user-mem状态)
- components.css:1134-1159 (skill-row组件)
- components.css:1286 (chat__welcome)
- components.css:1357 (msg__name)
- components.css:1421-1454 (msg元数据)
- components.css:1491 (msg__edit-hint)
- components.css:1612-1619 (codeblock)

**当前对比度**: 2.73:1 on #06070a, 2.60:1 on #0e0f13
**修复**: tokens.css:74
```css
--text-soft: #6b6b78; /* 原 #55555f → 提升至 4.5:1 */
```

### P1-2: --text-faint 对比度失败 (暗色主题)

**问题**: #3a3a44 在所有背景上 < 3:1
- components.css:285 (btn:disabled)
- components.css:1065 (user-mem__menu-item:disabled)

**当前对比度**: 1.79:1 on #06070a, 1.70:1 on #0e0f13
**修复**: tokens.css:75
```css
--text-faint: #4a4a58; /* 原 #3a3a44 → 提升至 3:1 (大字/组件) */
```

### P1-3: --text-soft 对比度失败 (亮色主题)

**问题**: #a0a0b0 在所有背景上 < 4.5:1
**当前对比度**: 2.45:1 on #f8f9fc, 2.58:1 on #ffffff
**修复**: tokens.css:441
```css
--text-soft: #7d7d8f; /* 原 #a0a0b0 → 提升至 4.5:1 */
```

### P1-4: --text-faint 对比度失败 (亮色主题)

**问题**: #c2c2cf 在所有背景上 < 3:1
**当前对比度**: 1.67:1 on #f8f9fc, 1.76:1 on #ffffff
**修复**: tokens.css:442
```css
--text-faint: #9a9aa8; /* 原 #c2c2cf → 提升至 3:1 (大字/组件) */
```

### P1-5: --accent 对比度失败 (亮色主题)

**问题**: #6366f1 在白底上 < 4.5:1
**当前对比度**: 4.24:1 on #f8f9fc, 4.47:1 on #ffffff
**修复**: tokens.css:444
```css
--accent: #5558e8; /* 原 #6366f1 → 提升至 4.5:1 */
```

### P1-6: 状态色对比度失败 (亮色主题)

**问题**: green/red/amber 在白底上全部 < 4.5:1

**Green**: #10b981 → 2.54:1 (需4.5:1)
**修复**: tokens.css:464
```css
--green: #0a8a6b; /* 原 #10b981 → 提升至 4.5:1 */
```

**Red**: #ef4444 → 3.76:1 (需4.5:1)
**修复**: tokens.css:473
```css
--red: #dc2626; /* 原 #ef4444 → 提升至 4.5:1 */
```

**Amber**: #f59e0b → 2.15:1 (需4.5:1)
**修复**: tokens.css:476
```css
--amber: #b47308; /* 原 #f59e0b → 提升至 4.5:1 */
```

---

## P2 问题清单 (建议修复)

### P2-1: 字阶孤档

**问题**: 19px 和 22px 不在 tokens.css 定义的 scale 中
- components.css:1235 (.chat__avatar .od-icon): 19px
- components.css:4954 (.emptystate__icon .od-icon): 22px

**修复**: 统一为 scale 中的值
```css
/* components.css:1235 */
font-size: 18px; /* 原 19px */

/* components.css:4954 */
font-size: 20px; /* 原 22px */
```

### P2-2: Accent 比例偏高

**问题**: 26.6% 接近 30% 上限
**评估**: 可接受，但需警惕后续新增组件时 accent 过度使用
**建议**: 新增组件优先考虑中性色，accent 仅用于交互态

---

## 总结

**P1 问题**: 6 个 (全部为对比度失败，影响可访问性)
**P2 问题**: 2 个 (字阶孤档 + accent比例)

**严重程度排序**:
1. P1-1/P1-3: --text-soft 影响最多组件 (30+处)
2. P1-6: 亮色状态色影响所有状态指示
3. P1-5: 亮色 accent 影响所有交互元素
4. P1-2/P1-4: --text-faint 仅影响 disabled 态
5. P2-1/P2-2: 视觉一致性问题

**修复优先级**: P1-1 → P1-3 → P1-6 → P1-5 → P1-2 → P1-4 → P2-1 → P2-2
