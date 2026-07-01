import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Card,
  Button,
  InputNumber,
  Switch,
  Progress,
  Typography,
  Toast,
  Space,
  Banner,
} from "@douyinfe/semi-ui-19";
import { IconPlay, IconStop, IconUpload, IconDownload } from "@douyinfe/semi-icons";

import { fetchRun, startRun, stopRun, exportCredentials, type RunState } from "@/lib/api";
import { getStoredAuthKey } from "@/store/auth";
import webConfig from "@/constants/common-env";

const { Title, Text } = Typography;

const LEVEL_COLOR: Record<string, string> = {
  red: "var(--semi-color-danger)",
  green: "var(--semi-color-success)",
  yellow: "var(--semi-color-warning)",
};

function downloadText(text: string, name: string) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export default function DashboardPage() {
  const navigate = useNavigate();
  const [state, setState] = useState<RunState | null>(null);
  const [target, setTarget] = useState<number>(10);
  const [autoReplenish, setAutoReplenish] = useState<boolean>(true);
  const [submitting, setSubmitting] = useState(false);
  const esRef = useRef<EventSource | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  // 初次拉状态 + 开 SSE 实时更新
  useEffect(() => {
    let active = true;
    void fetchRun()
      .then((s) => {
        if (!active) return;
        setState(s);
        if (s.stats.target) setTarget(s.stats.target);
      })
      .catch(() => {});

    void getStoredAuthKey().then((key) => {
      if (!key || !active) return;
      const base = webConfig.apiUrl.replace(/\/$/, "");
      const es = new EventSource(`${base}/api/run/events?token=${encodeURIComponent(key)}`);
      esRef.current = es;
      es.onmessage = (ev) => {
        try {
          setState(JSON.parse(ev.data) as RunState);
        } catch {
          /* ignore */
        }
      };
      es.onerror = () => {
        es.close();
        esRef.current = null;
      };
    });

    return () => {
      active = false;
      esRef.current?.close();
      esRef.current = null;
    };
  }, []);

  // 日志自动滚到底
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [state?.logs?.length]);

  const running = !!state?.running;
  const stats = state?.stats;
  const percent = stats && stats.target > 0 ? Math.min(100, Math.round((stats.activated / stats.target) * 100)) : 0;

  const handleStart = async () => {
    if (target <= 0) {
      Toast.warning("请设置目标数量");
      return;
    }
    setSubmitting(true);
    try {
      const s = await startRun(target, autoReplenish);
      setState(s);
      if (!s.running && s.logs.length) {
        const last = s.logs[s.logs.length - 1];
        if (last?.level === "red") Toast.error(last.text);
      } else {
        Toast.success("已开始一键运行");
      }
    } catch (e) {
      Toast.error(e instanceof Error ? e.message : "启动失败");
    } finally {
      setSubmitting(false);
    }
  };

  const handleStop = async () => {
    setSubmitting(true);
    try {
      const s = await stopRun();
      setState(s);
      Toast.success("已请求停止");
    } catch (e) {
      Toast.error(e instanceof Error ? e.message : "停止失败");
    } finally {
      setSubmitting(false);
    }
  };

  const handleExportActivated = async () => {
    try {
      const text = await exportCredentials([], { onlyUnused: true });
      if (!text.trim()) {
        Toast.warning("没有可导出的未用账号");
        return;
      }
      downloadText(text, `accounts-${Date.now()}.txt`);
      Toast.success("已导出未用账号");
    } catch (e) {
      Toast.error(e instanceof Error ? e.message : "导出失败");
    }
  };

  const overview = [
    { label: "可用邮箱", value: state?.mailbox_available ?? 0 },
    { label: "可用 CDK", value: state?.cdk.available ?? 0 },
    { label: "存活账号", value: state?.summary.total ?? 0 },
    { label: "已激活", value: state?.summary.activated ?? 0, color: "var(--semi-color-success)" },
    { label: "未激活", value: state?.summary.free ?? 0, color: "var(--semi-color-primary)" },
  ];

  return (
    <div style={{ maxWidth: 1080 }}>
      <Title heading={3} style={{ marginBottom: 16 }}>
        一键运行工作台
      </Title>

      {/* 资源概览 */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12, marginBottom: 16 }}>
        {overview.map((o) => (
          <Card key={o.label} bodyStyle={{ padding: 16 }}>
            <Text type="tertiary" size="small">
              {o.label}
            </Text>
            <div style={{ fontSize: 24, fontWeight: 600, color: o.color, marginTop: 4 }}>{o.value}</div>
          </Card>
        ))}
      </div>

      {/* 第一步：准备资源 */}
      <Card title="① 准备资源" style={{ marginBottom: 16 }}>
        <Space>
          <Button icon={<IconUpload />} onClick={() => navigate("/mailboxes")}>
            导入邮箱
          </Button>
          <Button icon={<IconUpload />} onClick={() => navigate("/cdks")}>
            导入 CDK
          </Button>
          <Text type="tertiary">先导入邮箱与 CDK，再设置目标开始运行。</Text>
        </Space>
      </Card>

      {/* 第二步：运行参数 + 一键开始 */}
      <Card title="② 运行参数" style={{ marginBottom: 16 }}>
        <Space spacing="loose" align="center" wrap>
          <Space align="center">
            <Text>目标激活数量</Text>
            <InputNumber min={1} value={target} onChange={(v) => setTarget(Number(v) || 0)} disabled={running} style={{ width: 120 }} />
          </Space>
          <Space align="center">
            <Text>账号不足自动补注册</Text>
            <Switch checked={autoReplenish} onChange={setAutoReplenish} disabled={running} />
          </Space>
          {running ? (
            <Button theme="solid" type="danger" icon={<IconStop />} loading={submitting} onClick={() => void handleStop()}>
              停止
            </Button>
          ) : (
            <Button theme="solid" type="primary" icon={<IconPlay />} loading={submitting} onClick={() => void handleStart()}>
              一键开始
            </Button>
          )}
        </Space>
      </Card>

      {/* 第三步：进度 */}
      <Card
        title="③ 运行进度"
        style={{ marginBottom: 16 }}
        headerExtraContent={
          stats?.phase ? (
            <Text type={running ? "warning" : "tertiary"}>{running ? `运行中 · ${stats.phase}` : stats.phase}</Text>
          ) : null
        }
      >
        <Progress percent={percent} stroke={running ? "var(--semi-color-warning)" : undefined} showInfo style={{ marginBottom: 12 }} />
        <Space spacing="loose" style={{ marginBottom: 12 }}>
          <Text>
            目标 <b>{stats?.target ?? 0}</b>
          </Text>
          <Text>
            已注册 <b>{stats?.registered ?? 0}</b>
          </Text>
          <Text type="success">
            已激活 <b>{stats?.activated ?? 0}</b>
          </Text>
          <Text type="danger">
            失败 <b>{stats?.failed ?? 0}</b>
          </Text>
        </Space>

        {!state?.cdk.available && !running ? (
          <Banner type="warning" description="当前无可用 CDK，请先在 CDK 管理导入。" style={{ marginBottom: 12 }} closeIcon={null} />
        ) : null}

        <div
          ref={logRef}
          style={{
            maxHeight: 240,
            overflow: "auto",
            background: "var(--semi-color-fill-0)",
            borderRadius: 6,
            padding: 12,
            fontFamily: "monospace",
            fontSize: 12,
          }}
        >
          {state?.logs?.length ? (
            state.logs.map((l, i) => (
              <div key={i} style={{ color: LEVEL_COLOR[l.level] || "var(--semi-color-text-1)", lineHeight: "20px" }}>
                <span style={{ color: "var(--semi-color-text-2)" }}>{new Date(l.time).toLocaleTimeString()} </span>
                {l.text}
              </div>
            ))
          ) : (
            <Text type="tertiary">暂无日志</Text>
          )}
        </div>
      </Card>

      {/* 第四步：导出 */}
      <Card title="④ 导出成果">
        <Space>
          <Button icon={<IconDownload />} theme="solid" type="primary" onClick={() => void handleExportActivated()}>
            导出未用账号
          </Button>
          <Button onClick={() => navigate("/accounts")}>去号池管理</Button>
          <Text type="tertiary">导出格式：邮箱 ---- 接码 ---- 密码 ---- 2FA密钥。</Text>
        </Space>
      </Card>
    </div>
  );
}
