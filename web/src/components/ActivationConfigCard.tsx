import { useEffect, useState } from "react";
import { Card, Button, Input, InputNumber, Typography, Toast, Spin, Tooltip } from "@douyinfe/semi-ui-19";
import { IconSave } from "@douyinfe/semi-icons";

import { fetchActivation } from "@/lib/api";
import { useSettingsStore } from "@/store/settings";
import { navRef } from "@/constants/nav";

const { Text } = Typography;

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <Text style={{ display: "block", marginBottom: 6 }}>{label}</Text>
      {children}
      {hint ? (
        <Text type="tertiary" size="small" style={{ display: "block", marginTop: 4 }}>
          {hint}
        </Text>
      ) : null}
    </div>
  );
}

/**
 * CDK 激活策略与连接配置（系统设置 → 激活设置）。
 * 运行参数在任务启动时读取；{navRef("activator")} 页仅保留本轮上限与启停。
 */
export default function ActivationConfigCard({ registerRunning = false }: { registerRunning?: boolean }) {
  const activationConfig = useSettingsStore((s) => s.activationConfig);
  const setActivationField = useSettingsStore((s) => s.setActivationConfigField);
  const saveActivation = useSettingsStore((s) => s.saveActivationConfig);

  const [saving, setSaving] = useState(false);
  const [jobRunning, setJobRunning] = useState(false);

  const disabled = registerRunning || jobRunning;

  useEffect(() => {
    void fetchActivation()
      .then((d) => setJobRunning(Boolean(d.activation?.stats?.job_running)))
      .catch(() => {});
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      await saveActivation();
      const d = await fetchActivation();
      setJobRunning(Boolean(d.activation?.stats?.job_running));
      Toast.success("激活设置已保存");
    } catch (e) {
      Toast.error(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  if (!activationConfig) {
    return (
      <Card id="settings-activation" title="激活设置" style={{ marginBottom: 16 }}>
        <Spin />
      </Card>
    );
  }

  const pollTimeoutHours = Math.round((Number(activationConfig.poll_timeout) || 3600) / 3600);

  return (
    <Card
      id="settings-activation"
      title="激活设置"
      style={{ marginBottom: 16 }}
      headerExtraContent={
        <Button
          icon={<IconSave />}
          theme="solid"
          type="primary"
          size="small"
          onClick={() => void handleSave()}
          loading={saving}
          disabled={disabled}
        >
          保存
        </Button>
      }
    >
      {jobRunning ? (
        <Text type="warning" size="small" style={{ display: "block", marginBottom: 12 }}>
          激活任务运行中，请先停止后再修改配置。
        </Text>
      ) : null}

      <Text strong style={{ display: "block", marginBottom: 10 }}>
        连接
      </Text>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 16, marginBottom: 20 }}>
        <Field
          label={`CDK API Key${activationConfig.has_api_key ? "（已配置，可留空不改）" : ""}`}
        >
          <Input
            mode="password"
            value={activationConfig.api_key ?? ""}
            onChange={(v) => setActivationField("api_key", v)}
            placeholder={activationConfig.has_api_key ? "••••••（已配置）" : "填写 CDK 兑换 API Key"}
            disabled={disabled}
          />
        </Field>
        <Field label="CDK API 地址">
          <Input
            value={activationConfig.base_url ?? ""}
            onChange={(v) => setActivationField("base_url", v)}
            disabled={disabled}
          />
        </Field>
      </div>

      <Text strong style={{ display: "block", marginBottom: 10 }}>
        批次与换卡
      </Text>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 16, marginBottom: 20 }}>
        <Field label="并发数" hint="同时激活的账号数，1–10">
          <InputNumber
            min={1}
            max={10}
            value={activationConfig.concurrency ?? 10}
            onChange={(v) => setActivationField("concurrency", String(v ?? 1))}
            disabled={disabled}
            style={{ width: "100%" }}
          />
        </Field>
        <Field label="默认激活上限" hint={`0 表示不限；${navRef("activator")} 启动时可覆盖本轮上限`}>
          <InputNumber
            min={0}
            value={activationConfig.target ?? 0}
            onChange={(v) => setActivationField("target", String(v ?? 0))}
            disabled={disabled}
            style={{ width: "100%" }}
          />
        </Field>
        <Field label="每类型最多换卡次数" hint="UPI / IDEL 各类型最多尝试几张不同 CDK">
          <InputNumber
            min={1}
            max={20}
            value={activationConfig.max_attempts_per_type ?? 3}
            onChange={(v) => setActivationField("max_attempts_per_type", String(v ?? 1))}
            disabled={disabled}
            style={{ width: "100%" }}
          />
        </Field>
      </div>

      <Text strong style={{ display: "block", marginBottom: 10 }}>
        轮询
      </Text>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 16, marginBottom: 20 }}>
        <Field label="轮询间隔（秒）" hint="查询激活状态的间隔，默认 5">
          <InputNumber
            min={1}
            max={120}
            value={activationConfig.poll_interval ?? 5}
            onChange={(v) => setActivationField("poll_interval", String(v ?? 1))}
            disabled={disabled}
            style={{ width: "100%" }}
          />
        </Field>
        <Tooltip content="单张 CDK 持续查状态的最长等待；到点仍无终态则转人工核查，不判失败、不换卡">
          <div>
            <Field label="轮询大兜底（小时）" hint="默认 1 小时；改小会过早打断长排队兑换">
              <InputNumber
                min={1}
                max={72}
                value={pollTimeoutHours}
                onChange={(v) => setActivationField("poll_timeout", String((Number(v) || 1) * 3600))}
                disabled={disabled}
                style={{ width: "100%" }}
              />
            </Field>
          </div>
        </Tooltip>
      </div>

      <Text strong style={{ display: "block", marginBottom: 10 }}>
        同卡重试
      </Text>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 16 }}>
        <Tooltip content="服务端返回 timeout 时，用同一张 CDK 重入列的次数上限（不计入换卡失败次数），超限转人工核查">
          <div>
            <Field label="超时重试次数" hint="走 /cdkey-jobs/retry，默认 5">
              <InputNumber
                min={0}
                max={20}
                value={activationConfig.timeout_retry_max ?? 5}
                onChange={(v) => setActivationField("timeout_retry_max", String(v ?? 0))}
                disabled={disabled}
                style={{ width: "100%" }}
              />
            </Field>
          </div>
        </Tooltip>
        <Tooltip content="服务端返回 failed 等失败时，同一张 CDK 先重试；用尽才换下一张并计入换卡次数">
          <div>
            <Field label="失败重试次数" hint="用尽后才换下一张 CDK，默认 3">
              <InputNumber
                min={0}
                max={20}
                value={activationConfig.failed_retry_max ?? 3}
                onChange={(v) => setActivationField("failed_retry_max", String(v ?? 0))}
                disabled={disabled}
                style={{ width: "100%" }}
              />
            </Field>
          </div>
        </Tooltip>
      </div>

      <Text type="tertiary" size="small" style={{ display: "block", marginTop: 16 }}>
        注册成功后自动激活请在上方「注册配置」中开关；本轮启停与进度见{navRef("activator")}页。
      </Text>
    </Card>
  );
}
