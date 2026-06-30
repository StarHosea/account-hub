import { Card, Button, Input, InputNumber, Select, Switch, TextArea, Typography, Space, Toast } from "@douyinfe/semi-ui-19";
import { IconSave, IconRefresh2 } from "@douyinfe/semi-icons";

import { useSettingsStore } from "@/store/settings";
import type { RegisterProviderType } from "@/lib/api";

const { Text } = Typography;

/**
 * 注册机「配置」部分（注册参数 + 邮箱配置）。
 * 原本在独立的「注册机」页，现拆到「设置」页；启动控制见 RegisterControl。
 */
export default function RegisterConfigCard() {
  const config = useSettingsStore((s) => s.registerConfig);
  const isSaving = useSettingsStore((s) => s.isSavingRegister);
  const setProxy = useSettingsStore((s) => s.setRegisterProxy);
  const setTotal = useSettingsStore((s) => s.setRegisterTotal);
  const setThreads = useSettingsStore((s) => s.setRegisterThreads);
  const setEnable2fa = useSettingsStore((s) => s.setRegisterEnable2fa);
  const setMailField = useSettingsStore((s) => s.setRegisterMailField);
  const setProviderType = useSettingsStore((s) => s.setRegisterProviderType);
  const updateProvider = useSettingsStore((s) => s.updateRegisterProvider);
  const save = useSettingsStore((s) => s.saveRegister);
  const reset = useSettingsStore((s) => s.resetRegister);

  if (!config) return null;

  const running = config.enabled;
  const provider = config.mail.providers?.[0] || { type: "api_mailbox", enable: true };
  const providerType: RegisterProviderType = provider.type === "cloudmail_gen" ? "cloudmail_gen" : "api_mailbox";

  const handleSave = async () => {
    try {
      await save();
      Toast.success("注册配置已保存");
    } catch (e) {
      Toast.error(e instanceof Error ? e.message : "保存失败");
    }
  };

  return (
    <>
      <Card
        title="注册配置"
        style={{ marginBottom: 16 }}
        headerExtraContent={
          <Space>
            <Button icon={<IconRefresh2 />} size="small" onClick={() => void reset()} disabled={running}>
              重置统计
            </Button>
            <Button icon={<IconSave />} theme="solid" type="primary" size="small" onClick={() => void handleSave()} loading={isSaving} disabled={running}>
              保存
            </Button>
          </Space>
        }
      >
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16 }}>
          <div>
            <Text style={{ display: "block", marginBottom: 6 }}>目标注册数量</Text>
            <InputNumber min={1} value={config.total} onChange={(v) => setTotal(String(v ?? 1))} disabled={running} style={{ width: "100%" }} />
          </div>
          <div>
            <Text style={{ display: "block", marginBottom: 6 }}>并发数</Text>
            <InputNumber min={1} value={config.threads} onChange={(v) => setThreads(String(v ?? 1))} disabled={running} style={{ width: "100%" }} />
          </div>
          <div>
            <Text style={{ display: "block", marginBottom: 6 }}>注册代理</Text>
            <Input value={config.proxy} onChange={setProxy} placeholder="socks5://user:pass@host:port" disabled={running} />
          </div>
        </div>
        <div style={{ marginTop: 16 }}>
          <Space align="center">
            <Switch checked={!!config.enable_2fa} onChange={setEnable2fa} disabled={running} />
            <Text>注册成功后自动开启 2FA（密钥随账号保存/导出）</Text>
          </Space>
        </div>
      </Card>

      <Card title="邮箱配置" style={{ marginBottom: 16 }}>
        <div style={{ marginBottom: 12 }}>
          <Text style={{ display: "block", marginBottom: 6 }}>邮箱模式</Text>
          <Select
            value={providerType}
            onChange={(v) => setProviderType(v as RegisterProviderType)}
            disabled={running}
            style={{ width: 240 }}
            optionList={[
              { label: "API 邮箱（邮箱管理导入的池）", value: "api_mailbox" },
              { label: "CloudMail 自助生成", value: "cloudmail_gen" },
            ]}
          />
        </div>
        {providerType === "cloudmail_gen" ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12 }}>
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
          <Text type="tertiary">邮箱来自「邮箱管理」导入的 API 邮箱池，无需额外配置。</Text>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginTop: 16 }}>
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
