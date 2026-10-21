/**
 * Tailwind 配置：只做「构建期 CSS 生成」，不是运行时框架。
 *
 * 三个必须的设置：
 * 1. preflight: false —— Tailwind 的基础重置会污染 DSH 宿主全局样式，
 *    插件是往别人页面里注入 CSS，这条不能碰。
 * 2. darkMode: ['class', '[data-ds-dark-theme]'] —— 跟随 DSH 的主题切换方式。
 * 3. colors 全部映射到 --dsw-alias-* —— 主题 token 是唯一色源，不引入新品牌色；
 *    alpha 变体用 rgb(var(--x) / <alpha-value>) 不成立（token 是 hex），
 *    因此「半透明表面」统一走 rgba(255,255,255,a) / rgba(0,0,0,a) 的叠层。
 */
module.exports = {
  /*
   * content 里刻意包含 tw.src.css 自身：@layer components 里的类名同样会被
   * Tailwind 按 content 树摇，而过渡期标记还没全量换到 gh2-*，
   * 不加这一条整个组件层会被清空（实际踩过：产出 0 个 .gh2-* 规则）。
   */
  content: ['./src/ui/tw.src.css', './src/**/*.ts'],
  darkMode: ['class', '[data-ds-dark-theme]'],
  corePlugins: { preflight: false },
  theme: {
    extend: {
      colors: {
        /*
         * 全部指向面板级变量（--gh-c-*），由 tw.src.css 在 .gh2-panel 上按主题定义。
         * 关键点：这里不能写 var(token, 浅色fallback) —— token 缺失时暗色会用到
         * 浅色 fallback，正文直接变成深灰叠深底（实测 slug 几乎不可读）。
         */
        fg: {
          primary: 'var(--gh-c-fg)',
          secondary: 'var(--gh-c-fg2)',
          tertiary: 'var(--gh-c-fg3)',
        },
        line: {
          DEFAULT: 'var(--gh-c-line)',
          subtle: 'var(--gh-c-line)',
          strong: 'var(--gh-c-line-strong)',
        },
        accent: 'var(--gh-c-accent)',
        ok: 'var(--gh-c-ok)',
        bad: 'var(--gh-c-bad)',
        warn: 'var(--gh-c-warn)',
        busy: 'var(--gh-c-busy)',
      },
      borderRadius: {
        panel: '12px',
        block: '10px',
        row: '8px',
        chip: '6px',
      },
      fontSize: {
        slug: ['16px', { lineHeight: '22px', fontWeight: '600' }],
        row: ['13px', { lineHeight: '18px' }],
        sub: ['12px', { lineHeight: '16px' }],
        meta: ['11px', { lineHeight: '14px' }],
      },
      spacing: {
        1.5: '6px',
        4.5: '18px',
      },
    },
  },
  plugins: [],
};
