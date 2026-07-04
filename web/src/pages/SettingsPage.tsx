import { useEffect, useRef, useState } from "react";
import { Card, Button, Input, InputNumber, Switch, Toast, Typography, Space, Spin } from "@douyinfe/semi-ui-19";
import { IconSave } from "@douyinfe/semi-icons";

import { useSettingsStore } from "@/store/settings";
import { useIsMobile } from "@/lib/use-is-mobile";
import { fetchTrialCheckConfig, updateTrialCheckConfig, type TrialCheckConfig } from "@/lib/api";
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
  const loadRegister = useSettingsStore((s) => s.loadRegister);
  const saveConfig = useSettingsStore((s) => s.saveConfig);
  const setProxy = useSettingsStore((s) => s.setProxy);
  const setRefreshInterval = useSettingsStore((s) => s.setRefreshAccountIntervalMinute);
  const setAutoRelogin = useSettingsStore((s) => s.setAutoReloginAfterRefresh);
  const setActField = useSettingsStore((s) => s.setActivationConfigField);
  const saveActivation = useSettingsStore((s) => s.saveActivationConfig);

  const [savingBase, setSavingBase] = useState(false);
  const [savingAct, setSavingAct] = useState(false);
  const didLoad = useRef(false);

  // 试用资格检测配置（独立端点，api_key 不回传，仅 has_api_key）。
  const [trial, setTrial] = useState<TrialCheckConfig | null>(null);
  const [trialKey, setTrialKey] = useState("");
  const [savingTrial, setSavingTrial] = useState(false);

  useEffect(() => {
    if (didLoad.current) return;
    didLoad.current = true;
    void loadConfig();
    void loadActivation();
    void loadRegister(true);
    void fetchTrialCheckConfig()
      .then((d) => setTrial(d.config))
      .catch(() => {});
  }, [loadConfig, loadActivation, loadRegister]);

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
      Toast.success("激活凭据已保存");
    } catch (e) {
      Toast.error(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSavingAct(false);
    }
  };

  const handleSaveTrial = async () => {
    if (!trial) return;
    setSavingTrial(true);
    try {
      const d = await updateTrialCheckConfig({
        enabled: trial.enabled,
        base_url: trial.base_url,
        ...(trialKey ? { api_key: trialKey } : {}),
      });
      setTrial(d.config);
      setTrialKey("");
      Toast.success("试用资格检测配置已保存");
    } catch (e) {
      Toast.error(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSavingTrial(false);
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
              <Input value={config.proxy ?? ""} onChange={setProxy} placeholder="留空则不使用代理，例：http://host:port" />
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

      {/* 注册配置（注册参数 + 区域 + 代理 + 2FA + 邮箱配置）——从注册机页移入 */}
      <RegisterConfigCard />

      {/* Plus 激活凭据（并发数/激活数量/自动激活 已移至「激活器」页） */}
      <Card
        title="Plus 激活凭据"
        style={{ marginBottom: 16 }}
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
            <Text type="tertiary" size="small">
              并发数、激活数量、注册成功后自动激活等运行参数请在「激活器」页设置。
            </Text>
          </>
        )}
      </Card>

      {/* 试用资格检测（注册成功后分流，Phase B 注册内核迁移后生效） */}
      <Card
        title="试用资格检测"
        headerExtraContent={
          <Button icon={<IconSave />} theme="solid" type="primary" size="small" onClick={() => void handleSaveTrial()} loading={savingTrial} disabled={!trial}>
            保存
          </Button>
        }
      >
        {!trial ? (
          <Spin />
        ) : (
          <>
            <Space style={{ marginBottom: 14 }}>
              <Switch size="small" checked={trial.enabled} onChange={(v) => setTrial({ ...trial, enabled: v })} />
              <Text>开启注册成功后试用资格校验（关闭时所有注册成功账号直接进入账号管理）</Text>
            </Space>
            <Row label={`检测 API Key${trial.has_api_key ? "（已配置，可留空不改）" : ""}`}>
              <Input
                mode="password"
                value={trialKey}
                onChange={setTrialKey}
                placeholder={trial.has_api_key ? "••••••（已配置）" : "填写试用资格检测 API Key"}
              />
            </Row>
            <Row label="检测 API 地址">
              <Input value={trial.base_url ?? ""} onChange={(v) => setTrial({ ...trial, base_url: v })} placeholder="例：https://trial.example.com" />
            </Row>
            <Text type="tertiary" size="small">
              无试用资格或注册异常的账号会进入「注册机 → 异常清单」，不进入账号管理。（该分流将在注册内核迁移后生效）
            </Text>
          </>
        )}
      </Card>
    </div>
  );
}
