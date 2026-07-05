import { useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { Layout, Nav, Button, Spin, Typography, SideSheet, Tooltip } from "@douyinfe/semi-ui-19";
import { IconMoon, IconSun, IconExit, IconMenu, IconIndentLeft, IconIndentRight } from "@douyinfe/semi-icons";

import { useAuthGuard } from "@/lib/use-auth-guard";
import { getTheme, toggleTheme } from "@/lib/theme";
import { getSidebarCollapsed, setSidebarCollapsed } from "@/lib/sidebar";
import { clearStoredAuthSession } from "@/store/auth";
import { useSettingsStore } from "@/store/settings";
import RegisterRunningBanner from "@/components/RegisterRunningBanner";
import { useRegisterStream } from "@/lib/use-register-stream";
import { useIsMobile } from "@/lib/use-is-mobile";
import { NAV_ITEMS } from "@/constants/nav";
import { NAV_MENU_ITEMS } from "@/constants/nav-items";

const { Header, Content, Sider } = Layout;
const { Text } = Typography;

const SIDEBAR_WIDTH_EXPANDED = 156;
const SIDEBAR_WIDTH_COLLAPSED = 56;

const BRAND = { text: "小鲸鱼", logo: <span style={{ fontSize: 22, marginRight: 4 }}>🐋</span> };

export default function AppLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const isMobile = useIsMobile();
  const { isCheckingAuth, session } = useAuthGuard();
  const [dark, setDark] = useState(() => getTheme() === "dark");
  const [menuOpen, setMenuOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsedState] = useState(() => getSidebarCollapsed());
  const registerRunning = useSettingsStore((s) => s.registerConfig?.enabled);
  // 全局订阅注册机 SSE：更新 store。
  useRegisterStream();

  if (isCheckingAuth || !session) {
    return (
      <div style={{ display: "flex", height: "100vh", alignItems: "center", justifyContent: "center" }}>
        <Spin size="large" />
      </div>
    );
  }

  // 命中当前路由的导航项（含子路径）
  const selected = NAV_ITEMS.find((item) => location.pathname.startsWith(item.itemKey))?.itemKey ?? "/register";
  const currentTitle = NAV_ITEMS.find((item) => item.itemKey === selected)?.text ?? "";

  const handleLogout = async () => {
    await clearStoredAuthSession();
    navigate("/login", { replace: true });
  };

  const goto = (key: string) => {
    navigate(key);
    setMenuOpen(false);
  };

  const handleSidebarCollapse = (collapsed: boolean) => {
    setSidebarCollapsedState(collapsed);
    setSidebarCollapsed(collapsed);
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

  const headerActions = (
    <>
      {registerRunning ? <RegisterRunningBanner compact /> : null}
      {themeButton}
      <Text type="tertiary">{session.name || session.role}</Text>
      <Button theme="borderless" type="tertiary" icon={<IconExit />} onClick={() => void handleLogout()}>
        退出
      </Button>
    </>
  );

  const sidebarToggleButton = (
    <Tooltip content={sidebarCollapsed ? "展开侧栏" : "收起侧栏"}>
      <Button
        theme="borderless"
        type="tertiary"
        icon={sidebarCollapsed ? <IconIndentRight /> : <IconIndentLeft />}
        onClick={() => handleSidebarCollapse(!sidebarCollapsed)}
        aria-label={sidebarCollapsed ? "展开侧栏" : "收起侧栏"}
      />
    </Tooltip>
  );

  const pad = isMobile ? 12 : 24;
  const isSettings = location.pathname.startsWith("/settings");

  return (
    <Layout style={{ height: "100vh" }}>
      {!isMobile && (
        <Sider
          className="app-sider"
          style={{
            width: sidebarCollapsed ? SIDEBAR_WIDTH_COLLAPSED : SIDEBAR_WIDTH_EXPANDED,
            flex: `0 0 ${sidebarCollapsed ? SIDEBAR_WIDTH_COLLAPSED : SIDEBAR_WIDTH_EXPANDED}px`,
            backgroundColor: "var(--semi-color-bg-1)",
            borderRight: "1px solid var(--semi-color-border)",
            overflow: "hidden",
          }}
        >
          <Nav
            mode="vertical"
            className="app-sider-nav"
            style={{ width: "100%", height: "100%" }}
            bodyStyle={{ flex: 1, overflow: "auto" }}
            isCollapsed={sidebarCollapsed}
            onCollapseChange={handleSidebarCollapse}
            selectedKeys={[selected]}
            items={NAV_MENU_ITEMS}
            onSelect={({ itemKey }) => navigate(String(itemKey))}
            header={BRAND}
            footer={{ collapseButton: true }}
          />
        </Sider>
      )}

      <Layout>
        <Header
          style={{
            backgroundColor: "var(--semi-color-bg-1)",
            borderBottom: "1px solid var(--semi-color-border)",
            height: isMobile ? 56 : 48,
            lineHeight: isMobile ? "56px" : "48px",
            padding: isMobile ? "0 12px" : "0 24px",
          }}
        >
          {isMobile ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8, height: "100%" }}>
              <span style={{ fontSize: 22 }}>🐋</span>
              <Text strong style={{ flex: 1, fontSize: 16 }} ellipsis={{ showTooltip: false }}>
                {currentTitle || BRAND.text}
              </Text>
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
            <div style={{ display: "flex", alignItems: "center", gap: 12, height: "100%" }}>
              {sidebarToggleButton}
              <Text strong style={{ fontSize: 16 }}>
                {currentTitle}
              </Text>
              <div style={{ flex: 1 }} />
              {headerActions}
            </div>
          )}
        </Header>

        <Content
          className={`app-content-scroll${isSettings ? " app-content-scroll--settings" : ""}`}
          style={{
            paddingTop: isSettings ? 0 : pad,
            paddingRight: pad,
            paddingBottom: pad,
            paddingLeft: pad,
            overflow: "auto",
            backgroundColor: "var(--semi-color-bg-0)",
          }}
        >
          <Outlet />
        </Content>
      </Layout>

      {/* 手机端抽屉导航 */}
      <SideSheet
        title={BRAND.text}
        visible={isMobile && menuOpen}
        onCancel={() => setMenuOpen(false)}
        placement="left"
        width="76%"
        bodyStyle={{ padding: 0, display: "flex", flexDirection: "column" }}
      >
        <nav style={{ flex: 1, paddingTop: 8 }}>
          {NAV_MENU_ITEMS.map((item) => {
            const active = item.itemKey === selected;
            return (
              <button
                key={item.itemKey}
                onClick={() => goto(item.itemKey)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
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
                <span style={{ display: "inline-flex", fontSize: 18 }}>{item.icon}</span>
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
    </Layout>
  );
}
