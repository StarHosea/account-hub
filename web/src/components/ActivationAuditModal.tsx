import { useEffect, useMemo, useState } from "react";
import { Modal, Spin, Typography, Tag, Empty } from "@douyinfe/semi-ui-19";
import { IconChevronDown, IconChevronUp, IconGlobe, IconTerminal, IconVerify } from "@douyinfe/semi-icons";
import clsx from "clsx";

import {
  fetchActivationAuditDetail,
  fetchLatestActivationAudit,
  type ActivationAuditEvent,
  type ActivationAuditRecord,
} from "@/lib/api";

const { Text } = Typography;

const OUTCOME_LABEL: Record<string, { text: string; color: string }> = {
  success: { text: "成功", color: "green" },
  failed: { text: "失败", color: "red" },
  review: { text: "待核查", color: "orange" },
  running: { text: "进行中", color: "blue" },
};

const EVENT_KIND_META = {
  log: { label: "日志", icon: IconTerminal, className: "activation-audit-event--log" },
  http: { label: "HTTP", icon: IconGlobe, className: "activation-audit-event--http" },
  plan_verify: { label: "核实", icon: IconVerify, className: "activation-audit-event--verify" },
} as const;

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function fmtTimeShort(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return iso;
  }
}

function maskSecret(s: string): string {
  const v = String(s || "");
  if (v.length <= 8) return v;
  return `${v.slice(0, 4)}…${v.slice(-4)}`;
}

function JsonBlock({ value, compact = false }: { value: unknown; compact?: boolean }) {
  if (value == null) return <Text type="tertiary">—</Text>;
  let text = "";
  try {
    text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    if (typeof value === "string") {
      try {
        text = JSON.stringify(JSON.parse(value), null, 2);
      } catch {
        /* keep raw string */
      }
    }
  } catch {
    text = String(value);
  }
  return (
    <pre
      className={clsx("activation-audit-json", compact && "activation-audit-json--compact")}
    >
      {text}
    </pre>
  );
}

function parseLogText(text: string): { title: string; payload?: unknown } {
  const raw = String(text || "").trim();
  const respMatch = raw.match(/^(.+?原始响应:)\s*([\s\S]+)$/);
  if (respMatch) {
    const payloadRaw = respMatch[2].trim();
    try {
      return { title: respMatch[1].trim(), payload: JSON.parse(payloadRaw) };
    } catch {
      return { title: respMatch[1].trim(), payload: payloadRaw };
    }
  }
  return { title: raw };
}

function phaseLabel(phase: string): string {
  const raw = String(phase || "http");
  if (raw === "cdk_submit") return "提交激活";
  if (raw.startsWith("cdk_status")) return "查询激活";
  if (raw.startsWith("cdk_retry")) return "重试激活";
  if (raw.startsWith("openai_")) return `OpenAI ${raw.slice("openai_".length)}`;
  return raw;
}

function httpStatusColor(status: number | null | undefined): string {
  if (status == null) return "grey";
  if (status >= 200 && status < 300) return "green";
  if (status >= 400) return "red";
  return "orange";
}

function logLevelClass(level?: string): string {
  const lv = String(level || "info").toLowerCase();
  if (lv === "red" || lv === "error" || lv === "danger") return "activation-audit-log--danger";
  if (lv === "yellow" || lv === "warn" || lv === "warning") return "activation-audit-log--warn";
  if (lv === "green" || lv === "success") return "activation-audit-log--success";
  return "";
}

function LogEventRow({ event }: { event: ActivationAuditEvent }) {
  const parsed = parseLogText(event.text || "");
  const emailPrefix = parsed.title.match(/^\[([^\]]+)\]\s*(.*)$/);
  const headline = emailPrefix ? emailPrefix[2] || emailPrefix[1] : parsed.title;
  const emailTag = emailPrefix?.[1];

  return (
    <div className={clsx("activation-audit-event-body-inner", logLevelClass(event.level))}>
      <div className="activation-audit-log-text">
        {emailTag ? <Tag size="small" color="grey" style={{ marginRight: 6 }}>{emailTag}</Tag> : null}
        <Text size="small">{headline}</Text>
      </div>
      {parsed.payload != null ? (
        <div className="activation-audit-log-payload">
          <Text type="tertiary" size="small">原始响应</Text>
          <JsonBlock value={parsed.payload} compact />
        </div>
      ) : null}
    </div>
  );
}

function HttpEventRow({ event }: { event: ActivationAuditEvent }) {
  const [open, setOpen] = useState(false);
  const statusColor = event.error ? "red" : httpStatusColor(event.http_status);
  const borderColor = event.retrying ? "orange" : statusColor;

  return (
    <div className="activation-audit-event-body-inner">
      <button
        type="button"
        className="activation-audit-http-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <div className="activation-audit-http-head-main">
          <Tag size="small" color={event.method === "POST" ? "blue" : "cyan"}>{event.method || "HTTP"}</Tag>
          <Text size="small" strong className="activation-audit-http-phase">{phaseLabel(String(event.phase || "http"))}</Text>
          <Text size="small" code className="activation-audit-http-path">{event.path || event.url || "—"}</Text>
          {event.http_status != null ? (
            <Tag size="small" color={statusColor as never}>HTTP {event.http_status}</Tag>
          ) : null}
          {event.attempt != null ? <Tag size="small" color="grey">第 {event.attempt} 次</Tag> : null}
          {event.retrying ? <Tag size="small" color="orange">将重试</Tag> : null}
        </div>
        <span className="activation-audit-http-toggle" aria-hidden>
          {open ? <IconChevronUp size="small" /> : <IconChevronDown size="small" />}
        </span>
      </button>
      {event.error ? (
        <Text type="danger" size="small" className="activation-audit-http-error">{event.error}</Text>
      ) : null}
      {open ? (
        <div className="activation-audit-http-detail" style={{ borderLeftColor: `var(--semi-color-${borderColor === "grey" ? "text-2" : borderColor})` }}>
          <div className="activation-audit-http-section">
            <Text type="tertiary" size="small">请求</Text>
            <JsonBlock value={event.request} />
          </div>
          <div className="activation-audit-http-section">
            <Text type="tertiary" size="small">响应</Text>
            <JsonBlock value={event.response} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function PlanVerifyEventRow({ event }: { event: ActivationAuditEvent }) {
  return (
    <div className="activation-audit-event-body-inner">
      <Text size="small" strong>{event.phase || "套餐核实"}</Text>
      {event.tier ? <Text size="small" style={{ display: "block", marginTop: 4 }}>档位：{event.tier}</Text> : null}
      {event.error ? <Text type="danger" size="small" style={{ display: "block", marginTop: 4 }}>{event.error}</Text> : null}
    </div>
  );
}

function EventRow({ event }: { event: ActivationAuditEvent }) {
  const meta = EVENT_KIND_META[event.kind] ?? EVENT_KIND_META.log;
  const Icon = meta.icon;

  return (
    <div className={clsx("activation-audit-event", meta.className)}>
      <div className="activation-audit-event-rail">
        <span className="activation-audit-event-dot">
          <Icon size="small" />
        </span>
      </div>
      <div className="activation-audit-event-card">
        <div className="activation-audit-event-head">
          <Tag size="small" color={event.kind === "http" ? "blue" : event.kind === "plan_verify" ? "purple" : "grey"}>
            {meta.label}
          </Tag>
          <Text type="tertiary" size="small" title={fmtTime(event.time)}>
            {fmtTimeShort(event.time)}
          </Text>
        </div>
        {event.kind === "log" ? <LogEventRow event={event} /> : null}
        {event.kind === "http" ? <HttpEventRow event={event} /> : null}
        {event.kind === "plan_verify" ? <PlanVerifyEventRow event={event} /> : null}
      </div>
    </div>
  );
}

function EventLegend({ events }: { events: ActivationAuditEvent[] }) {
  const counts = useMemo(() => {
    const log = events.filter((e) => e.kind === "log").length;
    const http = events.filter((e) => e.kind === "http").length;
    const verify = events.filter((e) => e.kind === "plan_verify").length;
    return { log, http, verify, total: events.length };
  }, [events]);

  return (
    <div className="activation-audit-legend">
      <span className="activation-audit-legend-item">
        <Tag size="small" color="grey">日志</Tag>
        <Text size="small" type="tertiary">{counts.log}</Text>
      </span>
      <span className="activation-audit-legend-item">
        <Tag size="small" color="blue">HTTP</Tag>
        <Text size="small" type="tertiary">{counts.http}</Text>
      </span>
      <span className="activation-audit-legend-item">
        <Tag size="small" color="purple">核实</Tag>
        <Text size="small" type="tertiary">{counts.verify}</Text>
      </span>
      <Text size="small" type="tertiary">共 {counts.total} 条</Text>
    </div>
  );
}

export function ActivationAuditDetail({ record }: { record: ActivationAuditRecord }) {
  const outcome = OUTCOME_LABEL[record.outcome] ?? { text: record.outcome, color: "grey" };
  const events = record.events ?? [];

  return (
    <div className="activation-audit-detail">
      <div className="activation-audit-summary">
        <div className="activation-audit-summary-row">
          <Text type="tertiary" size="small">邮箱</Text>
          <Text size="small">{record.email || "—"}</Text>
        </div>
        <div className="activation-audit-summary-row">
          <Text type="tertiary" size="small">结果</Text>
          <Tag color={outcome.color as never}>{outcome.text}</Tag>
        </div>
        <div className="activation-audit-summary-row activation-audit-summary-row--full">
          <Text type="tertiary" size="small">摘要</Text>
          <Text size="small">{record.summary || "—"}</Text>
        </div>
        <div className="activation-audit-summary-row">
          <Text type="tertiary" size="small">CDK</Text>
          <Text size="small">
            {record.cdk ? maskSecret(record.cdk) : "—"}
            {record.cdk_type ? ` (${record.cdk_type})` : ""}
          </Text>
        </div>
        <div className="activation-audit-summary-row">
          <Text type="tertiary" size="small">CDK 已消耗</Text>
          <Text size="small">{record.cdk_consumed ? "是" : "否"}</Text>
        </div>
        <div className="activation-audit-summary-row activation-audit-summary-row--full">
          <Text type="tertiary" size="small">时间</Text>
          <Text type="tertiary" size="small">
            {fmtTime(record.started_at)}
            {record.finished_at ? ` → ${fmtTime(record.finished_at)}` : ""}
          </Text>
        </div>
      </div>

      <div className="activation-audit-chain-header">
        <Text strong>完整链路</Text>
        <EventLegend events={events} />
      </div>
      <Text type="tertiary" size="small" className="activation-audit-chain-hint">
        日志为运行过程输出；HTTP 为实际请求/响应（点击展开详情）。原始响应类日志已自动格式化 JSON。
      </Text>

      <div className="activation-audit-timeline">
        {events.length ? (
          events.map((event, i) => <EventRow key={i} event={event} />)
        ) : (
          <Empty description="无事件" />
        )}
      </div>
    </div>
  );
}

type Props = {
  visible: boolean;
  auditId?: string | null;
  accessToken?: string | null;
  email?: string | null;
  onClose: () => void;
};

export default function ActivationAuditModal({ visible, auditId, accessToken, email, onClose }: Props) {
  const [loading, setLoading] = useState(false);
  const [record, setRecord] = useState<ActivationAuditRecord | null>(null);

  useEffect(() => {
    if (!visible) {
      setRecord(null);
      return;
    }
    setLoading(true);
    const loader = auditId
      ? fetchActivationAuditDetail(auditId)
      : fetchLatestActivationAudit({ accessToken: accessToken || undefined, email: email || undefined });
    void loader
      .then((r) => setRecord(r.item))
      .catch(() => setRecord(null))
      .finally(() => setLoading(false));
  }, [visible, auditId, accessToken, email]);

  return (
    <Modal
      title="完整激活日志"
      visible={visible}
      onCancel={onClose}
      footer={null}
      width={920}
      style={{ maxWidth: "96vw" }}
      bodyStyle={{ paddingTop: 12 }}
    >
      {loading ? (
        <div style={{ textAlign: "center", padding: 32 }}><Spin /></div>
      ) : record ? (
        <ActivationAuditDetail record={record} />
      ) : (
        <Empty description="未找到激活审计记录" />
      )}
    </Modal>
  );
}
