import { useEffect, useState } from "react";

/** 移动端断点（含）以下视为手机。与各页响应式切换保持一致。 */
export const MOBILE_BREAKPOINT = 768;

/**
 * 响应式断点 hook：视口宽度 <= MOBILE_BREAKPOINT 时返回 true。
 * 用 matchMedia 监听，旋转 / 缩放窗口即时生效。一套断点供导航、表格、统计卡复用。
 */
export function useIsMobile(breakpoint = MOBILE_BREAKPOINT): boolean {
  const query = `(max-width: ${breakpoint}px)`;
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches,
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mql = window.matchMedia(query);
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    setIsMobile(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return isMobile;
}
