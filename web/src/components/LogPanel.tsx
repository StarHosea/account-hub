import { useEffect, useRef } from "react";
import { SideSheet, Button, Badge, Typography, Empty } from "@douyinfe/semi-ui-19";
import { IconBell, IconDelete } from "@douyinfe/semi-icons";

import { useLogStore, type LogLevel } from "@/store/logs";

const { Text } = Typography;

const LEVEL_COLOR: Record<LogLevel, string> = {
  info: "var(--semi-color-text-2)",
  success: "var(--semi-color-success)",
  error: "var(--semi-color-danger)",
};

function fmtTime(ts: number) {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 顶栏触发按钮：带未读错误红点。 */
export function LogButton() {
  const unread = useLogStore((s) => s.unreadErrors);
  const setOpen = useLogStore((s) => s.setOpen);
  return (
    <Badge count={unread > 0 ? unread : undefined} type="danger" overflowCount={99}>
      <Button
        theme="borderless"
        type="tertiary"
        icon={<IconBell />}
        onClick={() => setOpen(true)}
        aria-label="运行日志"
      >
        日志
      </Button>
    </Badge>
  );
}

/** 侧边运行日志面板：展示所有逆向流程的步骤与错误。 */
export function LogPanel() {
  const entries = useLogStore((s) => s.entries);
  const open = useLogStore((s) => s.open);
  const setOpen = useLogStore((s) => s.setOpen);
  const clear = useLogStore((s) => s.clear);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  // 新日志到达且面板打开时自动滚到底。
  useEffect(() => {
    if (open) bottomRef.current?.scrollIntoView({ block: "end" });
  }, [entries.length, open]);

  return (
    <SideSheet
      title="运行日志"
      visible={open}
      onCancel={() => setOpen(false)}
      width="min(680px, 92vw)"
      mask={false}
      footer={
        <Button icon={<IconDelete />} type="tertiary" disabled={!entries.length} onClick={clear}>
          清空
        </Button>
      }
    >
      {entries.length === 0 ? (
        <Empty description="暂无日志。执行开/关 2FA、刷新校验等操作后，过程会实时显示在这里。" style={{ paddingTop: 60 }} />
      ) : (
        <div style={{ fontFamily: "var(--semi-font-mono, monospace)", fontSize: 12, lineHeight: 1.6 }}>
          {entries.map((e) => (
            <div key={e.id} style={{ padding: "4px 0", borderBottom: "1px solid var(--semi-color-fill-0)" }}>
              {/* 第一行：时间 + scope（账号定位），不与消息抢宽度 */}
              <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                <Text type="quaternary" style={{ flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>
                  {fmtTime(e.ts)}
                </Text>
                <span style={{ color: "var(--semi-color-text-2)", wordBreak: "break-all" }}>[{e.scope}]</span>
              </div>
              {/* 第二行：消息整行铺满，正常换行不再逐字断 */}
              <div
                style={{
                  marginLeft: 4,
                  color: LEVEL_COLOR[e.level],
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
              >
                {e.message}
              </div>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      )}
    </SideSheet>
  );
}
