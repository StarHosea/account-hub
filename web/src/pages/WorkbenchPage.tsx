import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
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
  Tag,
  Spin,
  Empty,
} from "@douyinfe/semi-ui-19";
import { IconPlay, IconStop, IconDelete, IconAlertTriangle } from "@douyinfe/semi-icons";

import {
  fetchActivation,
  startActivation,
  stopActivation,
  clearActivationLogs,
  clearRegisterLogs,
  fetchAccounts,
  fetchMailboxes,
  fetchCdks,
  type ActivationState,
  type Account,
  type PlusStatus,
  type RegisterProgressItem,
} from "@/lib/api";
import { useSettingsStore } from "@/store/settings";
import { useIsMobile } from "@/lib/use-is-mobile";

const { Title, Text } = Typography;

// 日志级别配色，与后端注册机/激活引擎产出的 level 对齐（沿用 DashboardPage 的写法）。
const LEVEL_COLOR: Record<string, string> = {
  red: "var(--semi-color-danger)",
  green: "var(--semi-color-success)",
  yellow: "var(--semi-color-warning)",
};

// 激活状态标签配色（与号池页 PLUS_TAG_COLOR 保持一致）。
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

/** 详细日志面板：等宽字体 + 级别配色 + 新日志自动滚到底。注册/激活日志同构，共用。 */
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

/** 单账号激活状态：状态标签 + 进行中转圈 + 尝试次数 + 最新进度 + 使用中的 CDK。 */
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

// 汇总小卡：值为 0 时用危险色高亮，直观提示「不足」。
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

// 资源为 0 的告警，放到「启动设置」卡片标题右侧（替代原先横幅）。
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

export default function WorkbenchPage() {
  const navigate = useNavigate();
  const isMobile = useIsMobile();

  // 注册：直接读全局 store（AppLayout 的 useRegisterStream 已把注册机 SSE 实时喂入）。
  const registerConfig = useSettingsStore((s) => s.registerConfig);
  const isSavingRegister = useSettingsStore((s) => s.isSavingRegister);
  const setRegisterTotal = useSettingsStore((s) => s.setRegisterTotal);
  const setRegisterThreads = useSettingsStore((s) => s.setRegisterThreads);
  const toggleRegister = useSettingsStore((s) => s.toggleRegister);
  const loadRegister = useSettingsStore((s) => s.loadRegister);
  const setRegisterConfig = useSettingsStore((s) => s.setRegisterConfig);

  // 激活 + 资源：本地轮询。
  const [activation, setActivation] = useState<ActivationState | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [mailboxUnused, setMailboxUnused] = useState(0);
  const [cdkAvailable, setCdkAvailable] = useState(0);
  const [activationBusy, setActivationBusy] = useState(false);
  const [activationCount, setActivationCount] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState("register");

  // 首次进入：确保注册配置已加载（SSE 未就绪时兜底），并立即拉一次激活/资源。
  useEffect(() => {
    if (!registerConfig) void loadRegister(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 轮询：激活 1s、账号列表 2s、资源概览 5s（单个定时器按 tick 分频，页面不可见时跳过）。
  useEffect(() => {
    let tick = 0;
    const pullActivation = () =>
      fetchActivation()
        .then(setActivation)
        .catch(() => {});
    // 拉全部账号（上限 200）：最近注册账号按 created_at 排序、正在激活账号按 plus_status 过滤，均客户端派生。
    const pullAccounts = () =>
      fetchAccounts({ page_size: 200 })
        .then((r) => setAccounts(r.items))
        .catch(() => {});
    const pullResources = () => {
      void fetchMailboxes({ page_size: 1 })
        .then((r) => setMailboxUnused(r.stats?.unused ?? 0))
        .catch(() => {});
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

  const registerRunning = !!registerConfig?.enabled;
  const registerStats = registerConfig?.stats;
  const registerInProgress = registerStats?.running ?? 0;
  const registerLogs = registerConfig?.logs ?? [];

  const act = activation?.activation;
  const activationRunning = !!act?.running;
  const activatingCount = act?.summary.activating ?? 0;
  // 引擎口径（plus_status==未激活）：用于「启动激活」的可激活判断、数量上限与默认值。
  const freeCount = act?.summary.free ?? 0;
  // 卡片口径（按真实套餐 type 判定）：待激活=注册成功但还不是 Plus；已激活=已是 Plus。
  const pendingActivate = act?.summary.not_plus_by_type ?? 0;
  const activatedCount = act?.summary.plus_by_type ?? 0;
  const autoActivate = !!activation?.config.auto_activate_after_register;

  // 激活进度：无任务（total=0）或数值异常时按 0 处理，避免进度条残留上一轮的满格。
  const activationPercent = (() => {
    const total = act?.stats.total ?? 0;
    const done = act?.stats.done ?? 0;
    if (total <= 0) return 0;
    const p = Math.round((done / total) * 100);
    return Number.isFinite(p) ? Math.min(100, Math.max(0, p)) : 0;
  })();

  // 正在激活的账号（排队中 / 激活中）。列表来自 inactive 分页（上限 200），
  // 若真实进行中数量超过列表长度，下方给出提示。
  const activatingAccounts = useMemo(
    () => accounts.filter((a) => a.plus_status === "排队中" || a.plus_status === "激活中"),
    [accounts],
  );
  // 正在注册的账号：注册机按任务号推送的实时进度（仅进行中）。
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
      // 激活数量：未填写时默认全部未激活账号（activationCount 为 null 回退 freeCount）。
      const limit = activationCount ?? freeCount;
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

  const handleClearRegisterLogs = async () => {
    try {
      const data = await clearRegisterLogs();
      setRegisterConfig(data.register); // 立即反映清空，SSE 后续也会推送空日志
      Toast.success("已清空注册日志");
    } catch (e) {
      Toast.error(e instanceof Error ? e.message : "清空注册日志失败");
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

  // 正在注册账号：邮箱 + 注册的详细步骤（数据来自注册机实时进度，仅进行中的任务）。
  const registerColumns = [
    {
      title: "邮箱",
      dataIndex: "email",
      width: 260,
      render: (v: string, r: RegisterProgressItem) =>
        v ? v : <Text type="tertiary">任务 {r.index}</Text>,
    },
    {
      title: "注册详细状态",
      dataIndex: "step",
      render: (v: string, r: RegisterProgressItem) => (
        <Space spacing={6} align="center">
          <Spin size="small" />
          <Text size="small" style={{ color: LEVEL_COLOR[r.level] || undefined }}>
            {v || "—"}
          </Text>
        </Space>
      ),
    },
  ];

  const activationColumns = [
    { title: "邮箱", dataIndex: "email", render: (v: string | null) => v || <Text type="tertiary">—</Text> },
    { title: "激活进度", dataIndex: "plus_status", render: (_: unknown, a: Account) => renderPlusStatus(a) },
  ];

  // TAB 标签：文字 + 执行中数量角标（0 不显示）。
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
  const activationZeros = [
    freeCount === 0 ? "可激活账号" : null,
    cdkAvailable === 0 ? "可用 CDK" : null,
  ].filter(Boolean) as string[];

  return (
    <div style={{ maxWidth: 1080 }}>
      <Title heading={isMobile ? 4 : 3} style={{ marginBottom: 16 }}>
        工作台
      </Title>

      {/* 顶部统计：待注册(可用邮箱) / 注册中 / 待激活(注册成功但套餐非 Plus) / 已激活(套餐已是 Plus) */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: isMobile ? "repeat(2, 1fr)" : "repeat(4, minmax(0, 200px))",
          gap: 12,
          marginBottom: 16,
        }}
      >
        <OverviewCard label="待注册" value={mailboxUnused} danger={mailboxUnused === 0} />
        <OverviewCard label="注册中" value={registerInProgress} />
        <OverviewCard label="待激活" value={pendingActivate} />
        <OverviewCard label="已激活" value={activatedCount} />
      </div>

      <Tabs activeKey={activeTab} onChange={setActiveTab} type="line">
        {/* ── 注册 ── */}
        <TabPane tab={tabLabel("注册", registerInProgress)} itemKey="register">
          <div style={{ paddingTop: 12 }}>
            <Card
              title="启动设置"
              headerExtraContent={zerosWarning(registerZeros)}
              style={{ marginBottom: 16 }}
            >
              <Space wrap spacing="loose" align="end">
                <div>
                  <Text style={{ display: "block", marginBottom: 6 }}>目标注册数量</Text>
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
                    content="将中断正在进行的注册流程"
                    onConfirm={() => void handleStopRegister()}
                  >
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
                <Button theme="borderless" onClick={() => navigate("/settings")}>
                  更多注册配置
                </Button>
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

        {/* ── 激活 ── */}
        <TabPane tab={tabLabel("激活", activatingCount)} itemKey="activation">
          <div style={{ paddingTop: 12 }}>
            <Card
              title="启动设置"
              headerExtraContent={zerosWarning(activationZeros)}
              style={{ marginBottom: 16 }}
            >
              <Space wrap align="end">
                <div>
                  <Text style={{ display: "block", marginBottom: 6 }}>激活数量</Text>
                  <InputNumber
                    min={1}
                    max={freeCount || undefined}
                    value={activationCount ?? freeCount}
                    onChange={(v) => setActivationCount(Math.max(1, Number(v ?? 1)))}
                    disabled={activationRunning}
                    style={{ width: 140 }}
                  />
                </div>
                {activationRunning ? (
                  <Popconfirm
                    title="确认停止激活？"
                    content="将中断正在进行的激活流程"
                    onConfirm={() => void handleStopActivation()}
                  >
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
                  disabled={!(act?.logs?.length)}
                  onClick={() => void handleClearActivationLogs()}
                >
                  清空日志
                </Button>
              }
            >
              <LogView logs={act?.logs ?? []} />
            </Card>
          </div>
        </TabPane>
      </Tabs>
    </div>
  );
}
