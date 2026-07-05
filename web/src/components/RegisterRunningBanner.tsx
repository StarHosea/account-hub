import { Button, Space, Tag, Typography } from "@douyinfe/semi-ui-19";
import { IconStop } from "@douyinfe/semi-icons";
import { useNavigate } from "react-router-dom";

import { useSettingsStore } from "@/store/settings";
import { NAV_LABELS } from "@/constants/nav";

const { Text } = Typography;

type Props = {
  /** 紧凑模式：顶栏用，只显示摘要 + 跳转 */
  compact?: boolean;
  onStop?: () => void;
  stopping?: boolean;
};

/**
 * 注册机运行中的全局提示条：让用户随时知道后台在跑、有几个浏览器、去哪看日志。
 */
export default function RegisterRunningBanner({ compact = false, onStop, stopping = false }: Props) {
  const config = useSettingsStore((s) => s.registerConfig);
  const navigate = useNavigate();

  if (!config?.enabled) return null;

  const stats = config.stats;
  const browsers = stats.active_browsers ?? 0;
  const running = stats.running ?? 0;

  if (compact) {
    return (
      <Tag
        color="amber"
        style={{ cursor: "pointer" }}
        onClick={() => navigate("/register")}
      >
        注册中 · 浏览器 {browsers} · 任务 {running}
      </Tag>
    );
  }

  return (
    <div
      style={{
        marginBottom: 16,
        padding: "12px 16px",
        borderRadius: 8,
        background: "var(--semi-color-warning-light-default)",
        border: "1px solid var(--semi-color-warning-light-active)",
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
      }}
    >
      <Space vertical align="start" spacing={4}>
        <Space align="center">
          <Tag color="amber">{NAV_LABELS.register}运行中</Tag>
          <Text strong>
            目标 {config.total} 个 · 已完成 {stats.done ?? 0} · 成功 {stats.success ?? 0} · 失败{" "}
            {stats.fail ?? 0}
          </Text>
        </Space>
        <Text type="secondary" size="small">
          当前 {running} 个任务进行中，{browsers} 个浏览器已打开。可在本页「运行监控」查看详细日志。
        </Text>
      </Space>
      {onStop ? (
        <Button theme="solid" type="danger" icon={<IconStop />} loading={stopping} onClick={onStop}>
          停止注册
        </Button>
      ) : null}
    </div>
  );
}
