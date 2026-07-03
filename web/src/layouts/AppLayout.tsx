import { useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { Layout, Nav, Button, Spin, Typography, SideSheet } from "@douyinfe/semi-ui-19";
import { IconMoon, IconSun, IconExit, IconMenu } from "@douyinfe/semi-icons";

import { useAuthGuard } from "@/lib/use-auth-guard";
import { getTheme, toggleTheme } from "@/lib/theme";
import { clearStoredAuthSession } from "@/store/auth";
import { LogButton, LogPanel } from "@/components/LogPanel";
import { useRegisterStream } from "@/lib/use-register-stream";
import { useIsMobile } from "@/lib/use-is-mobile";

const { Header, Content } = Layout;
const { Text } = Typography;

const NAV_ITEMS = [
  { itemKey: "/workbench", text: "工作台" },
  { itemKey: "/accounts", text: "号池管理" },
  { itemKey: "/finished-accounts", text: "成品号管理" },
  { itemKey: "/dispatch", text: "发号管理" },
  { itemKey: "/mailboxes", text: "邮箱管理" },
  { itemKey: "/phones", text: "手机号管理" },
  { itemKey: "/cdks", text: "CDK 管理" },
  { itemKey: "/settings", text: "设置" },
];

const BRAND = { text: "小海豚", logo: <span style={{ fontSize: 22, marginRight: 4 }}>🐬</span> };

export default function AppLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const isMobile = useIsMobile();
  const { isCheckingAuth, session } = useAuthGuard();
  const [dark, setDark] = useState(() => getTheme() === "dark");
  const [menuOpen, setMenuOpen] = useState(false);
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
  const currentTitle = NAV_ITEMS.find((item) => item.itemKey === selected)?.text ?? "";

  const handleLogout = async () => {
    await clearStoredAuthSession();
    navigate("/login", { replace: true });
  };

  const goto = (key: string) => {
    navigate(key);
    setMenuOpen(false);
  };

  const themeButton = (
    <Button
      theme="borderless"
      type="tertiary"
      icon={dark ? <IconSun /> : <IconMoon />}
      onClick={() => setDark(toggleTheme() === "dark")}
      aria-label="切换主题"
    />
  );

  return (
    <Layout style={{ height: "100vh" }}>
      <Header style={{ backgroundColor: "var(--semi-color-bg-1)" }}>
        {isMobile ? (
          // 手机端：品牌 + 当前页名 + 日志/主题 + 汉堡菜单（Cloudflare 式抽屉导航）
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              height: 56,
              padding: "0 12px",
            }}
          >
            <span style={{ fontSize: 22 }}>🐬</span>
            <Text strong style={{ flex: 1, fontSize: 16 }} ellipsis={{ showTooltip: false }}>
              {currentTitle || BRAND.text}
            </Text>
            <LogButton />
            {themeButton}
            <Button
              theme="borderless"
              type="tertiary"
              icon={<IconMenu />}
              onClick={() => setMenuOpen(true)}
              aria-label="菜单"
            />
          </div>
        ) : (
          <Nav
            mode="horizontal"
            selectedKeys={[selected]}
            items={NAV_ITEMS}
            onSelect={({ itemKey }) => navigate(String(itemKey))}
            header={BRAND}
            footer={
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <LogButton />
                {themeButton}
                <Text type="tertiary">{session.name || session.role}</Text>
                <Button theme="borderless" type="tertiary" icon={<IconExit />} onClick={() => void handleLogout()}>
                  退出
                </Button>
              </div>
            }
          />
        )}
      </Header>

      <Content
        style={{
          padding: isMobile ? 12 : 24,
          overflow: "auto",
          backgroundColor: "var(--semi-color-bg-0)",
        }}
      >
        <Outlet />
      </Content>

      {/* 手机端抽屉导航 */}
      <SideSheet
        title={BRAND.text}
        visible={isMobile && menuOpen}
        onCancel={() => setMenuOpen(false)}
        placement="right"
        width="76%"
        bodyStyle={{ padding: 0, display: "flex", flexDirection: "column" }}
      >
        <nav style={{ flex: 1, paddingTop: 8 }}>
          {NAV_ITEMS.map((item) => {
            const active = item.itemKey === selected;
            return (
              <button
                key={item.itemKey}
                onClick={() => goto(item.itemKey)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  width: "100%",
                  padding: "14px 20px",
                  border: "none",
                  borderLeft: `3px solid ${active ? "var(--semi-color-primary)" : "transparent"}`,
                  background: active ? "var(--semi-color-primary-light-default)" : "transparent",
                  color: active ? "var(--semi-color-primary)" : "var(--semi-color-text-0)",
                  fontSize: 16,
                  fontWeight: active ? 600 : 400,
                  textAlign: "left",
                  cursor: "pointer",
                }}
              >
                {item.text}
              </button>
            );
          })}
        </nav>
        <div style={{ borderTop: "1px solid var(--semi-color-border)", padding: 16 }}>
          <Text type="tertiary" style={{ display: "block", marginBottom: 12 }}>
            {session.name || session.role}
          </Text>
          <Button block icon={<IconExit />} onClick={() => void handleLogout()}>
            退出登录
          </Button>
        </div>
      </SideSheet>

      <LogPanel />
    </Layout>
  );
}
