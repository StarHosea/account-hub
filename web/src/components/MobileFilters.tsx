import { useState, type ReactNode } from "react";
import { Button, SideSheet, Typography } from "@douyinfe/semi-ui-19";
import { IconSearch } from "@douyinfe/semi-icons";

const { Text } = Typography;

/**
 * 手机端筛选入口：把搜索框 / 下拉筛选折叠进一个按钮，点击从右侧划出抽屉。
 * activeCount 显示当前生效的筛选条件数量（含搜索词）。children 为各页的筛选控件，
 * 在抽屉内纵向铺满展示。
 */
export function MobileFilters({ activeCount = 0, children }: { activeCount?: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button icon={<IconSearch />} onClick={() => setOpen(true)} block style={{ marginBottom: 12 }}>
        搜索 / 筛选{activeCount ? `（${activeCount}）` : ""}
      </Button>
      <SideSheet
        title="搜索 / 筛选"
        visible={open}
        onCancel={() => setOpen(false)}
        placement="right"
        width="82%"
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {children}
          <Button theme="solid" type="primary" block onClick={() => setOpen(false)}>
            查看结果
          </Button>
          <Text type="tertiary" size="small" style={{ textAlign: "center" }}>
            条件即时生效，关闭后查看列表
          </Text>
        </div>
      </SideSheet>
    </>
  );
}
