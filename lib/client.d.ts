declare global {
    interface Window {
        __ModuleLoader__: {
            load(options: {
                id: string;
                factory: (require: any) => any;
            }): void;
        };
    }
}
import { renderMarkdownLite, splitDiffByFile } from './ui/markdown-lite.js';
export { renderMarkdownLite, splitDiffByFile };
