import { useEffect, useRef, useState } from "react";
import { Card, Button, Input, Toast, Typography, Spin } from "@douyinfe/semi-ui-19";
import { IconSave } from "@douyinfe/semi-icons";

import { useSettingsStore } from "@/store/settings";
import RegisterConfigCard from "@/components/RegisterConfigCard";
import SettingsQuickNav from "@/components/SettingsQuickNav";

const { Text } = Typography;

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <Text style={{ display: "block", marginBottom: 6 }}>{label}</Text>
      {children}
    </div>
  );
}

export default function SettingsPage() {
  const config = useSettingsStore((s) => s.config);
  const loadConfig = useSettingsStore((s) => s.loadConfig);
  const loadActivation = useSettingsStore((s) => s.loadActivationConfig);
  const loadRegister = useSettingsStore((s) => s.loadRegister);
  const saveConfig = useSettingsStore((s) => s.saveConfig);
  const setProxy = useSettingsStore((s) => s.setProxy);

  const [savingBase, setSavingBase] = useState(false);
  const didLoad = useRef(false);

  useEffect(() => {
    if (didLoad.current) return;
    didLoad.current = true;
    void loadConfig();
    void loadActivation();
    void loadRegister(true);
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

  return (
    <div className="settings-page">
      <SettingsQuickNav />

      <div className="settings-page-body">
        <Card
          id="settings-base"
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
            <Row label="全局代理">
              <Input value={config.proxy ?? ""} onChange={setProxy} placeholder="留空则不使用代理，例：http://host:port" />
            </Row>
          )}
        </Card>

        <RegisterConfigCard />
      </div>
    </div>
  );
}
