import { useEffect, useState } from "react";
import { Card, Button, Typography, Toast, Space, Tag, RadioGroup, Radio, Spin } from "@douyinfe/semi-ui-19";
import { IconCopy, IconSend, IconTickCircle, IconClose, IconRefresh, IconClock } from "@douyinfe/semi-icons";

import {
  fetchDispatchSummary,
  acquireDispatch,
  dispatchAction,
  type DispatchKind,
  type DispatchItem,
  type DispatchSummary,
} from "@/lib/api";
import { useIsMobile } from "@/lib/use-is-mobile";

const { Title, Text } = Typography;

const EMPTY_SUMMARY: DispatchSummary = { account_available: 0, phone_available: 0 };

async function copy(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text);
    Toast.success(`${label}已复制`);
  } catch {
    Toast.error("复制失败，请检查浏览器剪贴板权限");
  }
}

export default function DispatchPage() {
  const isMobile = useIsMobile();
  const [kind, setKind] = useState<DispatchKind>("account");
  const [item, setItem] = useState<DispatchItem | null>(null);
  const [summary, setSummary] = useState<DispatchSummary>(EMPTY_SUMMARY);
  const [busy, setBusy] = useState(false);

  const refreshSummary = async () => {
    try {
      setSummary(await fetchDispatchSummary());
    } catch {
      /* 忽略汇总拉取失败 */
    }
  };

  useEffect(() => {
    void refreshSummary();
  }, []);

  const availableOf = (k: DispatchKind) => (k === "account" ? summary.account_available : summary.phone_available);

  // 切换发号类型：先释放当前预占，避免占着不放。
  const switchKind = async (next: DispatchKind) => {
    if (next === kind) return;
    if (item) void dispatchAction(kind, item.id, "release");
    setItem(null);
    setKind(next);
    void refreshSummary();
  };

  const acquire = async (releaseId?: string) => {
    setBusy(true);
    try {
      const res = await acquireDispatch(kind, releaseId);
      setSummary(res.summary);
      setItem(res.item);
      if (!res.item) Toast.warning(kind === "account" ? "暂无可发的已激活账号" : "暂无可发的手机号（可能都在冷却/已用尽）");
    } catch (e) {
      Toast.error(e instanceof Error ? e.message : "发号失败");
    } finally {
      setBusy(false);
    }
  };

  const act = async (action: "checkout" | "cooldown" | "invalid") => {
    if (!item) return;
    setBusy(true);
    try {
      const res = await dispatchAction(kind, item.id, action);
      setSummary(res.summary);
      setItem(null);
      Toast.success(action === "checkout" ? "已出库" : action === "cooldown" ? "已置冷却" : "已标记无效");
    } catch (e) {
      Toast.error(e instanceof Error ? e.message : "操作失败");
    } finally {
      setBusy(false);
    }
  };

  // 当前号不可用 → 释放并取下一个，不消耗当前号。
  const next = () => void acquire(item?.id);

  const copyAll = () => {
    if (!item) return;
    const text = item.fields.map((f) => `${f.label}: ${f.value}`).join("\n");
    void copy(text, "全部信息");
  };

  const kindLabel = kind === "account" ? "Plus 账号" : "手机号";

  return (
    <div style={{ maxWidth: 720, margin: "0 auto" }}>
      <div
        style={{
          display: "flex",
          flexDirection: isMobile ? "column" : "row",
          alignItems: isMobile ? "stretch" : "center",
          justifyContent: "space-between",
          gap: 12,
          marginBottom: 16,
        }}
      >
        <Title heading={isMobile ? 4 : 3} style={{ margin: 0 }}>
          发号管理
        </Title>
        <Button icon={<IconRefresh />} onClick={() => void refreshSummary()}>
          刷新可用
        </Button>
      </div>

      {/* 发号类型 */}
      <Card bodyStyle={{ padding: 16 }} style={{ marginBottom: 16 }}>
        <RadioGroup
          type="button"
          value={kind}
          onChange={(e) => void switchKind(e.target.value as DispatchKind)}
          style={{ width: isMobile ? "100%" : undefined }}
        >
          <Radio value="account" style={isMobile ? { flex: 1, textAlign: "center" } : undefined}>
            Plus 账号发号（剩 {summary.account_available}）
          </Radio>
          <Radio value="phone" style={isMobile ? { flex: 1, textAlign: "center" } : undefined}>
            手机发号（剩 {summary.phone_available}）
          </Radio>
        </RadioGroup>

        <div style={{ marginTop: 14 }}>
          <Button
            theme="solid"
            type="primary"
            size="large"
            icon={<IconSend />}
            block
            loading={busy && !item}
            disabled={availableOf(kind) <= 0 && !item}
            onClick={() => void acquire(item?.id)}
          >
            {item ? "重新发一个" : `发一个${kindLabel}`}
          </Button>
          <Text type="tertiary" size="small" style={{ display: "block", marginTop: 8, textAlign: "center" }}>
            按{kind === "account" ? "激活时间" : "导入时间"}最老优先，发号即锁定，确认出库前其他人不会拿到同一个号
          </Text>
        </div>
      </Card>

      {/* 发出的号卡片 */}
      {item ? (
        <Card
          bodyStyle={{ padding: 16 }}
          title={
            <Space>
              <Tag color="green" type="light">
                {kindLabel}
              </Tag>
              <Text strong style={{ fontFamily: "monospace" }}>
                {item.title}
              </Text>
            </Space>
          }
          headerExtraContent={
            <Button size="small" icon={<IconCopy />} onClick={copyAll}>
              整体复制
            </Button>
          }
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {item.fields.map((f) => (
              <div
                key={f.label}
                style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, minWidth: 0 }}
              >
                <Text type="tertiary" size="small" style={{ flexShrink: 0, width: 76 }}>
                  {f.label}
                </Text>
                <Text
                  ellipsis={{ showTooltip: true }}
                  style={{ flex: 1, fontFamily: "monospace", fontSize: 13 }}
                  onClick={() => void copy(f.value, f.label)}
                >
                  {f.value}
                </Text>
                <Button size="small" theme="borderless" icon={<IconCopy />} onClick={() => void copy(f.value, f.label)} />
              </div>
            ))}
          </div>

          {/* 标记动作 */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 16 }}>
            <Button
              theme="solid"
              type="primary"
              icon={<IconTickCircle />}
              loading={busy}
              style={{ flex: 1, minWidth: 96 }}
              onClick={() => void act("checkout")}
            >
              出库
            </Button>
            {kind === "phone" ? (
              <Button icon={<IconClock />} loading={busy} style={{ flex: 1, minWidth: 96 }} onClick={() => void act("cooldown")}>
                冷却
              </Button>
            ) : null}
            <Button
              type="danger"
              icon={<IconClose />}
              loading={busy}
              style={{ flex: 1, minWidth: 96 }}
              onClick={() => void act("invalid")}
            >
              无效
            </Button>
            <Button icon={<IconRefresh />} loading={busy} style={{ flex: 1, minWidth: 96 }} onClick={next}>
              不可用，下一个
            </Button>
          </div>
          {kind === "phone" && item.max_uses ? (
            <Text type="tertiary" size="small" style={{ display: "block", marginTop: 10 }}>
              出库后该号使用次数 {(item.used_count ?? 0) + 1}/{item.max_uses}，并自动冷却 1 小时
            </Text>
          ) : null}
        </Card>
      ) : (
        <Card bodyStyle={{ padding: 32, textAlign: "center" }}>
          {busy ? <Spin /> : <Text type="tertiary">点击上方「发一个{kindLabel}」开始</Text>}
        </Card>
      )}
    </div>
  );
}
