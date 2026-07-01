import { useEffect, useState } from "react";

/** 返回 value 的防抖副本，输入停止 delay 毫秒后才更新。用于搜索框节流请求。 */
export function useDebouncedValue<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}
