# Pontis UI 设计主题与规范

> 版本：V1  
> 主题名称：**Cold Rational Workspace / 冷灰理性工作台**  
> 产品：**Pontis**  
> 适用范围：Web 控制台、浏览器扩展 UI、后续桌面化界面

---

## 1. 设计主题

Pontis 的核心视觉主题定义为：

> **Cold Rational Workspace / 冷灰理性工作台**
>
> 白与石墨灰构成主体，极淡蓝色只负责交互和状态表达；界面像一个经过精心打磨的桌面工具，而不是传统后台，也不是内容社区。

Pontis 是一个长期使用的书签工作空间。视觉设计应首先服务于：

- 信息密度
- 操作效率
- 层级清晰
- 长时间使用舒适度
- 多设备与同步状态的可理解性
- 对大量书签、文件夹、设备与历史信息的稳定承载

视觉上不追求“惊艳”，而追求“耐看、可靠、精确”。

---

## 2. 核心视觉关键词

Pontis 的界面应体现：

- **Calm**：安静，不制造不必要的视觉刺激
- **Precise**：边界、层级、对齐、状态表达准确
- **Compact**：信息密度高，但不拥挤
- **Flat**：平面优先，少阴影、少装饰
- **Native-like**：接近桌面工具，而非营销型网站
- **Workspace**：以工作区为中心，而非 Dashboard
- **Explorer**：核心内容体验接近文件管理器
- **Rational**：布局与视觉层级遵循功能逻辑

应明确避免：

- SaaS Dashboard 风格
- 大面积品牌色铺陈
- 重渐变
- 玻璃拟态
- 夸张阴影
- 超大圆角卡片
- 大标题 + 大留白
- Landing Page 式视觉
- 内容社区 / Pinterest 式瀑布流
- 为动画而动画

---

## 3. 设计原则

### 3.1 内容优先于装饰

Pontis 的主角是：书签、文件夹、空间、同步状态、活动历史与设备状态。视觉装饰不得抢占内容空间。

### 3.2 密度优先，但保持呼吸感

Pontis 面向长期、高频使用。页面应允许一次展示较多内容。推荐通过较小的垂直间距、稳定的横向对齐、统一行高、低对比度边框与克制的字体层级，实现“紧凑而不拥挤”。

### 3.3 正常状态应退居背景

“已同步”“正常”“健康”等状态不应该持续抢占注意力。只有警告、需要恢复、冲突、失败、需要用户操作等状态应主动提高视觉权重。

### 3.4 结构依靠边框与背景层级，而非阴影

Pontis 的主体页面主要通过 1px Divider、极轻背景差异、Spacing 与 Typography 表达区域层级。Shadow 仅用于 Menu、Popover、Dropdown、Command Palette、Modal、Tooltip 等浮层。

### 3.5 UI 不承担业务解释之外的额外情绪

错误应明确，恢复应说明原因，删除应说明影响；避免过度警告、大面积红色、拟人化提示与夸张插画。

---

## 4. Design Token 策略

### 4.1 Token Source of Truth

基础 Design Tokens 以 **Mantine Theme** 为唯一来源，包括 Color Palette、Font Family、Font Size、Spacing、Radius、Breakpoints、Shadows 与 Component Defaults。

Vanilla Extract 不重新建立第二套完整 Token 系统，应优先使用 Mantine 暴露的 CSS Variables，例如：

```css
var(--mantine-color-body)
var(--mantine-color-text)
var(--mantine-color-default-border)
var(--mantine-color-blue-6)
var(--mantine-spacing-sm)
var(--mantine-radius-sm)
```

允许定义少量产品级语义 Token，例如：

```text
--pontis-sync-healthy
--pontis-sync-warning
--pontis-sync-recovery
--pontis-surface-hover
--pontis-surface-selected
```

但这些语义 Token 必须映射自 Mantine Theme，而不是重新定义独立色板。

---

## 5. 色彩规范

### 5.1 Light Mode

整体采用白色、冷灰、石墨黑与低饱和蓝。

| 用途 | 建议 |
|---|---|
| App Background | 极浅冷灰 |
| Main Workspace | 白色 |
| Sidebar | 比 Workspace 略深的冷灰 |
| Primary Text | 深石墨色 |
| Secondary Text | 中性冷灰 |
| Disabled Text | 更浅灰 |
| Border | 极淡冷灰 |
| Hover | 极淡蓝灰 |
| Selected | 极淡蓝色 |
| Accent | 低饱和冷蓝 |

参考感受：

```text
App Background   ≈ #F8F9FA
Workspace        ≈ #FFFFFF
Sidebar          ≈ #F6F7F8
Border           ≈ #E7E9EC
Primary Text     ≈ #202329
Secondary Text   ≈ #6B717A
```

具体值以 Mantine Theme 最终配置为准。

### 5.2 Accent Blue

蓝色不是品牌铺色，而是交互色。主要用于当前选中、Focus、Primary Action、Active Filter、Link 与 Syncing。

应避免蓝色 Sidebar、蓝色 Header、大面积蓝色 Card、强高饱和按钮，以及 Selected Row 使用深蓝底白字。

### 5.3 状态颜色

| 状态 | 颜色倾向 |
|---|---|
| Healthy | 灰绿色 |
| Syncing | 淡蓝 |
| Warning | 柔和琥珀 |
| Recovery | 柔和橙 |
| Error | 柔和红 |
| Offline | 中性灰 |
| Disabled | 浅灰 |

状态颜色应偏低饱和。

---

## 6. Dark Mode

Dark Mode 使用 **Graphite Dark**，而不是纯黑。

推荐层次：

```text
App Background     #111315 附近
Workspace          #17191C 附近
Raised Surface     #1D2024 附近
Border             #2A2D31 附近
```

规则：

- 不使用纯 `#000000` 作为主体背景
- 不使用过亮白色正文
- Accent Blue 在 Dark Mode 可略微提高亮度
- Border 保持微弱
- Selected 使用深蓝灰，而非鲜艳蓝

Dark Mode 必须从 V1 起作为一等主题设计，而不是 Light Mode 完成后的简单反色。

---

## 7. 字体与排版

### 7.1 字体

默认使用系统字体栈，优先保证跨平台一致性与可读性。

```text
-apple-system
BlinkMacSystemFont
"Segoe UI"
"Inter"
sans-serif
```

开发者信息、Revision、UUID、Binding ID 等使用：

```text
ui-monospace
SFMono-Regular
Consolas
monospace
```

### 7.2 字号

| 场景 | 推荐字号 |
|---|---:|
| Product Name | 18–20px |
| Page Title | 17–18px |
| Breadcrumb | 14px |
| Primary Content | 14px |
| Secondary Content | 13px |
| Metadata / Time | 12–13px |
| Diagnostics | 12–13px |
| Table Header | 12–13px |

避免使用 32px 页面标题、20px 卡片正文等营销型比例。

### 7.3 字重

推荐：

- Regular：400
- Medium：500
- Section / Page Title：600

尽量避免大量 `700`。

---

## 8. 密度与尺寸

Pontis 默认 Density 为 **Compact**。

| 元素 | 尺寸 |
|---|---:|
| Sidebar Width | 224px |
| Header Height | 56px |
| Toolbar Height | 44px |
| Explorer Header | 36px |
| Explorer Row | 38px |
| Small Control | 30px |
| Normal Control | 34px |
| Icon | 16–18px |

设计目标：1080p 高度下，Explorer 应尽可能一次显示约 15–20 条内容。

---

## 9. Spacing

建议遵循 Mantine spacing scale。

常见使用原则：

- 同组控件：4–8px
- Toolbar Item：8–12px
- 内容块内部：12–16px
- 页面主要 Section：20–24px
- 大页面间距谨慎使用 32px 以上

Pontis 不采用大面积 48px / 64px 留白作为主要视觉手段。

---

## 10. 圆角

整体圆角偏小。

| 元素 | Radius |
|---|---:|
| Button | 6px |
| Input | 6px |
| Selected Item | 5–6px |
| Menu / Popover | 8px |
| Card | 8px |
| Dialog | 10px |
| Explorer Main Surface | 0–6px |

避免 16px / 20px / 24px 全局大圆角，以及每个区域都套圆角容器。

---

## 11. Border 与 Shadow

### 11.1 Border

Border 是 Pontis 最重要的视觉组织工具之一。推荐使用 `1px subtle border`，用于 Sidebar / Workspace 分隔、Header / Content 分隔、Toolbar、Table Header、Row Divider、Inspector 与 Settings Section。

### 11.2 Shadow

主体区域默认无 Shadow。Shadow 仅用于 Menu、Dropdown、Popover、Command Palette、Modal 与 Tooltip。

---

## 12. Icon 规范

推荐使用 `@tabler/icons-react`。

```text
size: 16 / 18px
stroke: 1.5 ~ 1.7
```

颜色：

- 默认：Secondary Gray
- Active：Muted Blue
- Dangerous：Muted Red
- Status：对应语义色

书签 favicon 是 Explorer 中最主要的自然彩色元素。Folder 默认可使用冷灰 / 柔和色，避免每个 Folder 都是亮蓝色。

---

## 13. Application Shell

整体结构：

```text
┌────────────┬─────────────────────────────────────┐
│ Sidebar    │ Header                              │
│            ├─────────────────────────────────────┤
│            │ Toolbar                             │
│            ├─────────────────────────────────────┤
│            │                                     │
│            │ Workspace                           │
│            │                                     │
└────────────┴─────────────────────────────────────┘
```

主体不是“灰色网页背景 + 中央大 Card”，而是浏览器窗口本身就是 Workspace。

---

## 14. Sidebar

Sidebar 是工具导航，不是网站菜单。

```text
Pontis

空间
  个人
  工作
  学习
  + 新建空间

────────

  广场
  最近活动
  任务

────────

  设备
  设置

────────

  当前用户
```

规则：

- 宽度约 224px
- Row 高度 32–36px
- Icon 16–18px
- Group Label 弱化
- Selected 使用淡蓝背景
- Text 保持深色
- 不使用深蓝底白字
- Divider 极淡
- 用户区域尽量简洁

Space 是一等对象，不需要再经过一个“书签”总入口。

---

## 15. Header

Header 应保持安静。

```text
个人 / 开发                  [搜索...]   ✓ 已同步   [+ 新建]
```

建议包含 Breadcrumb、Search、Sync Status、Primary Action 与少量全局操作。

避免巨型 Page Title、多层 Header 与大面积品牌区域。

---

## 16. Search 与 Command Palette

Search 是 Pontis 的一级交互。

搜索框建议：

- 高度约 34px
- 宽度约 320–400px
- 浅背景
- 1px Border
- Focus 使用淡蓝 Border / Ring

```text
⌕ 搜索书签、文件夹、链接               Ctrl K
```

`Ctrl + K / ⌘K` 打开统一 Command Palette，可包含：搜索全部空间、新建书签、新建文件夹、切换空间、移动到、检查失效链接、打开广场、打开设备与打开设置。

---

## 17. Toolbar

Toolbar 应接近 Finder / IDE，而不是按钮墙。

```text
全部   文件夹   书签    ↕ 排序    检查失效链接
```

规则：

- 普通项尽量使用 Text + Icon
- Hover 才出现背景
- Active Filter 使用浅底
- Secondary Action 不使用强按钮
- Primary Button 仅保留 1 个左右

---

## 18. Bookmark Explorer

Bookmark Explorer 是 Pontis 的视觉与交互中心。

### 18.1 基本形式

采用文件管理器风格列表，而不是普通后台 Table。

```text
名称                         链接                   更新时间
────────────────────────────────────────────────────────────
▸ 开发资源
  GitHub                      github.com              14:25
  Go 官方文档                  go.dev                  14:20
  React                       react.dev               14:18
```

### 18.2 行高

推荐 `38px`。

### 18.3 Column Header

- 12–13px
- Secondary Text
- Medium
- 不抢内容视觉权重

### 18.4 Hover / Selected

```text
Normal      white
Hover       very light cool gray
Selected    very light blue
Focus       slightly stronger pale blue
```

避免深色反白选中。

### 18.5 Folder

Folder 行：可展开 / 折叠、图标克制、Title 可使用 Medium，并可显示 item count，但应弱化。

### 18.6 Bookmark

Bookmark 行主要信息：favicon、title、URL / Host、updated time 与 More Action。favicon 是列表中自然的彩色元素。

### 18.7 交互

Explorer 应逐步支持：Single Select、Multi Select、Keyboard Navigation、Context Menu、Inline Rename、Drag & Drop、Folder Expand / Collapse、Breadcrumb Navigation 与 Batch Operations。

---

## 19. Inspector

右侧 Inspector 默认不常驻。当用户主动查看某个 Bookmark / Folder 详情时才出现。

推荐宽度：`280–320px`。

```text
GitHub

github.com

所在位置
个人 / 开发

创建时间
昨天 14:32

最近修改
Edge on Windows
```

Inspector 是辅助信息面板，不应长期压缩 Explorer。

---

## 20. Card 使用原则

Pontis 不排斥 Card，但应限制在真正需要“独立信息单元”的场景。

适合：Plaza Publication、某些 Empty State、简短状态摘要与 onboarding。

不适合：所有设置项、Explorer 主内容、Activity 每一条、设备列表每一行、Dashboard KPI。

Card 风格：White / subtle surface、1px Border、8px Radius、无或极轻 Shadow。

---

## 21. 首页

Pontis 首页不采用传统 KPI Dashboard。

### 方案 A：直接进入最近使用 Space

用户登录后直接恢复 `Personal / Development` 等最近工作位置。这是推荐默认方式。

### 方案 B：内容型 Home

如果需要 Home，可使用：最近使用、需要处理、最近修改、Pinned。

```text
最近使用

GitHub                    2 分钟前
Go 官方文档                15 分钟前
TanStack                  昨天

需要处理

稍后阅读                  3
待整理                    7
失效链接                  12
```

保持平面、紧凑，不做 KPI 卡片阵列。

---

## 22. Plaza

Plaza 可以比 Explorer 稍微松一些，但仍属于同一个视觉系统。

```text
Go 开发资源
Mahoo

183 个书签 · 21 个文件夹

Go / Web / Libraries

更新于 2 天前
```

规则：

- 2–3 Columns
- Medium Density
- 轻 Border
- 8px Radius
- 不依赖大封面
- 不做瀑布流
- 不做内容社区式点赞视觉

Plaza 的重点是结构化书签集合，而不是社交内容流。

---

## 23. Activity

Activity 建议采用类似 Git History 的 Timeline。

```text
今天

15:32  Edge on Windows
       将「GitHub」移动到 开发 / 工具

15:21  Organizer
       删除了 12 个失效书签
       撤销

14:11  Firefox on Mac
       新建了「React」
```

规则：

- 不为每条 Activity 创建 Card
- 时间列保持紧凑
- 来源信息清晰
- Undo 使用轻量 Action
- Error / Recovery 才提升视觉权重

---

## 24. 用户任务中心与管理员后台任务

Pontis 将“用户领域任务”和“系统后台任务”明确分开。

### 24.1 用户「任务」

用户「任务」作为 Sidebar 的二级主导航，与「最近活动」同组。它回答：

> “我让 Pontis 现在或以后帮我做什么？”

页面不做 Generic Scheduler Dashboard，而采用紧凑的三段式工作区：

```text
任务                                      + 新建任务

正在运行
检查失效链接     个人      342 / 1,280      取消

计划任务
每日自动备份     个人      每天 02:00        …
每周链接检查     工作      周日 03:00        …

最近完成
备份 Personal    成功      2 分钟前
链接检查          12 个问题 昨天 03:14
```

视觉规则：

- 不使用 KPI Card Grid；
- 正在运行任务可显示 Progress / Phase；
- Schedule 以领域名称展示，不显示 Cron / Payload；
- 支持「立即运行」「编辑」「暂停」；
- 删除计划只停止未来执行，历史记录继续保留；
- 创建任务使用领域模板，例如「自动备份」「检查失效链接」。

领域页面仍是任务配置的主要入口，例如 Backup 页面配置自动备份、Organizer 页面配置定期链接检查；任务中心负责跨 Space 聚合与统一管理。

### 24.2 管理员「设置 / 后台任务」

管理员页面属于 Management World，采用 Filter + Dense Table：

```text
后台任务

状态 [全部]  类型 [全部]  所有者 [全部]  时间 [最近 24 小时]

Type                  Owner       Status        Started
backup.create         Mahoo       Running       21:13
mail.send             System      Success       21:12
journal.gc            System      Success       21:00
```

可展开查看：Job ID、Attempt、Progress、Worker、Lease、Error Code、Request ID、Duration 等运维数据。

管理员页面不得显示用户私有 Bookmark Title/URL、未脱敏 payload/result 或 Secret。它是服务器运行状态视图，不是跨用户内容浏览器。

---

## 25. Settings / Devices / Backups

这些页面属于 Management World，可以采用更加传统的管理布局，适合使用 Mantine Table、TanStack Table、Settings Sections、Form、Tabs、Drawer 与 Modal。

```text
设备名称             状态        最后同步
Edge on Windows      正常        刚刚
Firefox on Mac       离线        2 小时前
```

---

## 26. Diagnostics

Diagnostics 可以更偏 Developer Tool。

推荐使用 Monospace、Dense Key / Value、Structured Table、Timeline 与 Code-like ID。

```text
Binding ID          019...
Epoch               4
Applied Revision    18,320
Received Revision   18,327
Server Revision     18,340
```

不要将这些内部信息带入普通用户主界面。

---

## 27. Form

优先使用 Mantine Form + Mantine Input Components。

规则：

- Label 清晰
- Helper Text 克制
- 表单宽度通常 400–640px
- 不做超大 Input
- Required / Error 状态清晰
- Secret 默认不可回显

---

## 28. Modal / Dialog

普通 Modal 宽度建议 `400–480px`，复杂设置 `560–640px`。

规则：

- 小圆角
- 无插画
- 标题简洁
- Footer Action 靠右
- Primary Action 唯一
- Destructive 操作使用红色

---

## 29. Destructive Operation

危险操作必须清晰说明影响。

```text
删除「开发」？

其中包含 183 个书签和 12 个文件夹。
这个操作可以在 30 天内撤销。

取消                              删除
```

禁止仅显示“确定删除吗？”、大面积红色警告背景，以及不说明影响范围。

---

## 30. Empty State

Pontis 不采用营销式 Empty State。

```text
这个空间还是空的

你可以从浏览器同步现有书签，
或创建第一个书签。

[导入书签]   新建书签
```

视觉采用小型 neutral icon、适量留白、无巨大插画、无营销文案。

---

## 31. Loading

优先使用 Skeleton、Row Placeholder 与 Inline Spinner。

避免整页 Blocking Spinner、页面频繁闪烁与过长动画。Explorer 加载时应尽可能维持原有结构。

---

## 32. Error

### 可恢复错误

```text
暂时无法连接服务器
正在重试…
```

保持低干扰。

### 需要用户操作

```text
同步需要恢复

服务器上的书签历史已发生变化，
同时此浏览器还有 3 个未同步修改。

[开始恢复]
```

此类状态应提供明确原因与下一步操作。

---

## 33. Motion

动画应作为反馈，而不是表现。

```text
Hover Background   100ms
Opacity            100–150ms
Popover            100–150ms
Menu               100–150ms
```

允许 Drag & Drop position animation、Drawer / Modal subtle transition 与 Loading progress。

避免 Card floating、Spring everywhere、Page slide transition、Blur / glass animation 与 decorative motion。

---

## 34. Accessibility

必须保证：

- Keyboard Navigation
- Visible Focus
- Color Contrast
- Semantic HTML
- Accessible Labels
- Screen Reader Friendly
- Reduced Motion
- 不依赖颜色单独表达状态

Explorer 需要特别关注 Arrow Key、Enter、Space、Context Menu、Multi Select 与 Focus Management。

---

## 35. 响应式策略

Pontis 是 Desktop-first Workspace。

主要目标宽度：`≥ 1024px`。

优先适配：1366×768、1440×900、1920×1080 与 2K / Retina。

窄屏时：

- Sidebar 可折叠
- Inspector 使用 Overlay / Drawer
- Toolbar 可收纳低频 Action
- Table 次要 Column 可隐藏

不为移动端强行把 Explorer 改造成 Card Feed。

---

## 36. Mantine 与 Vanilla Extract 分工

### Mantine 负责

Theme、Button、Input、Select、Checkbox、Menu、Popover、Modal、Drawer、Tooltip、Tabs、Badge、Notification、Form 与基础交互组件。

### Vanilla Extract 负责

App Shell、Sidebar Layout、Workspace、Explorer、Inspector、Plaza Layout、Activity Timeline、Complex Responsive Layout、产品专属交互状态与非 Mantine 标准组件的样式。

原则：

> Mantine 提供 primitives 与 Theme，Vanilla Extract 负责 Pontis 自己的界面结构。

避免同时混用 CSS Modules、Styled Components、Emotion 自定义样式体系、大量 inline style 与多套 Theme Token。

---

## 37. 页面视觉分区

### Content World

包括 Bookmark Explorer、Plaza、Activity 与 Search。

特点：内容优先、平面、高密度、Explorer / Timeline / Content Layout。

### Management World

包括 Devices、API Tokens、Backup、Users、Settings、Jobs 与 Diagnostics。

特点：表格、Form、Settings Section 与状态列表。

两者使用同一 Design System，但信息组织方式不同。

---

## 38. 推荐组件密度

建议在 Mantine Theme 中统一配置较紧凑的默认尺寸，例如：

```text
Button        sm
Input         sm
Select        sm
Menu Item     compact
Checkbox      xs/sm
Badge         sm
```

具体实现时通过 Theme Component Defaults 统一，而不是每个页面反复写 `size="sm"`。

---

## 39. Pontis Logo 与品牌

Logo 建议方向：几何、简单、单色优先、低装饰，并与 “Pontis / Bridge / Connection / Sync” 概念相关。

可探索：Bridge、Connection、Cross-space、Synchronization 与抽象字母 P。

Sidebar 中 Logo 应保持 Graphite / Muted Blue，避免渐变 Logo 主导界面。

---

## 40. Do / Don't

### Do

- 使用平面工作区
- 使用细边框分层
- 使用紧凑行高
- 使用淡蓝 Selected
- 使用 favicon 提供自然色彩
- 使用统一 spacing
- 正常状态弱化
- 错误状态说明原因
- 高风险操作说明影响
- 让 Explorer 占据主视觉

### Don't

- 不做 KPI Dashboard
- 不做大圆角 Card Grid
- 不做强品牌蓝铺色
- 不做大面积 Shadow
- 不做玻璃拟态
- 不做巨大标题
- 不做营销式 Empty State
- 不做社交媒体式 Plaza
- 不在正常同步状态上制造高视觉权重
- 不在不同页面建立不同视觉语言

---

## 41. V1 UI 基线

```text
Theme
Cold Rational Workspace

Density
Compact

Sidebar
224px

Header
56px

Toolbar
44px

Explorer Row
38px

Control
30 / 34px

Content Radius
0–8px

Dialog Radius
10px

Primary Text
14px

Secondary Text
13px

Page Title
18px

Icon
16–18px

Main Border
1px subtle

Primary Palette
White + Graphite + Cool Gray

Accent
Muted Cool Blue

Shadow
Floating Surfaces Only

Theme Source
Mantine Theme

Custom Styling
Vanilla Extract
```

---

## 42. 最终设计判断标准

每设计一个 Pontis 页面或组件，都可以用下面的问题判断是否符合主题：

1. 它看起来像长期使用的工具，还是一次性展示页面？
2. 内容是不是比装饰更突出？
3. 是否使用了过多 Card、颜色或圆角？
4. 正常状态是否足够安静？
5. 用户能否快速判断当前位置与下一步操作？
6. Explorer / 数据是否获得了最多空间？
7. Border、Spacing、Typography 是否已经足够表达层级？
8. 是否真的需要 Shadow？
9. 是否真的需要 Primary Blue？
10. 一天使用 8 小时后，这个界面还会不会显得吵？

如果大多数答案符合上述原则，则该设计基本符合 Pontis 的 **Cold Rational Workspace**。

---

## 43. 结论

Pontis 的 UI 不应追求“第一眼惊艳”，而应追求：

> **第一天清晰，第一周顺手，一年后仍然耐看。**

最终视觉目标是：

> **像一个专注于书签与同步的现代桌面工作台：冷静、克制、可靠、精确。**


## 36.1 设置与管理员管理区的信息架构

Pontis 必须严格区分 **个人设置（Settings）** 与 **实例管理（Administration）**。

这是产品信息架构约束，而不仅是视觉偏好。

### 普通用户设置

「设置」只表示“当前用户自己的配置”，固定承载：

```text
设置
├── 账户
├── 偏好
└── API Token
```

允许后续加入与当前用户直接相关的个人配置，但不得加入实例级管理对象。

以下内容禁止放在个人「设置」Tab 中：

- 用户管理；
- 后台任务管理；
- 注册模式；
- 全局用户限制；
- 实例级 SMTP / Retention / Security Policy；
- 其他实例级全局配置。

### 管理员管理区

管理员登录后，在主 Sidebar 中增加独立的「管理」分区：

```text
管理
  用户
  后台任务
  系统设置
```

推荐整体 Sidebar：

```text
空间
  个人
  工作
  学习
  + 新建空间

────────

广场
最近活动
任务

────────

设备
设置

────────        ← 仅管理员显示

管理
  用户
  后台任务
  系统设置
```

「管理」是 Section Label，可不作为可点击页面。

### 三个管理员页面的职责

#### 用户

管理实例中的用户账户与身份状态，例如：

- 用户列表；
- active / disabled；
- admin / user；
- 创建时间、最后活动；
- 配额 / Space 数量等非私密元数据。

管理员权限不因此获得私人书签内容读取能力。

#### 后台任务

用于 Server 运维：

- queued / running / retry / failed jobs；
- Worker / Lease；
- System Jobs；
- User Job 非敏感元数据；
- Retry / Cancel；
- Error Code / Request ID / Duration。

它与普通用户的「任务」页面不同：

```text
任务
→ 用户希望 Pontis 做什么

后台任务
→ Server 当前正在执行什么
```

#### 系统设置

只包含实例级可配置策略，例如：

- 注册模式；
- 会话策略；
- 每用户 Space 上限；
- SMTP；
- Retention；
- 系统级安全策略；
- 其他全局默认值。

「系统设置」不得再用“打开用户管理”“后台任务”等按钮作为其他管理模块的主要入口。

允许存在上下文快捷链接，例如：

```text
当前失败后台任务：2
查看后台任务 →
```

但正式导航入口必须始终存在于管理员 Sidebar。

### 路由建议

个人设置：

```text
/settings/account
/settings/preferences
/settings/api-tokens
```

管理员区域：

```text
/admin/users
/admin/jobs
/admin/system
```

不推荐：

```text
/settings/system/users
/settings/system/jobs
```

因为这会重新把独立管理对象错误归类为 System Settings。

### 权限与显示规则

- 非管理员：不渲染整个「管理」分区；
- 管理员：显示稳定的三个入口；
- Server 端始终再次执行管理员权限校验；
- 不能以“页面没显示”为授权机制；
- 用户降级为普通用户后，任何 `/admin/*` 请求必须立即失去访问权限。

### 设计判断

判断一个功能应该放「设置」还是「管理」时使用以下问题：

> 这是在修改“我自己的 Pontis 使用方式”，还是在管理“这个 Pontis 实例”？

前者进入「设置」，后者进入「管理」。

如果对象本身具有独立生命周期、列表、状态或运维行为（例如 User、Job），则应优先成为管理区独立页面，而不是埋在「系统设置」内部。
