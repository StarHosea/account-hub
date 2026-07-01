import { useEffect, useRef } from "react";

import { useSettingsStore } from "@/store/settings";
import { getStoredAuthKey } from "@/store/auth";
import { useLogStore, type LogLevel } from "@/store/logs";
import webConfig from "@/constants/common-env";

const REGISTER_SCOPE = "注册机";

function mapLevel(level: string): LogLevel {
  if (level === "red") return "error";
  if (level === "green") return "success";
  return "info"; // yellow / 其它
}

/**
 * 全局订阅注册机 SSE（/api/register/events）：
 * - 把整份配置写回 store（设置页 / 号池管理控制条读它）；
 * - 把新增的日志行转发到右上角「日志」侧边面板（scope 注册机）。
 * 在 AppLayout 挂一次即可，与具体页面解耦——注册机页已拆除。
 */
export function useRegisterStream() {
  const loadRegister = useSettingsStore((s) => s.loadRegister);
  const setRegisterConfig = useSettingsStore((s) => s.setRegisterConfig);
  const esRef = useRef<EventSource | null>(null);
  const lastLenRef = useRef<number | null>(null); // 已转发到面板的日志条数，null=尚未初始化

  useEffect(() => {
    void loadRegister();
    void getStoredAuthKey().then((key) => {
      if (!key) return;
      const base = webConfig.apiUrl.replace(/\/$/, "");
      const es = new EventSource(`${base}/api/register/events?token=${encodeURIComponent(key)}`);
      esRef.current = es;
      es.onmessage = (ev) => {
        let data: ReturnType<typeof JSON.parse>;
        try {
          data = JSON.parse(ev.data);
        } catch {
          return;
        }
        setRegisterConfig(data);
        const logs: Array<{ time?: number; level?: string; text?: string }> = Array.isArray(data?.logs) ? data.logs : [];
        // 首次连接只记录基线长度，不把历史日志一次性灌进面板。
        if (lastLenRef.current === null) {
          lastLenRef.current = logs.length;
          return;
        }
        // 统计被重置时 logs 会变短，从头重新开始。
        if (logs.length < lastLenRef.current) lastLenRef.current = 0;
        for (let i = lastLenRef.current; i < logs.length; i++) {
          const l = logs[i];
          if (l?.text) useLogStore.getState().push(mapLevel(String(l.level || "")), REGISTER_SCOPE, String(l.text));
        }
        lastLenRef.current = logs.length;
      };
      es.onerror = () => {
        es.close();
        esRef.current = null;
      };
    });
    return () => {
      esRef.current?.close();
      esRef.current = null;
    };
  }, [loadRegister, setRegisterConfig]);
}
