# Marketing Landing Page

一个使用 **Astro 5** + **Tailwind CSS 4** 构建的现代简洁营销落地页，作为 andi-agent 项目的能力演示。

## 技术栈

- [Astro](https://astro.build) 5+ —— 零默认 JavaScript 的静态站点框架
- [Tailwind CSS](https://tailwindcss.com) 4 —— 通过 `@tailwindcss/vite` 插件接入，CSS-first 配置
- 内联 SVG 图标 —— 零运行时依赖
- Inter 字体 —— 通过 Google Fonts 加载

## 设计原则

- **现代简洁**：克制使用阴影 / 渐变 / 玻璃质感
- **暗色优先**：默认浅色，通过 `class="dark"` 切换深色主题
- **响应式**：移动端优先，桌面端扩展
- **性能优先**：极少的客户端 JS，仅 FAQ 与主题切换有内联脚本

## 页面结构

| 区块 | 描述 |
|------|------|
| Header | 固定顶部导航 + 主题切换按钮 + 主题 CTA |
| Hero | 主标语 + 双 CTA + 产品预览 |
| LogoCloud | 客户信任标识 |
| Features | 6 个特性卡片 |
| Showcase | 代码/终端 mock + 功能要点 |
| Stats | 4 个数据指标（深色卡片） |
| Testimonials | 3 条客户证言 |
| Pricing | 3 档定价（中间高亮） |
| FAQ | 6 条问答，原生 `<details>` 折叠 |
| CTA | 全宽渐变号召区 |
| Footer | 多列链接 + 社交 + 版权 |

## 快速开始

```bash
# 进入项目目录
cd docs/marketing-landing-page

# 安装依赖
bun install
# 或 npm install / pnpm install

# 启动开发服务器（默认 http://localhost:4321）
bun run dev

# 构建生产版本
bun run build

# 预览生产版本
bun run preview
```

## Tailwind 4 使用要点

本项目采用 Tailwind 4 的 **CSS-first 配置**，通过 `@theme` 指令在 `src/styles/global.css` 中定义设计令牌：

```css
@import "tailwindcss";

@theme {
  --font-sans: "Inter", ...;
  --color-brand-500: #6366f1;
  --color-accent-500: #d946ef;
}

@utility bg-grid {
  background-image: ...;
}
```

并通过 `@utility` 指令注册自定义工具类（如 `bg-grid`、`hero-glow`、`container-narrow`）。

## 文件结构

```
marketing-landing-page/
├── astro.config.mjs         # Astro + Tailwind 插件
├── package.json
├── tsconfig.json
├── public/
│   └── favicon.svg
└── src/
    ├── styles/global.css    # Tailwind 4 主题与工具类
    ├── layouts/BaseLayout.astro
    ├── components/          # 11 个 section 组件
    └── pages/index.astro    # 主页组装
```