# 阶段十三：Marketing Landing Page (Astro + Tailwind CSS 4)

## 状态
已完成。

## 目标
在 `docs/marketing-landing-page/` 中搭建一个现代简洁的营销落地页，验证 Agent 的全栈项目脚手架能力。

## 技术栈
- **框架**：Astro 5+（零 JS 默认输出）
- **样式**：Tailwind CSS 4（通过 `@tailwindcss/vite` 插件接入，CSS-first 配置）
- **字体**：Inter（Google Fonts）
- **图标**：内联 SVG（避免依赖）

## 设计原则
- 现代简洁：克制使用阴影 / 渐变 / 玻璃质感
- 暗色优先：以 `dark:` 类为主，浅色作为 fallback
- 响应式：移动端优先，桌面端扩展
- 性能优先：极少的客户端 JS，仅必要交互（如 FAQ 折叠）使用内联脚本

## 页面结构
1. **Header** — 固定导航：Logo + 菜单 + CTA
2. **Hero** — 主标语 + 副标语 + 双 CTA + 渐变光晕背景
3. **Logo Cloud** — "受客户信任" 6 个客户 logo（文字版）
4. **Features** — 3×2 特性网格 + 渐变 icon 容器
5. **Showcase** — 代码 / 终端截图区 + 文字说明
6. **Stats** — 4 个数字指标
7. **Testimonials** — 3 个客户证言卡片
8. **Pricing** — 3 档定价（基础 / 专业 / 企业），中间高亮
9. **FAQ** — 6 个问答，原生 `<details>` 折叠
10. **Final CTA** — 全宽号召区
11. **Footer** — 多列链接 + 社交 + 版权

## 文件清单
```
docs/marketing-landing-page/
├── package.json
├── astro.config.mjs
├── tsconfig.json
├── README.md
├── public/
│   └── favicon.svg
├── src/
│   ├── styles/
│   │   └── global.css          # @import "tailwindcss" + @theme 自定义
│   ├── layouts/
│   │   └── BaseLayout.astro    # HTML 框架、字体、meta、主题脚本
│   ├── components/
│   │   ├── Header.astro
│   │   ├── Hero.astro
│   │   ├── LogoCloud.astro
│   │   ├── Features.astro
│   │   ├── Showcase.astro
│   │   ├── Stats.astro
│   │   ├── Testimonials.astro
│   │   ├── Pricing.astro
│   │   ├── Faq.astro
│   │   ├── Cta.astro
│   │   └── Footer.astro
│   └── pages/
│       └── index.astro         # 组装所有 section
```

## 验证
- `bun install` 安装依赖
- `bun run build` 成功构建
- `bun run preview` 启动并 curl 主页验证 HTML 包含核心文案
- `git diff --check` 通过

## 验证结果

- `bun run build`：成功，生成 `dist/index.html`（51KB）+ 压缩后的 `index.BTRGuHCs.css`
- `bunx tsc --noEmit`：通过，零类型错误
- `bun run preview`：HTTP 200，32ms 返回，`<title>Lumen — Ship faster with a modern workflow</title>` 正确
- HTML 内容关键词全部命中：Hero「交付出色的产品」、Pricing「简单透明」、FAQ「常见问题」、CTA「准备好加速」
- 项目整体零运行时 JS 依赖（仅 2 个内联脚本：暗色主题防闪烁、主题切换）

## 项目亮点

- **Tailwind 4 CSS-first 配置**：`@theme` 注入 brand/accent 色板与字体；`@utility` 注册 `bg-grid`、`hero-glow`、`container-narrow` 等自定义工具类
- **零外部图标库**：所有图标为内联 SVG，构建后无额外 HTTP 请求
- **设计语言统一**：渐变品牌色（indigo → violet → fuchsia），克制阴影与玻璃质感
- **暗色主题**：默认浅色，prefers-color-scheme 检测 + 手动切换 + localStorage 持久化，防闪烁内联脚本
- **原生交互**：FAQ 用 `<details>` 折叠（无 JS），主题切换用 4 行原生 JS
- **可访问性**：所有图标按钮带 `aria-label`，详情元素用 `<summary>`，色彩对比度达标
