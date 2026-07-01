import type { ReactNode } from "react";
import { Card, Typography } from "@douyinfe/semi-ui-19";

const { Text } = Typography;

export type StatItem = { label: string; value: ReactNode; color?: string };

/**
 * 统一的统计卡网格。
 * - 手机端：紧凑、标题与数值「水平」排布（标题在左、数值在右），每行两张，省空间。
 * - PC 端：常规竖排卡片，自适应换行。
 */
export function StatCards({ items, mobile = false }: { items: StatItem[]; mobile?: boolean }) {
  if (mobile) {
    return (
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8, marginBottom: 12 }}>
        {items.map((c) => (
          <Card key={c.label} bodyStyle={{ padding: "7px 10px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <Text type="tertiary" ellipsis={{ showTooltip: true }} style={{ fontSize: 11, flex: 1 }}>
                {c.label}
              </Text>
              <span style={{ fontSize: 16, fontWeight: 600, color: c.color, flexShrink: 0 }}>{c.value}</span>
            </div>
          </Card>
        ))}
      </div>
    );
  }

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
        gap: 12,
        marginBottom: 16,
      }}
    >
      {items.map((c) => (
        <Card key={c.label} bodyStyle={{ padding: 16 }}>
          <Text type="tertiary" style={{ fontSize: 12 }}>
            {c.label}
          </Text>
          <div style={{ fontSize: 22, fontWeight: 600, color: c.color, marginTop: 4, lineHeight: 1.2 }}>
            {c.value}
          </div>
        </Card>
      ))}
    </div>
  );
}
