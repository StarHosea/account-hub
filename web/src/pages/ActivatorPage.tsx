import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  Card,
  Button,
  InputNumber,
  Progress,
  Typography,
  Toast,
  Space,
  Popconfirm,
  Table,
  Badge,
  Tag,
  Spin,
  Empty,
  Tooltip,
  Banner,
} from "@douyinfe/semi-ui-19";
import { IconPlay, IconStop, IconDelete } from "@douyinfe/semi-icons";

import {
  fetchActivation,
  startActivation,
  stopActivation,
  clearActivationLogs,
  fetchAccounts,
  fetchCdks,
  fetchActivationAudit,
  type ActivationState,
  type Account,
  type PlusStatus,
} from "@/lib/api";
import { useSettingsStore } from "@/store/settings";
import ResourceZeroWarning from "@/components/ResourceZeroWarning";
import { useIsMobile } from "@/lib/use-is-mobile";
import { NAV_LABELS, navRef } from "@/constants/nav";

const { Text } = Typography;

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
        logs.map((l, i) => {
          const isSkip = l.text.includes("跳过");
          return (
            <div key={i} style={{ color: LEVEL_COLOR[l.level] || "var(--semi-color-text-1)" }}>
              <span style={{ color: "var(--semi-color-text-2)" }}>{fmtTime(l.time)} </span>
              {isSkip ? (
                <Tag color="orange" size="small" style={{ marginRight: 6, verticalAlign: "middle" }}>
                  跳过
                </Tag>
              ) : null}
              {l.text}
            </div>
          );
        })
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

export default function ActivatorPage() {
  const isMobile = useIsMobile();

  const activationConfig = useSettingsStore((s) => s.activationConfig);
  const isSavingActivationConfig = useSettingsStore((s) => s.isSavingActivationConfig);
  const loadActivationConfig = useSettingsStore((s) => s.loadActivationConfig);
  const setActivationConfigField = useSettingsStore((s) => s.setActivationConfigField);
  const saveActivationConfig = useSettingsStore((s) => s.saveActivationConfig);

  const [activation, setActivation] = useState<ActivationState | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [cdkAvailable, setCdkAvailable] = useState(0);
  const [activationBusy, setActivationBusy] = useState(false);
  const [auditStats, setAuditStats] = useState({ failed: 0, review: 0 });

  const loadAuditStats = useCallback(() => {
    void fetchActivationAudit({ abnormal_only: true, page_size: 1 })
      .then((r) => setAuditStats({ failed: r.stats.failed, review: r.stats.review }))
      .catch(() => {});
  }, []);

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
      fetchAccounts({ activation: "activating", page_size: 200 })
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
    loadAuditStats();

    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      tick += 1;
      void pullActivation();
      if (tick % 2 === 0) void pullAccounts();
      if (tick % 5 === 0) pullResources();
      if (tick % 5 === 0) loadAuditStats();
    }, 1000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const act = activation?.activation;
  const activationRunning = !!act?.running;
  const activatingCount = act?.summary.activating ?? 0;
  const pendingActivate = act?.summary.pending ?? 0;
  const activatedCount = act?.summary.plus_by_type ?? 0;

  const target = activationConfig?.target ?? 0;
  const concurrency = activationConfig?.concurrency ?? 10;

  const activationPercent = (() => {
    const total = act?.stats.total ?? 0;
    const done = act?.stats.done ?? 0;
    if (total <= 0) return 0;
    const p = Math.round((done / total) * 100);
    return Number.isFinite(p) ? Math.min(100, Math.max(0, p)) : 0;
  })();

  const jobSuccess = act?.stats.success ?? 0;
  const jobFail = act?.stats.fail ?? 0;
  const jobSkipped = act?.stats.skipped ?? 0;
  const jobReview = act?.stats.review ?? 0;
  const jobClaiming = act?.stats.claiming ?? 0;
  const showJobStats = activationRunning || jobSuccess > 0 || jobFail > 0 || jobSkipped > 0 || jobReview > 0;

  const activatingAccounts = useMemo(
    () => accounts.filter((a) => a.plus_status === "排队中" || a.plus_status === "激活中"),
    [accounts],
  );

  const abnormalCount = auditStats.failed + auditStats.review;

  const handleStartActivation = async () => {
    if (cdkAvailable === 0) {
      Toast.warning(`可用激活码为 0，无法激活，请先在${navRef("cdks")}中导入`);
      return;
    }
    setActivationBusy(true);
    try {
      await saveActivationConfig({ silent: true });
      const limit = target > 0 ? target : undefined;
      const s = await startActivation(undefined, limit, undefined, concurrency);
      setActivation(s);
      Toast.success(limit ? `已开始激活，最多 ${limit} 个账号` : "已开始激活全部可激活账号");
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

  const activationColumns = [
    { title: "邮箱", dataIndex: "email", render: (v: string | null) => v || <Text type="tertiary">—</Text> },
    { title: "激活进度", dataIndex: "plus_status", render: (_: unknown, a: Account) => renderPlusStatus(a) },
  ];

  const activationResourceHints = [
    pendingActivate === 0 ? `待激活账号为空，请先完成${navRef("register")}或手动导入` : null,
    cdkAvailable === 0 ? `可用激活码为空，请先在${navRef("cdks")}中导入` : null,
  ].filter(Boolean) as string[];
  const startActivationDisabled = pendingActivate === 0 || cdkAvailable === 0;
  const startActivationDisabledTip = [
    pendingActivate === 0 ? "待激活账号为空" : null,
    cdkAvailable === 0 ? "可用激活码为空" : null,
  ]
    .filter(Boolean)
    .join("，");

  return (
    <div style={{ maxWidth: 1080 }}>
      {abnormalCount > 0 ? (
        <Banner
          fullMode={false}
          type="warning"
          closeIcon={null}
          style={{ marginBottom: 16 }}
          description={
            <span>
              有 {auditStats.failed} 个激活失败、{auditStats.review} 个待核查，请前往
              <Link to="/activation-audit" style={{ margin: "0 4px" }}>
                {NAV_LABELS.activationAudit}
              </Link>
              查看详情与处理。
            </span>
          }
        />
      ) : null}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: isMobile ? "repeat(2, 1fr)" : "repeat(4, minmax(0, 200px))",
          gap: 12,
          marginBottom: 16,
        }}
      >
        <OverviewCard label="待激活" value={pendingActivate} />
        <OverviewCard label="进行中" value={activatingCount} />
        <OverviewCard label="已激活" value={activatedCount} />
        <OverviewCard label="可用激活码" value={cdkAvailable} danger={cdkAvailable === 0} />
      </div>

      <Card title="任务控制" style={{ marginBottom: 16 }}>
        <ResourceZeroWarning hints={activationResourceHints} />
        <Space wrap spacing="loose" align="end">
          <div>
            <Text style={{ display: "block", marginBottom: 6 }}>本轮激活上限（0 表示不限）</Text>
            <InputNumber
              min={0}
              value={target}
              onChange={(v) => setActivationConfigField("target", String(v ?? 0))}
              disabled={activationRunning}
              style={{ width: 180 }}
            />
          </div>
          {activationRunning ? (
            <Popconfirm title="确认停止激活？" content="将中断正在进行的激活流程" onConfirm={() => void handleStopActivation()}>
              <Button theme="solid" type="danger" icon={<IconStop />} loading={activationBusy}>
                停止激活
              </Button>
            </Popconfirm>
          ) : startActivationDisabled ? (
            <Tooltip content={startActivationDisabledTip}>
              <span style={{ display: "inline-block" }}>
                <Button theme="solid" type="primary" icon={<IconPlay />} loading={activationBusy || isSavingActivationConfig} disabled>
                  启动激活
                </Button>
              </span>
            </Tooltip>
          ) : (
            <Button
              theme="solid"
              type="primary"
              icon={<IconPlay />}
              loading={activationBusy || isSavingActivationConfig}
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
          {showJobStats ? (
            <Space wrap spacing={12} style={{ marginTop: 8 }}>
              <Text type="tertiary" size="small">
                本轮成功 <Text strong>{jobSuccess}</Text>
              </Text>
              <Text type="tertiary" size="small">
                失败 <Text strong>{jobFail}</Text>
              </Text>
              {jobSkipped > 0 ? (
                <Text type="tertiary" size="small">
                  跳过重复 <Text strong style={{ color: "var(--semi-color-warning)" }}>{jobSkipped}</Text>
                </Text>
              ) : null}
              {jobReview > 0 ? (
                <Text type="tertiary" size="small">
                  转人工核查 <Text strong style={{ color: "var(--semi-color-warning)" }}>{jobReview}</Text>
                </Text>
              ) : null}
              {jobClaiming > 0 ? (
                <Text type="tertiary" size="small">
                  占用中账号 <Text strong style={{ color: "var(--semi-color-primary)" }}>{jobClaiming}</Text>
                </Text>
              ) : null}
            </Space>
          ) : null}
          {activationRunning ? (
            <Text type="tertiary" size="small" style={{ display: "block", marginTop: 6 }}>
              同一免费账号同时只允许一条激活链路；重复派发会被跳过，不会重复消耗 CDK。并发、轮询与重试策略请在
              <Link to="/settings#settings-activation" style={{ margin: "0 4px" }}>
                系统设置 → 激活设置
              </Link>
              中配置。
            </Text>
          ) : (
            <Text type="tertiary" size="small" style={{ display: "block", marginTop: 6 }}>
              并发、轮询间隔、大兜底时长、同卡重试等参数请在
              <Link to="/settings#settings-activation" style={{ margin: "0 4px" }}>
                系统设置 → 激活设置
              </Link>
              中配置（当前并发 {concurrency}）。
            </Text>
          )}
        </div>
      </Card>

      <Card
        title={
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            运行监控
            {activatingCount > 0 ? <Badge count={activatingCount} overflowCount={99} type="primary" /> : null}
          </span>
        }
        style={{ marginBottom: 16 }}
      >
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
          empty={<Empty description="当前没有进行中的激活任务" />}
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
