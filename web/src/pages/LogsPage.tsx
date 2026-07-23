import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Popconfirm, Space, Toast, Typography } from "@douyinfe/semi-ui-19";
import { IconDelete, IconRefresh } from "@douyinfe/semi-icons";

import { clearOperationLogs, fetchOperationLogs, type OperationLog } from "@/lib/api";

const { Text } = Typography;

const POLL_MS = 2500;
const LIMIT = 500;
const BOTTOM_THRESHOLD_PX = 48;

function formatDetail(detail: OperationLog["detail"]): string {
  if (!detail || typeof detail !== "object") return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(detail)) {
    if (value == null || value === "") continue;
    if (typeof value === "object") {
      try {
        parts.push(`${key}=${JSON.stringify(value)}`);
      } catch {
        parts.push(`${key}=${String(value)}`);
      }
    } else {
      parts.push(`${key}=${String(value)}`);
    }
  }
  return parts.join(" ");
}

function formatLogLine(item: OperationLog): string {
  const detail = formatDetail(item.detail);
  const base = `[${item.time || "—"}] [${item.type || "—"}] ${item.summary || ""}`.trimEnd();
  return detail ? `${base}  ${detail}` : base;
}

export default function LogsPage() {
  const [items, setItems] = useState<OperationLog[]>([]);
  const [paused, setPaused] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stickBottom, setStickBottom] = useState(true);
  const preRef = useRef<HTMLPreElement | null>(null);
  const knownIdsRef = useRef<Set<string>>(new Set());

  const scrollToBottom = useCallback(() => {
    const el = preRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, []);

  const mergeItems = useCallback((incoming: OperationLog[]) => {
    // API returns newest-first; render oldest→newest for console feel.
    const chronological = [...incoming].reverse();
    setItems((prev) => {
      if (!prev.length) {
        knownIdsRef.current = new Set(chronological.map((x) => x.id));
        return chronological;
      }
      const next = [...prev];
      let added = false;
      for (const item of chronological) {
        if (!item?.id || knownIdsRef.current.has(item.id)) continue;
        knownIdsRef.current.add(item.id);
        next.push(item);
        added = true;
      }
      // Keep window bounded to latest LIMIT by id presence from server snapshot.
      const serverIds = new Set(incoming.map((x) => x.id));
      const trimmed = next.filter((x) => serverIds.has(x.id));
      if (!added && trimmed.length === prev.length) return prev;
      knownIdsRef.current = new Set(trimmed.map((x) => x.id));
      return trimmed;
    });
  }, []);

  const load = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!opts?.silent) setLoading(true);
      try {
        const data = await fetchOperationLogs({ limit: LIMIT });
        mergeItems(data.items || []);
      } catch (e) {
        if (!opts?.silent) {
          Toast.error(e instanceof Error ? e.message : "加载操作日志失败");
        }
      } finally {
        if (!opts?.silent) setLoading(false);
      }
    },
    [mergeItems],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (paused) return;
    const timer = window.setInterval(() => {
      void load({ silent: true });
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [paused, load]);

  useEffect(() => {
    if (stickBottom) scrollToBottom();
  }, [items, stickBottom, scrollToBottom]);

  const onScroll = () => {
    const el = preRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    setStickBottom(distance <= BOTTOM_THRESHOLD_PX);
  };

  const handleClear = async () => {
    setBusy(true);
    try {
      const r = await clearOperationLogs();
      knownIdsRef.current = new Set();
      setItems([]);
      Toast.success(`已清空 ${r.removed} 条日志`);
    } catch (e) {
      Toast.error(e instanceof Error ? e.message : "清空失败");
    } finally {
      setBusy(false);
    }
  };

  const text = items.length ? items.map(formatLogLine).join("\n") : "暂无操作日志";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, height: "100%", minHeight: 0 }}>
      <Space wrap>
        <Button onClick={() => setPaused((v) => !v)}>{paused ? "继续" : "暂停"}</Button>
        <Button icon={<IconRefresh />} onClick={() => void load()} loading={loading}>
          刷新
        </Button>
        {!stickBottom ? (
          <Button
            onClick={() => {
              setStickBottom(true);
              scrollToBottom();
            }}
          >
            回到底部
          </Button>
        ) : null}
        <Popconfirm title="清空全部操作日志？" onConfirm={() => void handleClear()}>
          <Button type="danger" theme="light" icon={<IconDelete />} loading={busy}>
            一键清空
          </Button>
        </Popconfirm>
        <Text type="tertiary" size="small">
          {paused ? "已暂停轮询" : `每 ${POLL_MS / 1000}s 自动刷新`} · {items.length} 条
        </Text>
      </Space>

      <pre
        ref={preRef}
        onScroll={onScroll}
        style={{
          flex: 1,
          minHeight: 360,
          margin: 0,
          padding: 12,
          overflow: "auto",
          borderRadius: 8,
          border: "1px solid var(--semi-color-border)",
          background: "var(--semi-color-fill-0)",
          color: "var(--semi-color-text-0)",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
          fontSize: 12,
          lineHeight: 1.55,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {text}
      </pre>
    </div>
  );
}
