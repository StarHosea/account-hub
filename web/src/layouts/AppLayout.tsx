import { useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { Layout, Nav, Button, Spin, Typography } from "@douyinfe/semi-ui-19";
import { IconMoon, IconSun, IconExit } from "@douyinfe/semi-icons";

import { useAuthGuard } from "@/lib/use-auth-guard";
import { getTheme, toggleTheme } from "@/lib/theme";
import { clearStoredAuthSession } from "@/store/auth";
import { LogButton, LogPanel } from "@/components/LogPanel";
import { useRegisterStream } from "@/lib/use-register-stream";

const { Header, Content } = Layout;
const { Text } = Typography;

const NAV_ITEMS = [
  { itemKey: "/dashboard", text: "工作台" },
  { itemKey: "/accounts", text: "号池管理" },
  { itemKey: "/mailboxes", text: "邮箱管理" },
  { itemKey: "/cdks", text: "CDK 管理" },
  { itemKey: "/settings", text: "设置" },
];

export default function AppLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { isCheckingAuth, session } = useAuthGuard();
  const [dark, setDark] = useState(() => getTheme() === "dark");
  // 全局订阅注册机 SSE：更新 store + 把日志转发到侧边面板（注册机页已拆除）。
  useRegisterStream();

  if (isCheckingAuth || !session) {
    return (
      <div style={{ display: "flex", height: "100vh", alignItems: "center", justifyContent: "center" }}>
        <Spin size="large" />
      </div>
    );
  }

  // 命中当前路由的导航项（含子路径）
  const selected = NAV_ITEMS.find((item) => location.pathname.startsWith(item.itemKey))?.itemKey ?? "/accounts";

  const handleLogout = async () => {
    await clearStoredAuthSession();
    navigate("/login", { replace: true });
  };

  return (
    <Layout style={{ height: "100vh" }}>
      <Header style={{ backgroundColor: "var(--semi-color-bg-1)" }}>
        <Nav
          mode="horizontal"
          selectedKeys={[selected]}
          items={NAV_ITEMS}
          onSelect={({ itemKey }) => navigate(String(itemKey))}
          header={{ text: "小海豚", logo: <span style={{ fontSize: 22, marginRight: 4 }}>🐬</span> }}
          footer={
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <LogButton />
              <Button
                theme="borderless"
                type="tertiary"
                icon={dark ? <IconSun /> : <IconMoon />}
                onClick={() => setDark(toggleTheme() === "dark")}
                aria-label="切换主题"
              />
              <Text type="tertiary">{session.name || session.role}</Text>
              <Button theme="borderless" type="tertiary" icon={<IconExit />} onClick={() => void handleLogout()}>
                退出
              </Button>
            </div>
          }
        />
      </Header>
      <Content style={{ padding: 24, overflow: "auto", backgroundColor: "var(--semi-color-bg-0)" }}>
        <Outlet />
      </Content>
      <LogPanel />
    </Layout>
  );
}
