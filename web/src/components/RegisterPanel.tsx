import { Switch, Button, Typography, Space, Tag, Tooltip, Modal } from "@douyinfe/semi-ui-19";
import { IconSetting } from "@douyinfe/semi-icons";
import { useNavigate } from "react-router-dom";

import { useSettingsStore } from "@/store/settings";

const { Text } = Typography;

/**
 * 号池管理页头右上角的注册机入口：只做「启动/停止」+ 运行状态。
 * 全部注册参数（区域 / 代理 / 号一号一 IP / 2FA / 邮箱）已移至「设置」页的「注册配置」卡。
 */
export default function RegisterPanel() {
  const config = useSettingsStore((s) => s.registerConfig);
  const isSaving = useSettingsStore((s) => s.isSavingRegister);
  const toggle = useSettingsStore((s) => s.toggleRegister);
  const navigate = useNavigate();

  if (!config) return null;

  const running = config.enabled;
  const stats = config.stats || { success: 0, fail: 0, done: 0, running: 0, threads: config.threads };

  // 停止运行中的注册机需二次确认（会中断进行中的注册流程）；启动无需确认。
  const handleToggle = () => {
    if (running) {
      Modal.confirm({
        title: "确认停止注册机？",
        content: "将中断正在进行的注册流程",
        onOk: () => void toggle(),
      });
    } else {
      void toggle();
    }
  };

  return (
    <Space align="center" spacing={12}>
      <Space align="center" spacing={6}>
        <Text type="tertiary">注册机</Text>
        <Tag color={running ? "amber" : "grey"} type="light">
          {running ? "运行中" : "已停止"}
        </Tag>
        <Switch checked={running} loading={isSaving} onChange={handleToggle} aria-label="启动/停止注册机" />
      </Space>
      {(running || stats.done > 0) && (
        <Space align="center" spacing={10}>
          <Text type="success" size="small">成功 <b>{stats.success}</b></Text>
          <Text type="danger" size="small">失败 <b>{stats.fail}</b></Text>
          <Text type="tertiary" size="small">运行/线程 {stats.running}/{stats.threads}</Text>
        </Space>
      )}
      <Tooltip content="去「设置」页配置注册参数">
        <Button icon={<IconSetting />} size="small" theme="borderless" onClick={() => navigate("/settings")}>
          配置
        </Button>
      </Tooltip>
    </Space>
  );
}
