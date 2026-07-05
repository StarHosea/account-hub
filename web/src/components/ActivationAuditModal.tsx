import { useEffect, useState } from "react";
import { Modal, Spin, Typography, Tag, Empty, Collapse } from "@douyinfe/semi-ui-19";

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

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function maskSecret(s: string): string {
  const v = String(s || "");
  if (v.length <= 8) return v;
  return `${v.slice(0, 4)}…${v.slice(-4)}`;
}

function JsonBlock({ value }: { value: unknown }) {
  if (value == null) return <Text type="tertiary">—</Text>;
  let text = "";
  try {
    text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  return (
    <pre
      style={{
        margin: 0,
        padding: 10,
        borderRadius: 6,
        background: "var(--semi-color-fill-0)",
        fontSize: 11,
        lineHeight: "18px",
        overflow: "auto",
        maxHeight: 360,
        whiteSpace: "pre-wrap",
        wordBreak: "break-all",
      }}
    >
      {text}
    </pre>
  );
}

function phaseLabel(phase: string): string {
  const raw = String(phase || "http");
  if (raw === "cdk_submit") return "提交激活";
  if (raw.startsWith("cdk_status")) return "查询激活";
  if (raw.startsWith("openai_")) return `OpenAI ${raw.slice("openai_".length)}`;
  return raw;
}

function httpEventTitle(event: ActivationAuditEvent): string {
  const parts = [
    phaseLabel(String(event.phase || "http")),
    event.method,
    event.path,
    event.http_status != null ? `HTTP ${event.http_status}` : null,
    event.attempt != null ? `第 ${event.attempt} 次` : null,
    event.retrying ? "将重试" : null,
  ].filter(Boolean);
  return parts.join(" · ");
}

function httpEventColor(event: ActivationAuditEvent): string {
  if (event.retrying) return "orange";
  if (event.error) return "red";
  const status = event.http_status;
  if (status != null && status >= 200 && status < 300) return "green";
  if (status != null && status >= 400) return "red";
  return "blue";
}

function HttpEventRow({ event, index }: { event: ActivationAuditEvent; index: number }) {
  return (
    <Collapse style={{ marginBottom: 8 }} defaultActiveKey={[]}>
      <Collapse.Panel
        header={
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <Text size="small" type="tertiary">{fmtTime(event.time)}</Text>
            <Tag size="small" color={httpEventColor(event) as never}>{httpEventTitle(event)}</Tag>
          </span>
        }
        itemKey={`http-${index}`}
      >
        <Text type="tertiary" size="small" style={{ display: "block", marginBottom: 4 }}>请求参数</Text>
        <JsonBlock value={event.request} />
        <Text type="tertiary" size="small" style={{ display: "block", margin: "10px 0 4px" }}>响应参数</Text>
        <JsonBlock value={event.response} />
        {event.error ? (
          <Text type="danger" size="small" style={{ display: "block", marginTop: 8 }}>{event.error}</Text>
        ) : null}
      </Collapse.Panel>
    </Collapse>
  );
}

function EventRow({ event, index }: { event: ActivationAuditEvent; index: number }) {
  if (event.kind === "log") {
    return (
      <div style={{ marginBottom: 10 }}>
        <Text type="tertiary" size="small">{fmtTime(event.time)} </Text>
        <Text size="small">{event.text}</Text>
      </div>
    );
  }
  if (event.kind === "plan_verify") {
    return (
      <Collapse style={{ marginBottom: 8 }} defaultActiveKey={[]}>
        <Collapse.Panel
          header={
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <Text size="small" type="tertiary">{fmtTime(event.time)}</Text>
              <Tag size="small" color="purple">套餐核实 · {event.phase}</Tag>
            </span>
          }
          itemKey={`verify-${index}`}
        >
          {event.tier ? <Text size="small" style={{ display: "block" }}>档位：{event.tier}</Text> : null}
          {event.error ? <Text type="danger" size="small" style={{ display: "block" }}>{event.error}</Text> : null}
        </Collapse.Panel>
      </Collapse>
    );
  }
  return <HttpEventRow event={event} index={index} />;
}

export function ActivationAuditDetail({ record }: { record: ActivationAuditRecord }) {
  const outcome = OUTCOME_LABEL[record.outcome] ?? { text: record.outcome, color: "grey" };
  const httpCount = (record.events ?? []).filter((e) => e.kind === "http").length;
  return (
    <div>
      <div style={{ display: "grid", gap: 6, marginBottom: 12 }}>
        <Text><Text type="tertiary">邮箱：</Text>{record.email || "—"}</Text>
        <Text><Text type="tertiary">结果：</Text><Tag color={outcome.color as never}>{outcome.text}</Tag></Text>
        <Text><Text type="tertiary">摘要：</Text>{record.summary || "—"}</Text>
        <Text><Text type="tertiary">CDK：</Text>{record.cdk ? maskSecret(record.cdk) : "—"} {record.cdk_type ? `(${record.cdk_type})` : ""}</Text>
        <Text><Text type="tertiary">CDK 已消耗：</Text>{record.cdk_consumed ? "是" : "否"}</Text>
        <Text type="tertiary" size="small">开始 {fmtTime(record.started_at)}{record.finished_at ? ` · 结束 ${fmtTime(record.finished_at)}` : ""}</Text>
      </div>
      <Text strong style={{ display: "block", marginBottom: 4 }}>
        完整链路（{record.events?.length ?? 0} 条，含 {httpCount} 次 HTTP 请求）
      </Text>
      <Text type="tertiary" size="small" style={{ display: "block", marginBottom: 8 }}>
        持久化于独立激活审计表；含 CDK 兑换、OpenAI 套餐核实（/me、accounts/check 等）及浏览器续期登录的完整请求/响应。
      </Text>
      <div style={{ maxHeight: 520, overflow: "auto" }}>
        {record.events?.length ? (
          record.events.map((event, i) => <EventRow key={i} event={event} index={i} />)
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
      width={860}
      style={{ maxWidth: "96vw" }}
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
