/**
 * 轻量 Markdown 渲染（PR 正文 / 评审评论用）与按文件切分 unified diff。
 *
 * 只保留面板真正需要的两个函数：前身项目里的 commit/issues 渲染器已经删掉。
 * 渲染全部走 React 元素（不用 innerHTML），链接/图片在白名单里校验协议，
 * 挡住 `javascript:` / `file:` 这类注入面。
 */
export declare function splitDiffByFile(patch: string): Array<{
    path: string;
    text: string;
    additions: number;
    deletions: number;
}>;
export declare function renderMarkdownLite(h: any, source: string): any[];
