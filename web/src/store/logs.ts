import { create } from "zustand";

// 全局运行日志：所有「GPT 逆向」流程（开/关 2FA、刷新校验、重登等）把每一步与错误打到这里，
// 通过顶栏的「日志」侧边面板查看，方便快速定位卡在哪一步、报了什么错。

export type LogLevel = "info" | "success" | "error";

export interface LogEntry {
  id: number;
  ts: number; // epoch ms
  level: LogLevel;
  scope: string; // 例如「开启2FA · xxx@icloud.com」
  message: string;
}

interface LogState {
  entries: LogEntry[];
  open: boolean;
  unreadErrors: number; // 面板关闭时累计的错误数，用于顶栏红点
  push: (level: LogLevel, scope: string, message: string) => void;
  clear: () => void;
  setOpen: (open: boolean) => void;
}

const MAX_ENTRIES = 500;
let seq = 0;

export const useLogStore = create<LogState>((set) => ({
  entries: [],
  open: false,
  unreadErrors: 0,
  push: (level, scope, message) =>
    set((s) => {
      const entry: LogEntry = { id: ++seq, ts: Date.now(), level, scope, message };
      const entries = [...s.entries, entry];
      if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
      const unreadErrors = s.open || level !== "error" ? s.unreadErrors : s.unreadErrors + 1;
      return { entries, unreadErrors };
    }),
  clear: () => set({ entries: [], unreadErrors: 0 }),
  setOpen: (open) => set((s) => ({ open, unreadErrors: open ? 0 : s.unreadErrors })),
}));

// 模块级便捷 logger：组件外（poll 循环、工具函数）也能直接调用。
export const log = {
  info: (scope: string, message: string) => useLogStore.getState().push("info", scope, message),
  success: (scope: string, message: string) => useLogStore.getState().push("success", scope, message),
  error: (scope: string, message: string) => useLogStore.getState().push("error", scope, message),
};
