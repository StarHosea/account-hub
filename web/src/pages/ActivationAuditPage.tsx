import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Card,
  Typography,
  Table,
  Input,
  Button,
  Space,
  Tag,
  Empty,
  Select,
  Popconfirm,
  Toast,
  Banner,
  Tooltip,
} from "@douyinfe/semi-ui-19";
import { IconSearch, IconRefresh, IconDelete } from "@douyinfe/semi-icons";

import {
  deleteActivationAudit,
  fetchActivationAudit,
  type ActivationAuditSummary,
} from "@/lib/api";
import ActivationAuditModal from "@/components/ActivationAuditModal";
import { useIsMobile } from "@/lib/use-is-mobile";
const { Text } = Typography;

const OUTCOME_OPTIONS = [
  { value: "abnormal", label: "异常（失败+待核查）" },
  { value: "failed", label: "激活失败" },
  { value: "review", label: "待核查" },
  { value: "success", label: "成功" },
  { value: "all", label: "全部" },
];

function maskSecret(s: string): string {
  const v = String(s || "");
  if (v.length <= 8) return v;
  return `${v.slice(0, 4)}…${v.slice(-4)}`;
}

function outcomeLabel(outcome: string): string {
  if (outcome === "failed") return "激活失败";
  if (outcome === "review") return "待核查";
  if (outcome === "success") return "成功";
  return outcome || "—";
}

function outcomeColor(outcome: string): string {
  if (outcome === "failed") return "red";
  if (outcome === "review") return "orange";
  if (outcome === "success") return "green";
  return "grey";
}

function EllipsisCell({
  text,
  maxWidth,
  type,
  style,
}: {
  text: string;
  maxWidth: number;
  type?: "primary" | "secondary" | "tertiary" | "quaternary" | "warning" | "danger" | "success";
  style?: React.CSSProperties;
}) {
  const content = text || "—";
  if (content === "—") {
    return <Text type="tertiary" size="small">—</Text>;
  }
  return (
    <Tooltip content={content}>
      <Text
        type={type}
        size="small"
        style={{
          maxWidth,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          display: "block",
          ...style,
        }}
      >
        {content}
      </Text>
    </Tooltip>
  );
}

export default function ActivationAuditPage() {
  const isMobile = useIsMobile();
  const [searchParams, setSearchParams] = useSearchParams();
  const [items, setItems] = useState<ActivationAuditSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState({ total: 0, accounts: 0, failed: 0, review: 0, success: 0 });
  const [query, setQuery] = useState("");
  const [outcome, setOutcome] = useState(() => searchParams.get("outcome") || "abnormal");
  const [loading, setLoading] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [auditModal, setAuditModal] = useState<{ auditId: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const abnormalOnly = outcome === "abnormal";
      const outcomeFilter = outcome === "abnormal" || outcome === "all" ? undefined : outcome;
      const r = await fetchActivationAudit({
        q: query || undefined,
        outcome: outcomeFilter,
        abnormal_only: abnormalOnly,
        page_size: 200,
      });
      setItems(r.items);
      setTotal(r.total);
      setStats(r.stats);
    } finally {
      setLoading(false);
    }
  }, [query, outcome]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 5000);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    if (outcome === "abnormal") next.delete("outcome");
    else next.set("outcome", outcome);
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outcome]);

  const selectedRows = useMemo(() => {
    const selected = new Set(selectedIds);
    return items.filter((row) => selected.has(row.id));
  }, [items, selectedIds]);

  const selectedEmails = useMemo(
    () => [...new Set(selectedRows.map((row) => row.email).filter(Boolean))],
    [selectedRows],
  );

  const selectedFailedTokens = useMemo(() => {
    const tokens = selectedRows
      .filter((row) => row.outcome === "failed" && row.access_token)
      .map((row) => row.access_token);
    return [...new Set(tokens)];
  }, [selectedRows]);

  const handleDeleteSelected = async () => {
    if (!selectedEmails.length) return;
    try {
      const data = await deleteActivationAudit({
        emails: selectedEmails,
        access_tokens: selectedFailedTokens,
        delete_accounts: selectedFailedTokens.length > 0,
      });
      setSelectedIds([]);
      await load();
      const auditRemoved = data.removed ?? 0;
      const accountsRemoved = data.accounts_removed ?? 0;
      if (accountsRemoved > 0) {
        Toast.success(`已删除 ${auditRemoved} 条审计记录，并移除 ${accountsRemoved} 个账号`);
      } else {
        Toast.success(`已删除 ${auditRemoved} 条审计记录`);
      }
    } catch (e) {
      Toast.error(e instanceof Error ? e.message : "删除失败");
    }
  };

  const columns = useMemo(
    () => [
      { title: "时间", dataIndex: "started_at", width: 170, render: (v: string) => <Text type="tertiary" size="small">{v ? new Date(v).toLocaleString() : "—"}</Text> },
      {
        title: "邮箱",
        dataIndex: "email",
        width: 200,
        render: (v: string) => <EllipsisCell text={v} maxWidth={180} />,
      },
      {
        title: "尝试",
        dataIndex: "attempt_count",
        width: 70,
        render: (v: number | undefined) => (
          <Text type="tertiary" size="small">{v && v > 1 ? `${v} 次` : "—"}</Text>
        ),
      },
      {
        title: "结果",
        dataIndex: "outcome",
        width: 100,
        render: (v: string) => <Tag color={outcomeColor(v) as never} size="small">{outcomeLabel(v)}</Tag>,
      },
      {
        title: "摘要",
        dataIndex: "summary",
        width: 220,
        render: (v: string) => <EllipsisCell text={v} maxWidth={200} />,
      },
      {
        title: "CDK",
        dataIndex: "cdk",
        width: 130,
        render: (v: string | null, row: ActivationAuditSummary) =>
          v ? (
            <EllipsisCell
              text={`${maskSecret(v)}${row.cdk_type ? ` (${row.cdk_type})` : ""}`}
              maxWidth={110}
              type="tertiary"
              style={{ fontFamily: "monospace" }}
            />
          ) : (
            <Text type="tertiary">—</Text>
          ),
      },
      {
        title: "事件",
        dataIndex: "event_count",
        width: 70,
        render: (v: number) => <Text type="tertiary" size="small">{v ?? 0}</Text>,
      },
      {
        title: "操作",
        width: 120,
        render: (_: unknown, row: ActivationAuditSummary) => (
          <Button size="small" onClick={() => setAuditModal({ auditId: row.id })}>查看日志</Button>
        ),
      },
    ],
    [],
  );

  return (
    <div style={{ maxWidth: 1200 }}>
      <Banner
        fullMode={false}
        type="info"
        closeIcon={null}
        style={{ marginBottom: 16 }}
        description={
          <Text size="small">
            激活失败与待核查账号均在此统一记录；列表按邮箱聚合，展示最近一次结果（多次尝试会累计计数）。完整请求/响应见「查看日志」。
          </Text>
        }
      />

      <div
        style={{
          display: "grid",
          gridTemplateColumns: isMobile ? "repeat(2, 1fr)" : "repeat(4, minmax(0, 160px))",
          gap: 12,
          marginBottom: 16,
        }}
      >
        <Card bodyStyle={{ padding: 16 }}>
          <Text type="tertiary" size="small">激活失败</Text>
          <div style={{ fontSize: 24, fontWeight: 600, marginTop: 4, color: "var(--semi-color-danger)" }}>{stats.failed}</div>
        </Card>
        <Card bodyStyle={{ padding: 16 }}>
          <Text type="tertiary" size="small">待核查</Text>
          <div style={{ fontSize: 24, fontWeight: 600, marginTop: 4, color: "var(--semi-color-warning)" }}>{stats.review}</div>
        </Card>
        <Card bodyStyle={{ padding: 16 }}>
          <Text type="tertiary" size="small">成功</Text>
          <div style={{ fontSize: 24, fontWeight: 600, marginTop: 4, color: "var(--semi-color-success)" }}>{stats.success}</div>
        </Card>
        <Card bodyStyle={{ padding: 16 }}>
          <Text type="tertiary" size="small">账号数</Text>
          <div style={{ fontSize: 24, fontWeight: 600, marginTop: 4 }}>{stats.accounts}</div>
          {stats.total > stats.accounts ? (
            <Text type="tertiary" size="small">历史尝试 {stats.total} 次</Text>
          ) : null}
        </Card>
      </div>

      <Card
        title={`激活审计（${total} 个账号）`}
        headerExtraContent={
          <Space>
            <Input
              prefix={<IconSearch />}
              placeholder="搜索邮箱 / 摘要 / CDK"
              value={query}
              onChange={setQuery}
              onEnterPress={() => void load()}
              style={{ width: 220 }}
              showClear
            />
            <Select
              value={outcome}
              onChange={(v) => setOutcome(String(v ?? "abnormal"))}
              optionList={OUTCOME_OPTIONS}
              style={{ width: 170 }}
            />
            <Button icon={<IconRefresh />} size="small" onClick={() => void load()}>刷新</Button>
            <Popconfirm
              title="确认删除所选记录？"
              content={`将删除 ${selectedEmails.length} 个邮箱的审计记录${selectedFailedTokens.length ? `，并尝试移除 ${selectedFailedTokens.length} 个失败账号` : ""}`}
              onConfirm={() => void handleDeleteSelected()}
            >
              <Button icon={<IconDelete />} size="small" type="danger" disabled={!selectedEmails.length}>
                删除
              </Button>
            </Popconfirm>
          </Space>
        }
      >
        <Table
          className="activation-audit-table"
          loading={loading}
          dataSource={items}
          columns={columns}
          rowKey="id"
          size="small"
          tableLayout="fixed"
          pagination={false}
          rowSelection={{
            selectedRowKeys: selectedIds,
            onChange: (keys) => setSelectedIds((keys ?? []) as string[]),
            getCheckboxProps: (row) => ({
              disabled: row.outcome === "success",
            }),
          }}
          empty={<Empty description="暂无激活审计记录" />}
          scroll={{ x: 1060, y: 560 }}
        />
      </Card>
      <ActivationAuditModal
        visible={!!auditModal}
        auditId={auditModal?.auditId}
        onClose={() => setAuditModal(null)}
      />
    </div>
  );
}
