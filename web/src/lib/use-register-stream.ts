import { useEffect, useRef } from "react";

import { useSettingsStore } from "@/store/settings";
import { getStoredAuthKey } from "@/store/auth";
import webConfig from "@/constants/common-env";

/**
 * 全局订阅注册机 SSE（/api/register/events）：
 * 把整份配置写回 store（设置页 / 号池管理控制条读它）。
 * 在 AppLayout 挂一次即可，与具体页面解耦。
 */
export function useRegisterStream() {
  const loadRegister = useSettingsStore((s) => s.loadRegister);
  const setRegisterConfig = useSettingsStore((s) => s.setRegisterConfig);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    void loadRegister();
    let closed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = (key: string) => {
      if (closed) return;
      const base = webConfig.apiUrl.replace(/\/$/, "");
      const es = new EventSource(`${base}/api/register/events?token=${encodeURIComponent(key)}`);
      esRef.current = es;
      es.onmessage = (ev) => {
        try {
          setRegisterConfig(JSON.parse(ev.data));
        } catch {
          /* ignore malformed payload */
        }
      };
      es.onerror = () => {
        es.close();
        esRef.current = null;
        if (closed) return;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => connect(key), 3000);
      };
    };

    void getStoredAuthKey().then((key) => {
      if (!key || closed) return;
      connect(key);
    });

    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      esRef.current?.close();
      esRef.current = null;
    };
  }, [loadRegister, setRegisterConfig]);
}
