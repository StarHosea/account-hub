import { Card, Button, InputNumber, Typography, Space, Tag } from "@douyinfe/semi-ui-19";
import { IconPlay, IconStop } from "@douyinfe/semi-icons";

import { useSettingsStore } from "@/store/settings";

const { Text } = Typography;

/**
 * 注册机「启动控制 + 运行统计」。原在独立注册机页，现内嵌到号池管理顶部。
 * 配置在「设置 → 注册配置」，日志在右上角「日志」侧边面板（scope 注册机）。
 */
export default function RegisterControl() {
  const config = useSettingsStore((s) => s.registerConfig);
  const isSaving = useSettingsStore((s) => s.isSavingRegister);
  const setTotal = useSettingsStore((s) => s.setRegisterTotal);
  const toggle = useSettingsStore((s) => s.toggleRegister);

  if (!config) return null;

  const running = config.enabled;
  const stats = config.stats || { success: 0, fail: 0, done: 0, running: 0, threads: config.threads, success_rate: 0 };

  return (
    <Card style={{ marginBottom: 16 }} bodyStyle={{ padding: "12px 16px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
        <Space spacing="loose" align="center" wrap>
          <Text strong>注册机</Text>
          <Tag color={running ? "amber" : "grey"} type="light">
            {running ? "运行中" : "已停止"}
          </Tag>
          <Space align="center" spacing={6}>
            <Text type="tertiary">目标</Text>
            <InputNumber
              min={1}
              value={config.total}
              onChange={(v) => setTotal(String(v ?? 1))}
              disabled={running}
              style={{ width: 96 }}
            />
          </Space>
          <Text type="success">成功 <b>{stats.success}</b></Text>
          <Text type="danger">失败 <b>{stats.fail}</b></Text>
          <Text>完成 <b>{stats.done}</b></Text>
          <Text type="tertiary">运行/线程 {stats.running}/{stats.threads}</Text>
        </Space>
        {running ? (
          <Button theme="solid" type="danger" icon={<IconStop />} onClick={() => void toggle()} loading={isSaving}>
            停止
          </Button>
        ) : (
          <Button theme="solid" type="primary" icon={<IconPlay />} onClick={() => void toggle()} loading={isSaving}>
            启动注册
          </Button>
        )}
      </div>
    </Card>
  );
}
