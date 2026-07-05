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
  Tooltip,
} from "@douyinfe/semi-ui-19";
import { IconPlay, IconStop, IconDelete, IconDownload, IconRefresh, IconSearch, IconMail, IconLink } from "@douyinfe/semi-icons";
import type { ColumnProps } from "@douyinfe/semi-ui-19/lib/es/table";

import {
  clearRegisterLogs,
  fetchMailboxes,
  fetchCdks,
  fetchActivation,
  fetchRegisterAbnormal,
  deleteRegisterAbnormal,
  fetchRegisterAbnormalExportText,
  startRegister,
  type RegisterProgressItem,
  type RegisterAbnormal,
} from "@/lib/api";
import ResourceZeroWarning from "@/components/ResourceZeroWarning";
import { useSettingsStore } from "@/store/settings";
import { copyToClipboard } from "@/lib/clipboard";
import { useIsMobile } from "@/lib/use-is-mobile";
import { navRef } from "@/constants/nav";

const { Text } = Typography;

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
        height: 360,
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
        <Text type="tertiary">暂无日志。启动注册后，取邮箱、启动/关闭指纹浏览器、注册每一步都会实时显示在这里。</Text>
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

export default function RegisterPage() {
  const isMobile = useIsMobile();

  // 注册：读全局 store（AppLayout 的 useRegisterStream 已把注册机 SSE 实时喂入）。
  const registerConfig = useSettingsStore((s) => s.registerConfig);
  const isSavingRegister = useSettingsStore((s) => s.isSavingRegister);
  const setRegisterTotal = useSettingsStore((s) => s.setRegisterTotal);
  const setRegisterThreads = useSettingsStore((s) => s.setRegisterThreads);
  const stopRegisterRun = useSettingsStore((s) => s.stopRegisterRun);
  const saveRegister = useSettingsStore((s) => s.saveRegister);
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
  const activeBrowsers = registerStats?.active_browsers ?? 0;
  const registerLogs = registerConfig?.logs ?? [];
  const registerProgress = registerConfig?.progress ?? [];

  useEffect(() => {
    if (registerRunning) setActiveTab("monitor");
  }, [registerRunning]);

  const handleStartRegister = async () => {
    if (autoActivate && cdkAvailable === 0) {
      Toast.warning("已开启「注册后自动激活」但可用 CDK 为 0，注册会照常进行，但无法自动激活");
    }
    try {
      await saveRegister({ silent: true });
      const data = await startRegister();
      setRegisterConfig(data.register);
      Toast.success("注册任务已启动，将自动从邮箱池领取可用邮箱");
    } catch (e) {
      Toast.error(e instanceof Error ? e.message : "启动注册失败");
    }
  };

  const handleStopRegister = async () => {
    await stopRegisterRun();
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

  const abnormalColumns: ColumnProps<RegisterAbnormal>[] = [
    { title: "邮箱", dataIndex: "email", width: 240 },
    {
      title: "注册失败原因",
      dataIndex: "reason",
      render: (v: string) => (
        <Text type="danger" size="small" ellipsis={{ showTooltip: true }} style={{ maxWidth: 420 }}>
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
    {
      title: "操作",
      width: 96,
      fixed: "right",
      render: (_: unknown, row: RegisterAbnormal) => (
        <Space>
          <Button
            size="small"
            theme="borderless"
            icon={<IconLink />}
            title="复制诊断链接（给本地 AI）"
            onClick={() => {
              const url = `${window.location.origin}/api/register/diag/brief?email=${encodeURIComponent(row.email)}`;
              void copyToClipboard(url, "诊断链接");
            }}
          />
          <Button
            size="small"
            theme="borderless"
            icon={<IconMail />}
            title={row.fetch_url ? "收邮件（打开邮箱链接）" : "无邮箱链接"}
            disabled={!row.fetch_url}
            onClick={() => row.fetch_url && window.open(row.fetch_url, "_blank", "noopener")}
          />
        </Space>
      ),
    },
  ];

  const tabLabel = (text: string, count: number) => (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      {text}
      {count > 0 ? <Badge count={count} overflowCount={99} type="primary" /> : null}
    </span>
  );

  const registerResourceHints = [
    mailboxUnused === 0 ? `可用邮箱为空，请先在${navRef("mailboxes")}中导入` : null,
    autoActivate && cdkAvailable === 0
      ? `已开启「注册后自动激活」，但激活码为空，请先在${navRef("cdks")}中导入`
      : null,
  ].filter(Boolean) as string[];
  const startRegisterDisabled = mailboxUnused === 0;

  return (
    <div style={{ maxWidth: 1080 }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: isMobile ? "repeat(2, 1fr)" : "repeat(5, minmax(0, 1fr))",
          gap: 12,
          marginBottom: 16,
        }}
      >
        <OverviewCard label="可用邮箱" value={mailboxUnused} danger={mailboxUnused === 0} />
        <OverviewCard label="进行中" value={registerInProgress} />
        <OverviewCard label="活跃浏览器" value={activeBrowsers} danger={activeBrowsers > 0} />
        <OverviewCard label="成功" value={registerStats?.success ?? 0} />
        <OverviewCard label="失败" value={registerStats?.fail ?? 0} />
      </div>

      <Card title="任务配置" style={{ marginBottom: 16 }}>
        <ResourceZeroWarning hints={registerResourceHints} />
        <Space wrap spacing="loose" align="end">
          <div>
            <Text style={{ display: "block", marginBottom: 6 }}>目标数量</Text>
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
            <Popconfirm
              title="确认停止注册？"
              content="将立即终止所有在途指纹浏览器，并安全结束注册任务。"
              onConfirm={() => void handleStopRegister()}
            >
              <Button theme="solid" type="danger" icon={<IconStop />} loading={isSavingRegister}>
                停止注册
              </Button>
            </Popconfirm>
          ) : startRegisterDisabled ? (
            <Tooltip content="可用邮箱为空">
              <span style={{ display: "inline-block" }}>
                <Button theme="solid" type="primary" icon={<IconPlay />} loading={isSavingRegister} disabled>
                  启动注册
                </Button>
              </span>
            </Tooltip>
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
        <TabPane tab={tabLabel("运行监控", registerInProgress)} itemKey="monitor">
          <div style={{ paddingTop: 12 }}>
            <Card title="进行中任务" style={{ marginBottom: 16 }}>
              <Table
                dataSource={registerProgress}
                columns={registerColumns}
                rowKey="index"
                size="small"
                pagination={false}
                empty={<Empty description="当前没有进行中的注册任务" />}
                scroll={{ y: 300 }}
              />
            </Card>

            <Card
              title="详细日志"
              headerExtraContent={
                <Text type="tertiary" size="small">
                  实时更新 · 含浏览器启停
                </Text>
              }
              style={{ marginBottom: 0 }}
              bodyStyle={{ paddingTop: 8 }}
            >
              <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
                <Button
                  icon={<IconDelete />}
                  size="small"
                  type="tertiary"
                  disabled={!registerLogs.length}
                  onClick={() => void handleClearRegisterLogs()}
                >
                  清空日志
                </Button>
              </div>
              <LogView logs={registerLogs} />
            </Card>
          </div>
        </TabPane>

        <TabPane tab={tabLabel("异常清单", abnormalTotal)} itemKey="abnormal">
          <div style={{ paddingTop: 12 }}>
            <Card
              title={`异常账号清单（${abnormalTotal}）`}
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
