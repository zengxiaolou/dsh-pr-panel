import type { CreatedPrRef } from './session-pr-tracker.js';
export interface CreatedPrScan {
    refs: CreatedPrRef[];
    transcript: string | null;
    reason?: string;
}
/** 按 sessionId 在全部工作区目录里定位转写文件（目录名被转义过，不可预测） */
export declare function findTranscript(sessionId: string): string | null;
/** 纯函数：从一份转写文本里扫出本会话新建的 PR（按出现顺序，去重保序） */
export declare function scanCreatedPrsFromTranscript(text: string): CreatedPrRef[];
/**
 * 读某个会话新建的 PR（带 mtime 缓存 + 并发去重）。
 *
 * 缓存键是转写文件的 mtime + size：文件没动就完全不打解压；文件在动（agent 正在写）
 * 时也不低于 MIN_RESCAN_MS 一次。同一份转写在多个轮询同时到达时只解压一次。
 *
 * 异步是硬要求：见 decompress() 的说明，同步 inflate 会按住 Host 事件循环。
 */
export declare function readSessionCreatedPrs(sessionId: string, opts?: {
    force?: boolean;
}): Promise<CreatedPrScan>;
