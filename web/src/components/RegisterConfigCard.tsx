import { useState } from "react";
import { Card, Button, Input, InputNumber, Select, Switch, TextArea, Typography, Space, Toast, Spin, Radio, RadioGroup } from "@douyinfe/semi-ui-19";
import { IconSave, IconRefresh, IconLink } from "@douyinfe/semi-icons";

import { useSettingsStore } from "@/store/settings";
import { copyToClipboard } from "@/lib/clipboard";
import {
  DEFAULT_HTTP_PROXY,
  DEFAULT_IPWEB_ACCOUNT_ID,
  DEFAULT_IPWEB_GATEWAY,
  DEFAULT_IPWEB_PASSWORD,
  type RegisterProxyMode,
} from "@/lib/register-proxy";
import type { RegisterProviderType } from "@/lib/api";
import { NAV_LABELS, navRef } from "@/constants/nav";

const { Text } = Typography;

function formatBytes(bytes: number): string {
  const n = Number(bytes) || 0;
  if (n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * 注册机「配置」部分（注册参数 + IPWeb 代理 + 区域 + 2FA + 邮箱配置）。
 * 在「设置」页展示；号池管理页只保留启动/停止（见 RegisterPanel）。
 */
export default function RegisterConfigCard() {
  const config = useSettingsStore((s) => s.registerConfig);
  const isSaving = useSettingsStore((s) => s.isSavingRegister);
  const setIpwebGateway = useSettingsStore((s) => s.setRegisterIpwebGateway);
  const setIpwebAccountId = useSettingsStore((s) => s.setRegisterIpwebAccountId);
  const setIpwebPassword = useSettingsStore((s) => s.setRegisterIpwebPassword);
  const setProxyMode = useSettingsStore((s) => s.setRegisterProxyMode);
  const setHttpProxy = useSettingsStore((s) => s.setRegisterHttpProxy);
  const setTotal = useSettingsStore((s) => s.setRegisterTotal);
  const setThreads = useSettingsStore((s) => s.setRegisterThreads);
  const setEnable2fa = useSettingsStore((s) => s.setRegisterEnable2fa);
  const setRegions = useSettingsStore((s) => s.setRegisterRegions);
  const setRegisterTimeoutMinutes = useSettingsStore((s) => s.setRegisterTimeoutMinutes);
  const setStaticCacheEnabled = useSettingsStore((s) => s.setRegisterStaticCacheEnabled);
  const setStaticCacheMaxAgeDays = useSettingsStore((s) => s.setRegisterStaticCacheMaxAgeDays);
  const setStaticCacheDir = useSettingsStore((s) => s.setRegisterStaticCacheDir);
  const setRecordEnabled = useSettingsStore((s) => s.setRegisterRecordEnabled);
  const setRecordDir = useSettingsStore((s) => s.setRegisterRecordDir);
  const setRecordKeep = useSettingsStore((s) => s.setRegisterRecordKeep);
  const setDiagPublicUrl = useSettingsStore((s) => s.setRegisterDiagPublicUrl);
  const setMailField = useSettingsStore((s) => s.setRegisterMailField);
  const setProviderType = useSettingsStore((s) => s.setRegisterProviderType);
  const updateProvider = useSettingsStore((s) => s.updateRegisterProvider);
  const save = useSettingsStore((s) => s.saveRegister);
  const saveActivation = useSettingsStore((s) => s.saveActivationConfig);
  const activationConfig = useSettingsStore((s) => s.activationConfig);
  const setActivationAutoActivate = useSettingsStore((s) => s.setActivationAutoActivate);
  const setActivationField = useSettingsStore((s) => s.setActivationConfigField);
  const loadRegister = useSettingsStore((s) => s.loadRegister);
  const isLoadingRegister = useSettingsStore((s) => s.isLoadingRegister);
  const [savingActivation, setSavingActivation] = useState(false);

  if (!config) return null;

  const running = config.enabled;
  const registerTimeoutMinutes = Math.round((Number(config.register_timeout) || 600) / 60);
  const provider = config.mail.providers?.[0] || { type: "api_mailbox", enable: true };
  const providerType: RegisterProviderType = provider.type === "cloudmail_gen" ? "cloudmail_gen" : "api_mailbox";
  const proxyMode: RegisterProxyMode = config.proxy_mode || "ipweb";

  const handleSave = async () => {
    try {
      await save();
      if (activationConfig) await saveActivation({ silent: true });
      Toast.success("注册配置已保存");
    } catch (e) {
      Toast.error(e instanceof Error ? e.message : "保存失败");
    }
  };

  const handleSaveActivation = async () => {
    setSavingActivation(true);
    try {
      await saveActivation();
      Toast.success("激活设置已保存");
    } catch (e) {
      Toast.error(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSavingActivation(false);
    }
  };

  return (
    <>
      <Card
        id="settings-register"
        title="注册配置"
        style={{ marginBottom: 16 }}
        headerExtraContent={
          <Button icon={<IconSave />} theme="solid" type="primary" size="small" onClick={() => void handleSave()} loading={isSaving} disabled={running}>
            保存
          </Button>
        }
      >
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 16 }}>
          <div>
            <Text style={{ display: "block", marginBottom: 6 }}>目标注册数量</Text>
            <InputNumber min={1} value={config.total} onChange={(v) => setTotal(String(v ?? 1))} disabled={running} style={{ width: "100%" }} />
          </div>
          <div>
            <Text style={{ display: "block", marginBottom: 6 }}>并发数</Text>
            <InputNumber min={1} value={config.threads} onChange={(v) => setThreads(String(v ?? 1))} disabled={running} style={{ width: "100%" }} />
          </div>
        </div>
        <div style={{ marginTop: 16, padding: 16, borderRadius: 8, background: "var(--semi-color-fill-0)" }}>
          <Text strong style={{ display: "block", marginBottom: 8 }}>注册出口代理</Text>
          <RadioGroup
            type="button"
            value={proxyMode}
            onChange={(e) => setProxyMode(e.target.value as RegisterProxyMode)}
            disabled={running}
            style={{ marginBottom: 12 }}
          >
            <Radio value="none">本机网络</Radio>
            <Radio value="ipweb">IPWeb 动态代理</Radio>
            <Radio value="http">固定 HTTP 代理</Radio>
          </RadioGroup>
          {proxyMode === "none" ? (
            <Text type="tertiary" size="small">浏览器直连，适用于服务器本机出口或内网调试。</Text>
          ) : null}
          {proxyMode === "ipweb" ? (
            <>
              <Text type="tertiary" size="small" style={{ display: "block", marginBottom: 12 }}>
                一号一 IP：每个任务按注册区域与时限自动生成独立 SID；仅需填写 IPWeb 账号信息。
              </Text>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 16 }}>
                <div>
                  <Text style={{ display: "block", marginBottom: 6 }}>网关</Text>
                  <Input
                    value={config.ipweb_gateway || ""}
                    onChange={setIpwebGateway}
                    placeholder={DEFAULT_IPWEB_GATEWAY}
                    disabled={running}
                  />
                </div>
                <div>
                  <Text style={{ display: "block", marginBottom: 6 }}>账号 ID</Text>
                  <Input
                    value={config.ipweb_account_id || ""}
                    onChange={setIpwebAccountId}
                    placeholder={DEFAULT_IPWEB_ACCOUNT_ID}
                    disabled={running}
                  />
                </div>
                <div>
                  <Text style={{ display: "block", marginBottom: 6 }}>密码</Text>
                  <Input
                    mode="password"
                    value={config.ipweb_password || ""}
                    onChange={setIpwebPassword}
                    placeholder={DEFAULT_IPWEB_PASSWORD}
                    disabled={running}
                  />
                </div>
              </div>
            </>
          ) : null}
          {proxyMode === "http" ? (
            <>
              <Text type="tertiary" size="small" style={{ display: "block", marginBottom: 12 }}>
                本地调试可填 Clash / Surge 等 HTTP 端口，例如本机 7890。
              </Text>
              <Input
                value={config.http_proxy || ""}
                onChange={setHttpProxy}
                placeholder={DEFAULT_HTTP_PROXY}
                disabled={running}
              />
            </>
          ) : null}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 16, marginTop: 16 }}>
          <div style={{ gridColumn: "span 2" }}>
            <Text style={{ display: "block", marginBottom: 6 }}>注册区域（多选，按账号随机分配出口 IP 地区）</Text>
            <Select
              multiple
              value={config.regions && config.regions.length ? config.regions : ["US"]}
              onChange={(v) => setRegions((v as string[]) || [])}
              disabled={running}
              style={{ width: "100%" }}
              optionList={[
                { label: "美国 US", value: "US" },
                { label: "日本 JP", value: "JP" },
                { label: "印度 IN", value: "IN" },
              ]}
            />
          </div>
          <div>
            <Text style={{ display: "block", marginBottom: 6 }}>单次注册时限（分钟）</Text>
            <InputNumber
              min={1}
              max={30}
              value={registerTimeoutMinutes}
              onChange={(v) => setRegisterTimeoutMinutes(Number(v) || 10)}
              disabled={running}
              style={{ width: "100%" }}
            />
            <Text type="tertiary" size="small">超时自动终止并记为失败，不阻塞后续注册；默认 10 分钟。同时作为 IP 粘性时长。</Text>
          </div>
        </div>
        <div style={{ marginTop: 16 }}>
          <Space align="center">
            <Switch checked={!!config.enable_2fa} onChange={setEnable2fa} disabled={running} />
            <Text>注册成功后自动开启 2FA（密钥随账号保存/导出）</Text>
          </Space>
        </div>
        <div style={{ marginTop: 12 }}>
          <Space align="center">
            <Switch
              checked={!!activationConfig?.auto_activate_after_register}
              onChange={setActivationAutoActivate}
              disabled={running || !activationConfig}
            />
            <Text>注册成功后自动激活 Plus（需已配置 CDK API 且{navRef("cdks")}有可用码）</Text>
          </Space>
        </div>
      </Card>

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
            onClick={() => void handleSaveActivation()}
            loading={savingActivation}
            disabled={!activationConfig}
          >
            保存
          </Button>
        }
      >
        {!activationConfig ? (
          <Spin />
        ) : (
          <>
            <div style={{ marginBottom: 14 }}>
              <Text style={{ display: "block", marginBottom: 6 }}>
                CDK API Key{activationConfig.has_api_key ? "（已配置，可留空不改）" : ""}
              </Text>
              <Input
                mode="password"
                value={activationConfig.api_key ?? ""}
                onChange={(v) => setActivationField("api_key", v)}
                placeholder={activationConfig.has_api_key ? "••••••（已配置）" : "填写 CDK 兑换 API Key"}
              />
            </div>
            <div style={{ marginBottom: 14 }}>
              <Text style={{ display: "block", marginBottom: 6 }}>CDK API 地址</Text>
              <Input value={activationConfig.base_url ?? ""} onChange={(v) => setActivationField("base_url", v)} />
            </div>
            <Text type="tertiary" size="small">
              并发数、激活数量等运行参数请在{navRef("activator")}页设置；注册成功后自动激活请在上方「注册配置」中设置。
            </Text>
          </>
        )}
      </Card>

      <Card id="settings-static-cache" title="缓存设置" style={{ marginBottom: 16 }}>
        <Text type="tertiary" style={{ display: "block", marginBottom: 12 }}>
          全账号共享 JS/CSS/字体等静态文件缓存，节省住宅代理流量；Cookie 与登录态仍按账号隔离，不共享。
          默认目录为 data/http-cache（Docker 下随 data 卷持久化）；写入失败会在{navRef("register")}运行日志中提示。
        </Text>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 16 }}>
          <div>
            <Text style={{ display: "block", marginBottom: 6 }}>开启缓存</Text>
            <Space align="center" style={{ height: 32 }}>
              <Switch
                checked={config.static_cache_enabled !== false}
                onChange={setStaticCacheEnabled}
                disabled={running}
              />
              <Text type="tertiary" size="small">关闭后每次注册均从网络拉取静态资源</Text>
            </Space>
          </div>
          <div>
            <Text style={{ display: "block", marginBottom: 6 }}>缓存有效期（天）</Text>
            <InputNumber
              min={1}
              max={90}
              value={config.static_cache_max_age_days ?? 7}
              onChange={(v) => setStaticCacheMaxAgeDays(Math.min(90, Math.max(1, Number(v) || 7)))}
              disabled={running || config.static_cache_enabled === false}
              style={{ width: "100%" }}
            />
          </div>
          <div style={{ gridColumn: "span 2" }}>
            <Text style={{ display: "block", marginBottom: 6 }}>缓存目录（可选）</Text>
            <Input
              value={config.static_cache_dir || ""}
              onChange={setStaticCacheDir}
              placeholder="留空使用默认 data/http-cache"
              disabled={running || config.static_cache_enabled === false}
            />
          </div>
          <div style={{ gridColumn: "span 2" }}>
            <Space align="center" wrap>
              <Text>
                当前占用：<Text strong>{formatBytes(config.static_cache_size_bytes ?? 0)}</Text>
                {typeof config.static_cache_file_count === "number" ? (
                  <Text type="tertiary">（{config.static_cache_file_count} 个文件）</Text>
                ) : null}
              </Text>
              <Button
                icon={<IconRefresh />}
                size="small"
                theme="borderless"
                loading={isLoadingRegister}
                onClick={() => void loadRegister()}
              >
                刷新
              </Button>
            </Space>
            {config.static_cache_resolved_dir ? (
              <Text type="tertiary" size="small" style={{ display: "block", marginTop: 6 }}>
                路径：{config.static_cache_resolved_dir}
              </Text>
            ) : null}
          </div>
        </div>
      </Card>

      <Card id="settings-mail" title="邮箱配置" style={{ marginBottom: 16 }}>
        <div style={{ marginBottom: 12 }}>
          <Text style={{ display: "block", marginBottom: 6 }}>邮箱模式</Text>
          <Select
            value={providerType}
            onChange={(v) => setProviderType(v as RegisterProviderType)}
            disabled={running}
            style={{ width: 240 }}
            optionList={[
              { label: `API 邮箱（${NAV_LABELS.mailboxes}导入）`, value: "api_mailbox" },
              { label: "CloudMail 自助生成", value: "cloudmail_gen" },
            ]}
          />
        </div>
        {providerType === "cloudmail_gen" ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
            <div>
              <Text style={{ display: "block", marginBottom: 6 }}>CloudMail URL</Text>
              <Input value={String(provider.api_base || "")} onChange={(v) => updateProvider({ api_base: v })} disabled={running} />
            </div>
            <div>
              <Text style={{ display: "block", marginBottom: 6 }}>邮箱前缀</Text>
              <Input value={String(provider.email_prefix || "")} onChange={(v) => updateProvider({ email_prefix: v })} disabled={running} />
            </div>
            <div>
              <Text style={{ display: "block", marginBottom: 6 }}>管理员邮箱</Text>
              <Input value={String(provider.admin_email || "")} onChange={(v) => updateProvider({ admin_email: v })} disabled={running} />
            </div>
            <div>
              <Text style={{ display: "block", marginBottom: 6 }}>管理员密码</Text>
              <Input mode="password" value={String(provider.admin_password || "")} onChange={(v) => updateProvider({ admin_password: v })} disabled={running} />
            </div>
            <div>
              <Text style={{ display: "block", marginBottom: 6 }}>域名（每行一个）</Text>
              <TextArea
                value={Array.isArray(provider.domain) ? provider.domain.join("\n") : ""}
                onChange={(v) => updateProvider({ domain: v.split(/[\n,]/).map((s) => s.trim()).filter(Boolean) })}
                rows={3}
                disabled={running}
              />
            </div>
            <div>
              <Text style={{ display: "block", marginBottom: 6 }}>子域名（每行一个）</Text>
              <TextArea
                value={Array.isArray(provider.subdomain) ? provider.subdomain.join("\n") : ""}
                onChange={(v) => updateProvider({ subdomain: v.split(/[\n,]/).map((s) => s.trim()).filter(Boolean) })}
                rows={3}
                disabled={running}
              />
            </div>
          </div>
        ) : (
          <Text type="tertiary">邮箱来自{navRef("mailboxes")}导入的 API 邮箱池，无需额外配置。</Text>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12, marginTop: 16 }}>
          {(["request_timeout", "wait_timeout", "wait_interval"] as const).map((k) => (
            <div key={k}>
              <Text style={{ display: "block", marginBottom: 6 }}>
                {k === "request_timeout" ? "收件请求超时" : k === "wait_timeout" ? "等待验证码超时" : "轮询间隔"}
              </Text>
              <InputNumber min={1} value={config.mail[k]} onChange={(v) => setMailField(k, String(v ?? 1))} disabled={running} style={{ width: "100%" }} />
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}
