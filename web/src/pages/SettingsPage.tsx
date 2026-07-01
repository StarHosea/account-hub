import { useEffect, useRef, useState } from "react";
import { Card, Button, Input, InputNumber, Switch, Toast, Typography, Space, Spin } from "@douyinfe/semi-ui-19";
import { IconSave } from "@douyinfe/semi-icons";

import { useSettingsStore } from "@/store/settings";
import { useIsMobile } from "@/lib/use-is-mobile";
import RegisterConfigCard from "@/components/RegisterConfigCard";

const { Title, Text } = Typography;

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <Text style={{ display: "block", marginBottom: 6 }}>{label}</Text>
      {children}
    </div>
  );
}

export default function SettingsPage() {
  const isMobile = useIsMobile();
  const config = useSettingsStore((s) => s.config);
  const activation = useSettingsStore((s) => s.activationConfig);
  const loadConfig = useSettingsStore((s) => s.loadConfig);
  const loadActivation = useSettingsStore((s) => s.loadActivationConfig);
  const saveConfig = useSettingsStore((s) => s.saveConfig);
  const setProxy = useSettingsStore((s) => s.setProxy);
  const setRefreshInterval = useSettingsStore((s) => s.setRefreshAccountIntervalMinute);
  const setAutoRelogin = useSettingsStore((s) => s.setAutoReloginAfterRefresh);
  const setActField = useSettingsStore((s) => s.setActivationConfigField);
  const setActAuto = useSettingsStore((s) => s.setActivationAutoActivate);
  const saveActivation = useSettingsStore((s) => s.saveActivationConfig);

  const [savingBase, setSavingBase] = useState(false);
  const [savingAct, setSavingAct] = useState(false);
  const didLoad = useRef(false);

  useEffect(() => {
    if (didLoad.current) return;
    didLoad.current = true;
    void loadConfig();
    void loadActivation();
  }, [loadConfig, loadActivation]);

  const handleSaveBase = async () => {
    setSavingBase(true);
    try {
      await saveConfig();
      Toast.success("基础设置已保存");
    } catch (e) {
      Toast.error(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSavingBase(false);
    }
  };

  const handleSaveAct = async () => {
    setSavingAct(true);
    try {
      await saveActivation();
      Toast.success("激活配置已保存");
    } catch (e) {
      Toast.error(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSavingAct(false);
    }
  };

  return (
    <div style={{ maxWidth: 880 }}>
      <Title heading={3} style={{ marginBottom: 16 }}>
        设置
      </Title>

      {/* 基础设置 */}
      <Card
        title="基础设置"
        style={{ marginBottom: 16 }}
        headerExtraContent={
          <Button icon={<IconSave />} theme="solid" type="primary" size="small" onClick={() => void handleSaveBase()} loading={savingBase} disabled={!config}>
            保存
          </Button>
        }
      >
        {!config ? (
          <Spin />
        ) : (
          <>
            <Row label="全局代理">
              <Input value={config.proxy ?? ""} onChange={setProxy} placeholder="http://127.0.0.1:7890" />
            </Row>
            <Row label="账号刷新间隔（分钟）">
              <InputNumber
                min={0}
                value={Number(config.refresh_account_interval_minute) || 0}
                onChange={(v) => setRefreshInterval(String(v ?? 0))}
                style={{ width: isMobile ? "100%" : 200 }}
              />
            </Row>
            <Space>
              <Switch size="small" checked={!!config.auto_relogin_after_refresh} onChange={setAutoRelogin} />
              <Text>刷新后自动重登恢复异常账号</Text>
            </Space>
          </>
        )}
      </Card>

      {/* 激活配置 */}
      <Card
        title="Plus 激活配置"
        headerExtraContent={
          <Button icon={<IconSave />} theme="solid" type="primary" size="small" onClick={() => void handleSaveAct()} loading={savingAct} disabled={!activation}>
            保存
          </Button>
        }
      >
        {!activation ? (
          <Spin />
        ) : (
          <>
            <Row label={`CDK API Key${activation.has_api_key ? "（已配置，可留空不改）" : ""}`}>
              <Input
                mode="password"
                value={activation.api_key ?? ""}
                onChange={(v) => setActField("api_key", v)}
                placeholder={activation.has_api_key ? "••••••（已配置）" : "填写 CDK 兑换 API Key"}
              />
            </Row>
            <Row label="CDK API 地址">
              <Input value={activation.base_url ?? ""} onChange={(v) => setActField("base_url", v)} />
            </Row>
            <Row label="激活并发数">
              <InputNumber min={1} max={10} value={activation.concurrency} onChange={(v) => setActField("concurrency", String(v ?? 1))} style={{ width: isMobile ? "100%" : 200 }} />
            </Row>
            <Space>
              <Switch size="small" checked={!!activation.auto_activate_after_register} onChange={setActAuto} />
              <Text>注册成功后自动激活</Text>
            </Space>
          </>
        )}
      </Card>

      {/* 注册机配置（注册参数 + 区域 + 代理 + 号一号一 IP + 2FA + 邮箱） */}
      <div style={{ marginTop: 16 }}>
        <RegisterConfigCard />
      </div>
    </div>
  );
}
