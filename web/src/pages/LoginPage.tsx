import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card, Form, Button, Typography, Toast, Spin } from "@douyinfe/semi-ui-19";

import { login } from "@/lib/api";
import { getDefaultRouteForRole, setStoredAuthSession } from "@/store/auth";
import { useRedirectIfAuthenticated } from "@/lib/use-auth-guard";

const { Title, Text } = Typography;

export default function LoginPage() {
  const navigate = useNavigate();
  const { isCheckingAuth } = useRedirectIfAuthenticated();
  const [loading, setLoading] = useState(false);

  if (isCheckingAuth) {
    return (
      <div style={{ display: "flex", height: "100vh", alignItems: "center", justifyContent: "center" }}>
        <Spin size="large" />
      </div>
    );
  }

  const handleSubmit = async (values: Record<string, unknown>) => {
    const key = String(values.key || "").trim();
    if (!key) {
      Toast.warning("请输入密钥");
      return;
    }
    setLoading(true);
    try {
      const data = await login(key);
      await setStoredAuthSession({ key, role: data.role, subjectId: data.subject_id, name: data.name });
      Toast.success("登录成功");
      navigate(getDefaultRouteForRole(data.role), { replace: true });
    } catch (error) {
      Toast.error(error instanceof Error ? error.message : "登录失败");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        display: "flex",
        minHeight: "100vh",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--semi-color-bg-0)",
        padding: 16,
      }}
    >
      <Card style={{ width: 380 }} bodyStyle={{ padding: 28 }}>
        <div style={{ marginBottom: 20 }}>
          <Title heading={3} style={{ margin: 0 }}>
            🐋 小鲸鱼
          </Title>
          <Text type="tertiary">输入密钥登录，管理账号与自动化任务。</Text>
        </div>
        <Form onSubmit={handleSubmit}>
          <Form.Input
            field="key"
            label="密钥"
            mode="password"
            placeholder="请输入访问密钥"
            autoComplete="current-password"
            style={{ width: "100%" }}
          />
          <Button htmlType="submit" theme="solid" type="primary" block loading={loading} style={{ marginTop: 12 }}>
            登录
          </Button>
        </Form>
      </Card>
    </div>
  );
}
