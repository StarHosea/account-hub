import { useEffect, useMemo, useRef, useState } from "react";
import {
  Card,
  Button,
  InputNumber,
  Switch,
  Progress,
  Typography,
  Toast,
  Space,
  Popconfirm,
  Table,
  Tag,
  Spin,
  Empty,
} from "@douyinfe/semi-ui-19";
import { IconPlay, IconStop, IconDelete, IconAlertTriangle, IconSave } from "@douyinfe/semi-icons";

import {
  fetchActivation,
  startActivation,
  stopActivation,
  clearActivationLogs,
  fetchAccounts,
  fetchCdks,
  type ActivationState,
  type Account,
  type PlusStatus,
} from "@/lib/api";
import { useSettingsStore } from "@/store/settings";
import { useIsMobile } from "@/lib/use-is-mobile";

const { Title, Text } = Typography;

const LEVEL_COLOR: Record<string, string> = {
  red: "var(--semi-color-danger)",
  green: "var(--semi-color-success)",
  yellow: "var(--semi-color-warning)",
};

const PLUS_TAG_COLOR: Record<string, string> = {
  未激活: "grey",
  排队中: "blue",
  激活中: "orange",
  已激活: "green",
  激活失败: "red",
};

type LogEntry = { time: string; text: string; level: string };

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString();
  } catch {
    return iso;
  }
}

function maskSecret(s: string): string {
  const v = String(s || "");
  if (v.length <= 8) return v;
  return `${v.slice(0, 4)}…${v.slice(-4)}`;
}

function LogView({ logs }: { logs: LogEntry[] }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [logs.length]);
  return (
    <div
      ref={ref}
      style={{
        height: 260,
        overflow: "auto",
        background: "var(--semi-color-fill-0)",
        borderRadius: 6,
        padding: 12,
        fontFamily: "var(--semi-font-mono, monospace)",
        fontSize: 12,
        lineHeight: "20px",
      }}
    >
      {logs.length ? (
        logs.map((l, i) => (
          <div key={i} style={{ color: LEVEL_COLOR[l.level] || "var(--semi-color-text-1)" }}>
            <span style={{ color: "var(--semi-color-text-2)" }}>{fmtTime(l.time)} </span>
            {l.text}
          </div>
        ))
      ) : (
        <Text type="tertiary">暂无日志</Text>
      )}
    </div>
  );
}

function renderPlusStatus(a: Account) {
  const st: PlusStatus = a.plus_status ?? "未激活";
  const inProgress = st === "排队中" || st === "激活中";
  const attempts = a.plus_attempts;
  const tries = attempts && (attempts.UPI || attempts.IDEL) ? `UPI ${attempts.UPI} / IDEL ${attempts.IDEL}` : "";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
      <Space spacing={4}>
        {inProgress ? <Spin size="small" /> : null}
        <Tag color={(PLUS_TAG_COLOR[st] ?? "grey") as never} type="light">
          {st}
        </Tag>
        {tries ? (
          <Text type="tertiary" size="small">
            {tries}
          </Text>
        ) : null}
      </Space>
      {a.plus_last_message ? (
        <Text type="tertiary" size="small" ellipsis={{ showTooltip: true }} style={{ maxWidth: 260 }}>
          {a.plus_last_message}
        </Text>
      ) : null}
      {a.plus_cdk ? (
        <Text type="tertiary" size="small" style={{ fontFamily: "monospace" }}>
          CDK {maskSecret(a.plus_cdk)}
        </Text>
      ) : null}
    </div>
  );
}

function OverviewCard({ label, value, danger }: { label: string; value: number; danger?: boolean }) {
  return (
    <Card bodyStyle={{ padding: 16 }}>
      <Text type="tertiary" size="small">
        {label}
      </Text>
      <div
        style={{
          fontSize: 24,
          fontWeight: 600,
          marginTop: 4,
          color: danger ? "var(--semi-color-danger)" : "var(--semi-color-text-0)",
        }}
      >
        {value}
      </div>
    </Card>
  );
}

function zerosWarning(zeros: string[]) {
  if (!zeros.length) return null;
  return (
    <Space spacing={4} align="center">
      <IconAlertTriangle style={{ color: "var(--semi-color-warning)" }} />
      <Text type="warning" size="small">
        以下资源为 0：{zeros.join("、")}
      </Text>
    </Space>
  );
}

export default function ActivatorPage() {
  const isMobile = useIsMobile();

  // 激活配置（并发数 / 激活数量 target / 注册后自动激活）走 store。
  const activationConfig = useSettingsStore((s) => s.activationConfig);
  const isSavingActivationConfig = useSettingsStore((s) => s.isSavingActivationConfig);
  const loadActivationConfig = useSettingsStore((s) => s.loadActivationConfig);
  const setActivationConfigField = useSettingsStore((s) => s.setActivationConfigField);
  const setActivationAutoActivate = useSettingsStore((s) => s.setActivationAutoActivate);
  const saveActivationConfig = useSettingsStore((s) => s.saveActivationConfig);

  // 激活运行态 + 账号 + 资源。
  const [activation, setActivation] = useState<ActivationState | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [cdkAvailable, setCdkAvailable] = useState(0);
  const [activationBusy, setActivationBusy] = useState(false);

  useEffect(() => {
    if (!activationConfig) void loadActivationConfig();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let tick = 0;
    const pullActivation = () =>
      fetchActivation()
        .then(setActivation)
        .catch(() => {});
    const pullAccounts = () =>
      fetchAccounts({ page_size: 200 })
        .then((r) => setAccounts(r.items))
        .catch(() => {});
    const pullResources = () => {
      void fetchCdks({ page_size: 1 })
        .then((r) => setCdkAvailable(r.counts?.available ?? 0))
        .catch(() => {});
    };

    void pullActivation();
    void pullAccounts();
    pullResources();

    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      tick += 1;
      void pullActivation();
      if (tick % 2 === 0) void pullAccounts();
      if (tick % 5 === 0) pullResources();
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const act = activation?.activation;
  const activationRunning = !!act?.running;
  const activatingCount = act?.summary.activating ?? 0;
  const freeCount = act?.summary.free ?? 0;
  const pendingActivate = act?.summary.not_plus_by_type ?? 0;
  const activatedCount = act?.summary.plus_by_type ?? 0;

  const target = activationConfig?.target ?? 0;
  const concurrency = activationConfig?.concurrency ?? 3;
  const autoActivate = !!activationConfig?.auto_activate_after_register;

  const activationPercent = (() => {
    const total = act?.stats.total ?? 0;
    const done = act?.stats.done ?? 0;
    if (total <= 0) return 0;
    const p = Math.round((done / total) * 100);
    return Number.isFinite(p) ? Math.min(100, Math.max(0, p)) : 0;
  })();

  const activatingAccounts = useMemo(
    () => accounts.filter((a) => a.plus_status === "排队中" || a.plus_status === "激活中"),
    [accounts],
  );

  const handleStartActivation = async () => {
    if (freeCount === 0) {
      Toast.warning("可激活账号为 0（没有未激活账号）");
      return;
    }
    if (cdkAvailable === 0) {
      Toast.warning("可用 CDK 为 0，无法激活，请先在「CDK 管理」导入");
      return;
    }
    setActivationBusy(true);
    try {
      // 激活数量：target>0 则按 target，否则全部未激活账号（freeCount）。
      const limit = target > 0 ? target : freeCount;
      const s = await startActivation([], limit);
      setActivation(s);
      Toast.success(`已开始激活未激活账号（本轮上限 ${limit} 个）`);
    } catch (e) {
      Toast.error(e instanceof Error ? e.message : "启动激活失败");
    } finally {
      setActivationBusy(false);
    }
  };

  const handleStopActivation = async () => {
    setActivationBusy(true);
    try {
      const s = await stopActivation();
      setActivation(s);
      Toast.success("已请求停止激活");
    } catch (e) {
      Toast.error(e instanceof Error ? e.message : "停止激活失败");
    } finally {
      setActivationBusy(false);
    }
  };

  const handleClearActivationLogs = async () => {
    try {
      const s = await clearActivationLogs();
      setActivation(s);
      Toast.success("已清空激活日志");
    } catch (e) {
      Toast.error(e instanceof Error ? e.message : "清空激活日志失败");
    }
  };

  const handleSaveConfig = async () => {
    await saveActivationConfig();
  };

  const activationColumns = [
    { title: "邮箱", dataIndex: "email", render: (v: string | null) => v || <Text type="tertiary">—</Text> },
    { title: "激活进度", dataIndex: "plus_status", render: (_: unknown, a: Account) => renderPlusStatus(a) },
  ];

  const activationZeros = [
    freeCount === 0 ? "可激活账号" : null,
    cdkAvailable === 0 ? "可用 CDK" : null,
  ].filter(Boolean) as string[];

  return (
    <div style={{ maxWidth: 1080 }}>
      <Title heading={isMobile ? 4 : 3} style={{ marginBottom: 16 }}>
        激活器
      </Title>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: isMobile ? "repeat(2, 1fr)" : "repeat(4, minmax(0, 200px))",
          gap: 12,
          marginBottom: 16,
        }}
      >
        <OverviewCard label="待激活" value={pendingActivate} />
        <OverviewCard label="激活中" value={activatingCount} />
        <OverviewCard label="已激活" value={activatedCount} />
        <OverviewCard label="可用 CDK" value={cdkAvailable} danger={cdkAvailable === 0} />
      </div>

      <Card title="启动设置" headerExtraContent={zerosWarning(activationZeros)} style={{ marginBottom: 16 }}>
        <Space wrap spacing="loose" align="end">
          <div>
            <Text style={{ display: "block", marginBottom: 6 }}>并发数</Text>
            <InputNumber
              min={1}
              max={10}
              value={concurrency}
              onChange={(v) => setActivationConfigField("concurrency", String(v ?? 1))}
              disabled={activationRunning}
              style={{ width: 140 }}
            />
          </div>
          <div>
            <Text style={{ display: "block", marginBottom: 6 }}>激活数量（0=不限）</Text>
            <InputNumber
              min={0}
              value={target}
              onChange={(v) => setActivationConfigField("target", String(v ?? 0))}
              disabled={activationRunning}
              style={{ width: 140 }}
            />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <Text>注册成功后自动激活</Text>
            <Switch
              checked={autoActivate}
              onChange={(v) => setActivationAutoActivate(v)}
              disabled={activationRunning}
            />
          </div>
          <Button
            icon={<IconSave />}
            loading={isSavingActivationConfig}
            disabled={activationRunning}
            onClick={() => void handleSaveConfig()}
          >
            保存设置
          </Button>
          {activationRunning ? (
            <Popconfirm title="确认停止激活？" content="将中断正在进行的激活流程" onConfirm={() => void handleStopActivation()}>
              <Button theme="solid" type="danger" icon={<IconStop />} loading={activationBusy}>
                停止
              </Button>
            </Popconfirm>
          ) : (
            <Button
              theme="solid"
              type="primary"
              icon={<IconPlay />}
              loading={activationBusy}
              onClick={() => void handleStartActivation()}
            >
              启动激活
            </Button>
          )}
        </Space>
        <div style={{ marginTop: 12 }}>
          <Progress
            key={act?.stats.job_id || "idle"}
            percent={activationPercent}
            stroke={activationRunning ? "var(--semi-color-success)" : undefined}
            showInfo
          />
        </div>
      </Card>

      <Card title="正在激活的账号" style={{ marginBottom: 16 }}>
        {activatingCount > activatingAccounts.length ? (
          <Text type="tertiary" size="small" style={{ display: "block", marginBottom: 8 }}>
            另有 {activatingCount - activatingAccounts.length} 个进行中账号未在列表显示（列表上限 200）。
          </Text>
        ) : null}
        <Table
          dataSource={activatingAccounts}
          columns={activationColumns}
          rowKey="access_token"
          size="small"
          pagination={false}
          empty={<Empty description="当前没有正在激活的账号" />}
          scroll={{ y: 300 }}
        />
      </Card>

      <Card
        title="详细日志"
        headerExtraContent={
          <Button
            icon={<IconDelete />}
            size="small"
            type="tertiary"
            disabled={!act?.logs?.length}
            onClick={() => void handleClearActivationLogs()}
          >
            清空日志
          </Button>
        }
      >
        <LogView logs={act?.logs ?? []} />
      </Card>
    </div>
  );
}
