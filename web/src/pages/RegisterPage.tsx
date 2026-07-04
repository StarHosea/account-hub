import { useEffect, useRef, useState, useCallback } from "react";
import {
  Card,
  Button,
  InputNumber,
  Tabs,
  TabPane,
  Badge,
  Progress,
  Typography,
  Toast,
  Space,
  Popconfirm,
  Table,
  Empty,
  Input,
} from "@douyinfe/semi-ui-19";
import { IconPlay, IconStop, IconDelete, IconAlertTriangle, IconDownload, IconRefresh, IconSearch } from "@douyinfe/semi-icons";

import {
  clearRegisterLogs,
  fetchMailboxes,
  fetchCdks,
  fetchActivation,
  fetchRegisterAbnormal,
  deleteRegisterAbnormal,
  fetchRegisterAbnormalExportText,
  type RegisterProgressItem,
  type RegisterAbnormal,
} from "@/lib/api";
import { useSettingsStore } from "@/store/settings";
import { useIsMobile } from "@/lib/use-is-mobile";

const { Title, Text } = Typography;

const LEVEL_COLOR: Record<string, string> = {
  red: "var(--semi-color-danger)",
  green: "var(--semi-color-success)",
  yellow: "var(--semi-color-warning)",
};

type LogEntry = { time: string; text: string; level: string };

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString();
  } catch {
    return iso;
  }
}

/** 详细日志面板：等宽字体 + 级别配色 + 新日志自动滚到底。 */
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

export default function RegisterPage() {
  const isMobile = useIsMobile();

  // 注册：读全局 store（AppLayout 的 useRegisterStream 已把注册机 SSE 实时喂入）。
  const registerConfig = useSettingsStore((s) => s.registerConfig);
  const isSavingRegister = useSettingsStore((s) => s.isSavingRegister);
  const setRegisterTotal = useSettingsStore((s) => s.setRegisterTotal);
  const setRegisterThreads = useSettingsStore((s) => s.setRegisterThreads);
  const toggleRegister = useSettingsStore((s) => s.toggleRegister);
  const loadRegister = useSettingsStore((s) => s.loadRegister);
  const setRegisterConfig = useSettingsStore((s) => s.setRegisterConfig);

  const [mailboxUnused, setMailboxUnused] = useState(0);
  const [cdkAvailable, setCdkAvailable] = useState(0);
  const [autoActivate, setAutoActivate] = useState(false);
  const [activeTab, setActiveTab] = useState("monitor");

  // 异常清单
  const [abnormal, setAbnormal] = useState<RegisterAbnormal[]>([]);
  const [abnormalTotal, setAbnormalTotal] = useState(0);
  const [abnormalQuery, setAbnormalQuery] = useState("");
  const [abnormalLoading, setAbnormalLoading] = useState(false);
  const [selectedAbnormal, setSelectedAbnormal] = useState<string[]>([]);

  useEffect(() => {
    if (!registerConfig) void loadRegister(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadAbnormal = useCallback(async (q = abnormalQuery) => {
    setAbnormalLoading(true);
    try {
      const r = await fetchRegisterAbnormal({ q: q || undefined, page_size: 200 });
      setAbnormal(r.items);
      setAbnormalTotal(r.total);
    } catch {
      // 静默：SSE/轮询会再拉
    } finally {
      setAbnormalLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [abnormalQuery]);

  // 资源概览 + 异常清单轮询。
  useEffect(() => {
    const pullResources = () => {
      void fetchMailboxes({ page_size: 1 })
        .then((r) => setMailboxUnused(r.stats?.unused ?? 0))
        .catch(() => {});
      void fetchCdks({ page_size: 1 })
        .then((r) => setCdkAvailable(r.counts?.available ?? 0))
        .catch(() => {});
      void fetchActivation()
        .then((s) => setAutoActivate(!!s.config.auto_activate_after_register))
        .catch(() => {});
    };
    pullResources();
    void loadAbnormal();
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      pullResources();
      void loadAbnormal();
    }, 5000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const registerRunning = !!registerConfig?.enabled;
  const registerStats = registerConfig?.stats;
  const registerInProgress = registerStats?.running ?? 0;
  const registerLogs = registerConfig?.logs ?? [];
  const registerProgress = registerConfig?.progress ?? [];

  const handleStartRegister = async () => {
    if (mailboxUnused === 0) {
      Toast.warning("可用邮箱为 0，无法开始注册，请先在「邮箱管理」导入");
      return;
    }
    if (autoActivate && cdkAvailable === 0) {
      Toast.warning("已开启「注册后自动激活」但可用 CDK 为 0，注册会照常进行，但无法自动激活");
    }
    await toggleRegister();
  };

  const handleStopRegister = async () => {
    await toggleRegister();
  };

  const handleClearRegisterLogs = async () => {
    try {
      const data = await clearRegisterLogs();
      setRegisterConfig(data.register);
      Toast.success("已清空注册日志");
    } catch (e) {
      Toast.error(e instanceof Error ? e.message : "清空注册日志失败");
    }
  };

  const handleDeleteAbnormal = async () => {
    if (!selectedAbnormal.length) return;
    try {
      await deleteRegisterAbnormal(selectedAbnormal);
      setSelectedAbnormal([]);
      await loadAbnormal();
      Toast.success("已删除所选异常账号");
    } catch (e) {
      Toast.error(e instanceof Error ? e.message : "删除失败");
    }
  };

  const handleExportAbnormal = async () => {
    try {
      const text = await fetchRegisterAbnormalExportText();
      const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `register-abnormal-${Date.now()}.txt`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (e) {
      Toast.error(e instanceof Error ? e.message : "导出失败");
    }
  };

  const registerColumns = [
    {
      title: "邮箱",
      dataIndex: "email",
      width: 260,
      render: (v: string, r: RegisterProgressItem) => (v ? v : <Text type="tertiary">任务 {r.index}</Text>),
    },
    {
      title: "注册详细状态",
      dataIndex: "step",
      render: (v: string, r: RegisterProgressItem) => (
        <Text size="small" style={{ color: LEVEL_COLOR[r.level] || undefined }}>
          {v || "—"}
        </Text>
      ),
    },
  ];

  const abnormalColumns = [
    { title: "邮箱", dataIndex: "email", width: 240 },
    {
      title: "取件地址",
      dataIndex: "fetch_url",
      render: (v: string) =>
        v ? (
          <Text ellipsis={{ showTooltip: true }} style={{ maxWidth: 320 }}>
            {v}
          </Text>
        ) : (
          <Text type="tertiary">—</Text>
        ),
    },
    {
      title: "注册失败原因",
      dataIndex: "reason",
      render: (v: string) => (
        <Text type="danger" size="small" ellipsis={{ showTooltip: true }} style={{ maxWidth: 320 }}>
          {v || "—"}
        </Text>
      ),
    },
    {
      title: "时间",
      dataIndex: "created_at",
      width: 160,
      render: (v: string) => <Text type="tertiary" size="small">{v ? new Date(v).toLocaleString() : "—"}</Text>,
    },
  ];

  const tabLabel = (text: string, count: number) => (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      {text}
      {count > 0 ? <Badge count={count} overflowCount={99} type="primary" /> : null}
    </span>
  );

  const registerZeros = [
    mailboxUnused === 0 ? "可用邮箱" : null,
    autoActivate && cdkAvailable === 0 ? "可用 CDK（自动激活需要）" : null,
  ].filter(Boolean) as string[];

  return (
    <div style={{ maxWidth: 1080 }}>
      <Title heading={isMobile ? 4 : 3} style={{ marginBottom: 16 }}>
        注册机
      </Title>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: isMobile ? "repeat(2, 1fr)" : "repeat(4, minmax(0, 200px))",
          gap: 12,
          marginBottom: 16,
        }}
      >
        <OverviewCard label="待注册（可用邮箱）" value={mailboxUnused} danger={mailboxUnused === 0} />
        <OverviewCard label="注册中" value={registerInProgress} />
        <OverviewCard label="成功" value={registerStats?.success ?? 0} />
        <OverviewCard label="失败" value={registerStats?.fail ?? 0} />
      </div>

      <Card title="启动设置" headerExtraContent={zerosWarning(registerZeros)} style={{ marginBottom: 16 }}>
        <Space wrap spacing="loose" align="end">
          <div>
            <Text style={{ display: "block", marginBottom: 6 }}>注册数量</Text>
            <InputNumber
              min={1}
              value={registerConfig?.total ?? 1}
              onChange={(v) => setRegisterTotal(String(v ?? 1))}
              disabled={registerRunning}
              style={{ width: 140 }}
            />
          </div>
          <div>
            <Text style={{ display: "block", marginBottom: 6 }}>并发数</Text>
            <InputNumber
              min={1}
              value={registerConfig?.threads ?? 1}
              onChange={(v) => setRegisterThreads(String(v ?? 1))}
              disabled={registerRunning}
              style={{ width: 140 }}
            />
          </div>
          {registerRunning ? (
            <Popconfirm title="确认停止注册？" content="将中断正在进行的注册流程" onConfirm={() => void handleStopRegister()}>
              <Button theme="solid" type="danger" icon={<IconStop />} loading={isSavingRegister}>
                停止
              </Button>
            </Popconfirm>
          ) : (
            <Button
              theme="solid"
              type="primary"
              icon={<IconPlay />}
              loading={isSavingRegister}
              onClick={() => void handleStartRegister()}
            >
              启动注册
            </Button>
          )}
        </Space>
        <div style={{ marginTop: 12 }}>
          <Progress
            percent={
              registerConfig && registerConfig.total > 0
                ? Math.min(100, Math.round(((registerStats?.success ?? 0) / registerConfig.total) * 100))
                : 0
            }
            stroke={registerRunning ? "var(--semi-color-success)" : undefined}
            showInfo
          />
        </div>
      </Card>

      <Tabs activeKey={activeTab} onChange={setActiveTab} type="line">
        <TabPane tab={tabLabel("注册监控", registerInProgress)} itemKey="monitor">
          <div style={{ paddingTop: 12 }}>
            <Card title="正在注册账号" style={{ marginBottom: 16 }}>
              <Table
                dataSource={registerProgress}
                columns={registerColumns}
                rowKey="index"
                size="small"
                pagination={false}
                empty={<Empty description="当前没有正在注册的账号" />}
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
                  disabled={!registerLogs.length}
                  onClick={() => void handleClearRegisterLogs()}
                >
                  清空日志
                </Button>
              }
            >
              <LogView logs={registerLogs} />
            </Card>
          </div>
        </TabPane>

        <TabPane tab={tabLabel("异常清单", abnormalTotal)} itemKey="abnormal">
          <div style={{ paddingTop: 12 }}>
            <Card
              title={`注册机异常账号清单（${abnormalTotal}）`}
              headerExtraContent={
                <Space>
                  <Input
                    prefix={<IconSearch />}
                    placeholder="搜索邮箱 / 原因"
                    value={abnormalQuery}
                    onChange={(v) => setAbnormalQuery(v)}
                    onEnterPress={() => void loadAbnormal()}
                    style={{ width: 200 }}
                    showClear
                  />
                  <Button icon={<IconRefresh />} size="small" onClick={() => void loadAbnormal()}>
                    刷新
                  </Button>
                  <Button icon={<IconDownload />} size="small" onClick={() => void handleExportAbnormal()}>
                    导出
                  </Button>
                  <Popconfirm
                    title="确认删除所选异常账号？"
                    content={`将删除 ${selectedAbnormal.length} 条记录`}
                    onConfirm={() => void handleDeleteAbnormal()}
                  >
                    <Button icon={<IconDelete />} size="small" type="danger" disabled={!selectedAbnormal.length}>
                      删除
                    </Button>
                  </Popconfirm>
                </Space>
              }
            >
              <Table
                loading={abnormalLoading}
                dataSource={abnormal}
                columns={abnormalColumns}
                rowKey="email"
                size="small"
                pagination={false}
                rowSelection={{
                  selectedRowKeys: selectedAbnormal,
                  onChange: (keys) => setSelectedAbnormal((keys ?? []) as string[]),
                }}
                empty={<Empty description="暂无异常账号" />}
                scroll={{ y: 360 }}
              />
            </Card>
          </div>
        </TabPane>
      </Tabs>
    </div>
  );
}
