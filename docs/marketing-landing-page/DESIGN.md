# DESIGN.md — Landing Page 设计架构

> 面向接手者、维护者、复制者。本文回答的不是「它现在长什么样」，而是「**为什么长这样、改它要遵守什么规则**」。

---

## 0. 设计意图：编辑设计系统（Editorial Design）

核心隐喻：**一份印刷品 / 严肃出版物**——参考系是 Stripe Press、The Verge 长稿、Linear Changelog、彭博商业周刊，而不是 "AI SaaS landing page"。

**和默认模板的对立**：

| 默认 AI 模板倾向 | 本项目立场 |
|---|---|
| 紫罗兰 + 品红 + 霓虹粉 | 暖米白纸张 + 近黑油墨 + 单一森林绿 |
| 彩虹渐变图标 (amber/orange/rose/sky/violet) | 全部实色墨黑 |
| 冷 slate-900 / slate-950 深色 | 暖墨 `#0f100e`（像翻到杂志暗页） |
| 紫色 / 青色辉光 / blur orb | 几乎不用；最多 hero 顶部一抹 sepia 暖晕 |
| 玻璃质感 / 噪点 / mesh gradient | 纯纸面 + 一条暖灰发丝线 |
| 居中 emoji + "Built with ✨" | Inter 单字族 + 强对比排版 |

> **重要**：editorial ≠ 衬线字体。Inter + 强对比排版（tracking-tight + leading-[1.1]）也能做出印刷感，关键在**色彩克制 + 字体节奏**。

---

## 1. Token 系统（`src/styles/global.css` 中的 `@theme`）

### 1.1 颜色 Token

| Token | 用途 | 备注 |
|---|---|---|
| `brand-{50..900}` | 主色（森林绿） | `500` 是默认主色，最深用 `700`/`800` |
| `accent-{400..600}` | 辅助色（卡其 / 赭石） | **仅用于需要"第二色"的角落**，从不作为主按钮色 |
| `paper` / `paper-deep` | 暖米白 / 深米白 | body 背景 / 卡片悬停态 |
| `rule` | 暖灰发丝线 | 卡片边框、分隔线 |
| `ink` / `ink-soft` / `ink-mute` | 文字三档 | 标题 / 正文 / 次要文字 |
| `paper-dark` / `paper-deep-dark` / `rule-dark` | 深色模式对应 | **不用 slate-950** |

> **设计契约**：`brand` 永远只指**主色**，`accent` 永远只指**辅色**。绝不允许 `brand-500` 在一个 section 里表示"按钮"而在另一个 section 里表示"链接"——含义必须稳定。

### 1.2 字体

单字族 **Inter**。原因：
- 编辑设计不需要衬线；Inter 的中性与高 x-height 反而更像当代杂志
- 标题 `font-bold tracking-tight leading-[1.1]`
- 正文 `text-base` 到 `text-lg`，`text-slate-700`（深色下 `text-paper` 系）
- caption 用 `text-sm font-medium text-ink-mute`

### 1.3 圆角 / 容器

```
--radius-xl:  1rem    # 小卡片、内嵌元素
--radius-2xl: 1.5rem  # 标准 section 卡片、按钮（lg）
--radius-3xl: 2rem    # 区块大容器、Hero mockup

--container-7xl: 80rem
```

### 1.4 自定义工具类

| 工具类 | 作用 | 出现位置 |
|---|---|---|
| `container-narrow` | `max-w-[72rem]`, 文字长流 | 大部分 section |
| `container-wide` | `max-w-[80rem]`, 多列网格 |
| `bg-grid` / `bg-grid-dark` | 暖灰发丝线网格 | Hero / Showcase 背景 |
| `hero-glow` | 顶部一抹森林绿 10% 晕染 | 仅 Hero |

---

## 2. 配色语义使用规则

### 2.1 文字颜色三档

```
标题/强文本     → text-ink
正文           → text-slate-700   (深色下 text-paper)
次要/caption   → text-ink-mute 或 text-slate-500
链接 hover     → text-brand-600
```

> **不使用** `text-slate-900` / `text-slate-800` 作主文字——这是 AI 模板的标志，应当改用 `text-ink`。

### 2.2 背景使用规则

```
页面底色       → bg-paper           (深色下 bg-paper-dark)
区块强调底色   → bg-paper-deep      (Hero mock、Stats 深色块例外)
卡片底色       → bg-white           (深色下 bg-paper-deep-dark)
装饰网格       → bg-grid            (深色下 bg-grid-dark)
```

### 2.3 强调色使用规则

```
主按钮        → bg-ink / hover:bg-ink-soft    (深色下 bg-white)
主标题字      → 仅 Hero 用 brand-700→500→700 渐变；其他标题一律 ink 实色
图标底色      → bg-ink text-paper            (绝不用彩虹渐变)
Pricing 推荐卡 → bg-brand-50                   (深色下 brand-900/30)
CTA 区块      → bg-brand-700 实色 + paper 文字
```

---

## 3. Section 组件模板

每个 section 都遵循**同一段节奏**：

```
[eyebrow: text-sm font-semibold tracking-wider uppercase text-brand-600]
[h2:  text-4xl sm:text-5xl font-bold tracking-tight text-ink]
[lede: mt-6 max-w-2xl mx-auto text-lg text-slate-700]
[grid: mt-16 grid gap-6 ...]
```

### 3.1 章节清单（按页面顺序）

| Section | 文件 | 关键设计决策 |
|---|---|---|
| Header | `Header.astro` | 固定顶栏 + 主题切换 + Logo 用纯 ink，不渐变 |
| Hero | `Hero.astro` | **唯一**允许品牌渐变字的位置；底部产品预览 = 暗色 mock + 1px 暖墨发丝边 |
| LogoCloud | `LogoCloud.astro` | 用 wordmark，不放真客户 logo；`text-ink-mute/60` |
| Features | `Features.astro` | 6 卡片网格；图标 11×11 `rounded-xl bg-ink text-white` |
| Showcase | `Showcase.astro` | 左终端 mock + 右文案；终端保留真实终端色（`emerald-400` / `amber-400`） |
| Stats | `Stats.astro` | **唯一**允许 bg-ink 实色大块的 section，制造"翻到杂志暗页"的呼吸感 |
| Testimonials | `Testimonials.astro` | 3 列；头像 10×10 `rounded-full bg-ink text-white` |
| Pricing | `Pricing.astro` | 3 档，中间档 `bg-brand-50` 浅暖绿区分 |
| FAQ | `Faq.astro` | 原生 `<details>`，零 JS；左侧细 border-brand-500 选中态 |
| CTA | `Cta.astro` | **唯一**允许纯色大块 brand-700 背景的位置 |
| Footer | `Footer.astro` | 4 列链接 + Logo ink 实色 |

---

## 4. 组件设计模式

### 4.1 Button

```astro
<!-- 主操作：墨色实色 -->
<a class="inline-flex items-center justify-center gap-x-2 rounded-2xl
          bg-ink px-6 py-3.5 text-sm font-semibold text-white
          shadow-sm hover:bg-ink-soft transition-colors">
  Get started <ArrowRight />
</a>

<!-- 次操作：描边 -->
<a class="rounded-2xl bg-white px-6 py-3.5 text-sm font-semibold
          text-ink ring-1 ring-inset ring-slate-200
          hover:bg-slate-50 transition-colors">
  Learn more
</a>
```

**约定**：
- 圆角统一 `rounded-2xl`（lg 档）；Hero CTA 可用 `rounded-xl`
- 主操作永远是**墨色**，不出现品牌色按钮——印刷品里按钮就是油墨
- 文字后跟 16px 箭头图标，间距 `gap-x-2`

### 4.2 Card

```astro
<div class="rounded-2xl bg-white p-8 ring-1 ring-rule
            hover:ring-slate-300 hover:shadow-xl hover:shadow-slate-900/5
            transition">
  ...
</div>
```

**约定**：
- `rounded-2xl` + `ring-1 ring-rule` + 内 padding 8
- hover 双变化：边框加重 + 阴影
- 阴影颜色用 `slate-900/5` 或 `ink/5`，**绝不用品牌色阴影**（避免回到"AI glow"）

### 4.3 IconBlock

```astro
<div class="flex h-11 w-11 items-center justify-center
            rounded-xl bg-ink text-white">
  <Icon class="h-6 w-6" />
</div>
```

**约定**：所有 section 的图标都是同一形态——11×11，墨底纸字。**没有渐变图标，没有彩色图标**。

### 4.4 Avatar

```astro
<div class="h-10 w-10 rounded-full bg-ink flex items-center justify-center
            text-white font-semibold text-sm">
  {initials}
</div>
```

### 4.5 Badge

```astro
<span class="inline-flex items-center rounded-full bg-ink px-2.5 py-0.5
             text-xs font-medium text-white">New</span>
<span class="... bg-brand-50 text-brand-700">Beta</span>
```

### 4.6 Terminal Mock（`Showcase.astro`）

```astro
<div class="rounded-2xl bg-ink text-left font-mono text-sm
            shadow-2xl shadow-ink/10 ring-1 ring-rule-dark">
  <div class="border-b border-rule-dark px-4 py-3 flex gap-1.5">
    <span class="h-2.5 w-2.5 rounded-full bg-rose-400/80"/>
    <span class="h-2.5 w-2.5 rounded-full bg-amber-400/80"/>
    <span class="h-2.5 w-2.5 rounded-full bg-emerald-400/80"/>
  </div>
  <pre class="px-6 py-5 text-slate-300">
    <span class="text-emerald-400">✓</span> build ok
    <span class="text-amber-400">https://example.com</span>
  </pre>
</div>
```

**例外原则**：终端 mock 内部**保留真实终端语义色**（emerald=成功、amber=URL、rose=错误信号灯）。这是与"印刷品"原则的明确切割点——代码块要有真实感，不能为了统一而变成全墨。

---

## 5. 排版节奏

```
h1: text-5xl sm:text-7xl font-bold tracking-tight leading-[1.05]
h2: text-4xl sm:text-5xl font-bold tracking-tight leading-[1.1]
h3: text-xl font-semibold tracking-tight text-ink
lede: mt-6 max-w-2xl text-lg text-slate-700
body: text-base text-slate-700
caption: text-sm text-ink-mute
eyebrow: text-sm font-semibold tracking-wider uppercase text-brand-600
```

**章节大间距**：
- `py-24 sm:py-32`：标准 section 上下间距
- `pt-32 pb-20 sm:pt-40 sm:pb-28`：Hero 首屏
- `mt-16` 或 `mt-20`：eyebrow/h2 与主内容网格之间的距离

---

## 6. 深色模式策略

**只用 class 策略**，不用 `prefers-color-scheme`（用户偏好要可覆盖）。

```
浅色                深色
─────────────────   ─────────────────
bg-paper            bg-paper-dark       # 暖墨 #0f100e，不是 slate-950
bg-paper-deep       bg-paper-deep-dark  # 暖墨 #161814
bg-rule             bg-rule-dark
text-ink            text-paper          # #e8e6df
text-slate-700      text-paper          # 统一浅色文字
text-slate-500      text-ink-mute 或更暗
```

**关键**：深色模式下也要保持"印刷品暗页"的隐喻——`#0f100e` 比 `slate-950 (#020617)` 暖得多，避免"科技感冷调"。

`BaseLayout.astro` 头部 inline script 在主题初始化前闪烁保护（FOUC-free），见对应文件。

---

## 7. 交互约定

| 元素 | hover 行为 |
|---|---|
| Button | `hover:bg-ink-soft`（或 `hover:bg-slate-50` 对次按钮）；`transition-colors` |
| Card | `hover:ring-slate-300 hover:shadow-xl hover:shadow-slate-900/5` |
| Link | `hover:text-brand-600`；`transition-colors` |
| IconButton (header 主题切换) | `hover:bg-slate-100`（深色 `hover:bg-slate-800`） |

全局 `transition` 已在 `BaseLayout` 中默认接管 link（不要单独再加）。

---

## 8. 命名与工具类约定

### 8.1 槽位保留策略

`brand-*` 和 `accent-*` 槽位名**刻意保留**，即使本项目不再用纯紫罗兰，文件里仍是 `bg-brand-700` / `text-brand-600`。

原因：
- 替换 token 颜色 = 全站自动生效，无需扫组件
- 槽位语义稳定（brand = 主色、accent = 辅色），未来换色板只需改 `global.css` 一处
- **绝不允许**在组件里直接写 `#114e34` 或 `bg-emerald-700` 绕过 token

### 8.2 渐变使用守则

```
✓ Hero 标题字：brand-700 → brand-500 → brand-700   (低饱和、文字专用)
✓ Hero 顶部：hero-glow radial 暖晕
✗ 卡片背景渐变
✗ 按钮背景渐变
✗ 图标背景渐变
✗ 任何包含 violet/fuchsia/indigo/pink 的渐变
```

### 8.3 emoji 与图标

- 业务图标（Features、Header CTA）用内联 SVG，**统一墨底**
- 不在产品文案中使用 emoji（"🚀 Built with..."）——回到 SaaS 模板的路标
- 终端/产品 mock 内部真实符号保留（→、✓、$、curl）

---

## 9. 演进守则

### 9.1 新增 Section 的 checklist

1. **能不能复用现有 section 模板**？（eyebrow + h2 + lede + grid）
2. token 是否够用？不够时先扩展 `@theme`，**不绕过**
3. 是否引入了品牌色渐变 / 彩虹图标 / 紫色辉光？→ **删除**
4. 深色模式看起来还是"杂志暗页"而不是"科技冷调"吗？
5. 文字三档（ink / slate-700 / mute）是否清晰？

### 9.2 改动要重审本文档

任何破坏以下任一规则的改动，都需要同时更新本文件 §0 / §8：

- [ ] 没有引入 `violet` / `fuchsia` / `indigo` / `pink` 色板
- [ ] 没有用 `slate-900` / `slate-950` 作底色
- [ ] 没有给图标加渐变背景
- [ ] 没有给卡片加 mesh / 玻璃 / 噪点
- [ ] 没有给按钮加品牌色实色

### 9.3 何时该重新审视设计系统

- 同时出现 3 个以上 section 需要用同一种 token 但目前没有
- 新增的 section 与现有节奏明显冲突
- 整站要换主色（如换到墨蓝或赭红）——只需改 `global.css` §1.1
- 整站要换字体（如切到衬线印刷品）——改 `@theme` 的 `--font-sans` 与 §5 节奏

---

## 附录 A：文件清单

| 文件 | 承担的设计职责 |
|---|---|
| `src/styles/global.css` | **所有 token 的唯一来源**；新增 token 必先改这里 |
| `src/layouts/BaseLayout.astro` | 主题切换 inline script；link 全局 transition |
| `src/components/Header.astro` | 顶栏 + 主题切换 + Logo（ink 实色） |
| `src/components/Hero.astro` | 唯一允许品牌渐变字 + hero-glow 暖晕的位置 |
| `src/components/LogoCloud.astro` | wordmark 信任行；`text-ink-mute/60` |
| `src/components/Features.astro` | 6 卡片网格；IconBlock 墨底纸字 |
| `src/components/Showcase.astro` | 终端 mock + 文案；**终端内保留真实终端色** |
| `src/components/Stats.astro` | 唯一允许 bg-ink 大块的位置 |
| `src/components/Testimonials.astro` | 3 列；Avatar 墨底 |
| `src/components/Pricing.astro` | 3 档；推荐卡 bg-brand-50 |
| `src/components/Faq.astro` | `<details>` 折叠；左侧细 border-brand-500 |
| `src/components/Cta.astro` | 唯一允许纯色大块 brand-700 背景 |
| `src/components/Footer.astro` | 4 列链接 + Logo ink 实色 |
| `src/pages/index.astro` | section 顺序组装 |

## 附录 B：与默认 AI 模板对比

| 维度 | 默认模板（重构前） | 现在 |
|---|---|---|
| 主色 | `#6366f1`（indigo-500） | `#1f7d52`（森林绿 500） |
| 辅色 | `#d946ef`（fuchsia-500） | `#a88548`（卡其 500） |
| 背景 | `#ffffff` / `#020617` | `#f7f5ef` / `#0f100e`（双暖） |
| 图标 | 6 色彩虹渐变背景 | 统一墨底 |
| 卡片 | 玻璃 + 渐变描边 | 暖灰 ring + 阴影 |
| Hero 标题字 | 5 色彩虹渐变 | 森林绿单色渐变 |
| Stats | slate-900 + 网格 | 纯墨实色 |
| CTA | 紫/粉/橙三色渐变 | 森林绿 700 实色 |
| 阴影 | `shadow-violet-500/30` | `shadow-slate-900/5` |

> 每一个差异背后都对应 §0 中的"印刷品"立场——不是审美选择，是语义选择。