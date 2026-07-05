import { useEffect, useState } from "react";
import { Card, Button, Typography, Toast, Space, Tag, RadioGroup, Radio, Spin, Popconfirm, Modal, Input, Checkbox, Table } from "@douyinfe/semi-ui-19";
import { IconCopy, IconSend, IconTickCircle, IconClose, IconRefresh, IconClock } from "@douyinfe/semi-icons";

import {
  fetchDispatchSummary,
  fetchDispatchAccounts,
  acquireDispatch,
  dispatchAction,
  dispatchCheckout,
  type DispatchKind,
  type DispatchItem,
  type DispatchSummary,
} from "@/lib/api";
import { useIsMobile } from "@/lib/use-is-mobile";
import { copyToClipboard as copy } from "@/lib/clipboard";
const { Text } = Typography;

const EMPTY_SUMMARY: DispatchSummary = { account_available: 0, phone_available: 0 };

export default function DispatchPage() {
  const isMobile = useIsMobile();
  const [kind, setKind] = useState<DispatchKind>("account");
  const [item, setItem] = useState<DispatchItem | null>(null);
  const [summary, setSummary] = useState<DispatchSummary>(EMPTY_SUMMARY);
  const [busy, setBusy] = useState(false);
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [customer, setCustomer] = useState("");
  const [wechat, setWechat] = useState("");
  const [xianyu, setXianyu] = useState("");
  const [plan, setPlan] = useState("");
  const [note, setNote] = useState("");
  const [dispatchAccounts, setDispatchAccounts] = useState<Array<{ email: string | null; access_token: string; activated_at?: string | null }>>([]);
  const [selectedToken, setSelectedToken] = useState("");
  const [relatedPhone, setRelatedPhone] = useState("");
  const [relatedAccountToken, setRelatedAccountToken] = useState("");

  const refreshSummary = async () => {
    try {
      setSummary(await fetchDispatchSummary());
    } catch {
      /* 忽略汇总拉取失败 */
    }
  };

  const refreshDispatchAccounts = async () => {
    try {
      const data = await fetchDispatchAccounts();
      setDispatchAccounts(data.items);
      setSummary(data.summary);
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    void refreshSummary();
    void refreshDispatchAccounts();
  }, []);

  const [pairCheckout, setPairCheckout] = useState(false);

  const availableOf = (k: DispatchKind) => (k === "account" ? summary.account_available : summary.phone_available);

  // 切换发号类型：先释放当前预占，避免占着不放。
  const switchKind = async (next: DispatchKind) => {
    if (next === kind) return;
    if (item) {
      void dispatchAction(kind, item.id, "release").catch((e) => {
        Toast.error(e instanceof Error ? `释放当前号失败：${e.message}` : "释放当前号失败");
      });
    }
    setItem(null);
    setKind(next);
    void refreshSummary();
  };

  const acquire = async (releaseId?: string, token?: string) => {
    setBusy(true);
    try {
      const pick = token || selectedToken;
      if (kind === "account" && !pick) {
        Toast.warning("请先选择要出库的 Plus 账号");
        return;
      }
      const res = await acquireDispatch(kind, releaseId, pick || undefined);
      setSummary(res.summary);
      setItem(res.item);
      if (!res.item) Toast.warning(kind === "account" ? "暂无可发的 Plus 账号" : "暂无可发的手机号（可能都在冷却/已用尽）");
    } catch (e) {
      Toast.error(e instanceof Error ? e.message : "发号失败");
    } finally {
      setBusy(false);
    }
  };

  const act = async (action: "cooldown" | "invalid") => {
    if (!item) return;
    setBusy(true);
    try {
      const res = await dispatchAction(kind, item.id, action);
      setSummary(res.summary);
      setItem(null);
      Toast.success(action === "cooldown" ? "已置冷却" : "已标记无效");
    } catch (e) {
      Toast.error(e instanceof Error ? e.message : "操作失败");
    } finally {
      setBusy(false);
    }
  };

  // 当前号不可用 → 释放并取下一个，不消耗当前号。
  const next = () => void acquire(item?.id);

  const openCheckout = () => {
    if (!item) return;
    setCustomer("");
    setWechat("");
    setXianyu("");
    setPlan("");
    setNote("");
    setPairCheckout(false);
    setRelatedPhone(kind === "phone" ? item.id : "");
    setRelatedAccountToken(kind === "account" ? item.id : "");
    setCheckoutOpen(true);
  };

  const submitCheckout = async () => {
    if (!item) return;
    setBusy(true);
    try {
      const res = await dispatchCheckout(kind, item.id, {
        customer: customer.trim(),
        wechat: wechat.trim(),
        xianyu: xianyu.trim(),
        plan: plan.trim(),
        note: note.trim(),
        relatedPhone: kind === "phone" ? item.id : relatedPhone.trim(),
        relatedAccountToken: kind === "account" ? item.id : relatedAccountToken.trim(),
        pairCheckout,
      });
      setSummary(res.summary);
      // 账号出库含二次核验：未通过时不消耗、保留当前卡片，提示原因，让管理员点「不可用，下一个」。
      if (!res.ok) {
        Toast.error(res.message || "核验未通过，未出库");
        setCheckoutOpen(false);
        return;
      }
      setItem(null);
      setCheckoutOpen(false);
      Toast.success(pairCheckout ? "已完成成套出库" : "已出库");
    } catch (e) {
      Toast.error(e instanceof Error ? e.message : "出库失败");
    } finally {
      setBusy(false);
    }
  };

  const copyAll = () => {
    if (!item) return;
    const text = item.fields.map((f) => `${f.label}: ${f.value}`).join("\n");
    void copy(text, "全部信息");
  };

  const kindLabel = kind === "account" ? "Plus 账号" : "手机号";

  return (
    <div style={{ maxWidth: 720, margin: "0 auto" }}>
      {/* 发号类型 */}
      <Card bodyStyle={{ padding: 16 }} style={{ marginBottom: 16 }}>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 12,
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 14,
          }}
        >
          <RadioGroup
            type="button"
            value={kind}
            onChange={(e) => void switchKind(e.target.value as DispatchKind)}
            style={{ width: isMobile ? "100%" : undefined }}
          >
            <Radio value="account" style={isMobile ? { flex: 1, textAlign: "center" } : undefined}>
              会员账号发号（剩 {summary.account_available}）
            </Radio>
            <Radio value="phone" style={isMobile ? { flex: 1, textAlign: "center" } : undefined}>
              手机号码发号（剩 {summary.phone_available}）
            </Radio>
          </RadioGroup>
          <Button icon={<IconRefresh />} size="small" onClick={() => void refreshSummary()}>
            刷新可用
          </Button>
        </div>

        {kind === "account" ? (
          <div style={{ marginBottom: 14 }}>
            <Table
              dataSource={dispatchAccounts}
              rowKey="access_token"
              size="small"
              pagination={false}
              rowSelection={{
                type: "radio",
                selectedRowKeys: selectedToken ? [selectedToken] : [],
                onChange: (keys) => setSelectedToken(String((keys ?? [])[0] || "")),
              }}
              columns={[
                { title: "邮箱", dataIndex: "email" },
                {
                  title: "激活时间",
                  dataIndex: "activated_at",
                  render: (v: string | null) => (v ? new Date(v).toLocaleString() : "—"),
                },
              ]}
              scroll={{ y: 200 }}
              empty="暂无可出库 Plus 账号"
            />
          </div>
        ) : null}

        <div style={{ marginTop: 14 }}>
          <Button
            theme="solid"
            type="primary"
            size="large"
            icon={<IconSend />}
            block
            loading={busy && !item}
            disabled={(kind === "account" ? !selectedToken && availableOf(kind) <= 0 : availableOf(kind) <= 0) && !item}
            onClick={() => void acquire(item?.id, selectedToken)}
          >
            {item ? "重新发一个" : `发一个${kindLabel}`}
          </Button>
          <Text type="tertiary" size="small" style={{ display: "block", marginTop: 8, textAlign: "center" }}>
            {kind === "account" ? "先勾选 Plus 账号，再预占并发号" : "按导入时间最老优先"}
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
              onClick={openCheckout}
            >
              出库
            </Button>
            {kind === "phone" ? (
              <Button icon={<IconClock />} loading={busy} style={{ flex: 1, minWidth: 96 }} onClick={() => void act("cooldown")}>
                冷却
              </Button>
            ) : null}
            <Popconfirm
              title="确认标记无效？"
              content={`标记后该${kindLabel}将不再参与发号，不可撤销`}
              onConfirm={() => void act("invalid")}
            >
              <Button
                type="danger"
                icon={<IconClose />}
                loading={busy}
                style={{ flex: 1, minWidth: 96 }}
              >
                无效
              </Button>
            </Popconfirm>
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

      <Modal
        title={pairCheckout ? "成套出库" : "记录出库信息"}
        visible={checkoutOpen}
        onCancel={() => setCheckoutOpen(false)}
        onOk={() => void submitCheckout()}
        okText="确认出库"
        confirmLoading={busy}
        fullScreen={isMobile}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Input value={customer} onChange={setCustomer} placeholder="客户名 / 卖给谁了（选填）" />
          <Input value={wechat} onChange={setWechat} placeholder="微信号（选填）" />
          <Input value={xianyu} onChange={setXianyu} placeholder="闲鱼号（选填）" />
          <Input value={plan} onChange={setPlan} placeholder="套餐（选填）" />
          <Input value={note} onChange={setNote} placeholder="备注（选填）" />
          <Checkbox checked={pairCheckout} onChange={(e) => setPairCheckout(Boolean(e.target.checked))}>
            这次是成套发货（成品号 + 手机号一起）
          </Checkbox>
          {pairCheckout ? (
            kind === "account" ? (
              <Input value={relatedPhone} onChange={setRelatedPhone} placeholder="关联手机号（成套发货时填写）" />
            ) : (
              <Input value={relatedAccountToken} onChange={setRelatedAccountToken} placeholder="关联成品号 access_token（成套发货时填写）" />
            )
          ) : null}
        </div>
      </Modal>
    </div>
  );
}
