import { useEffect, useMemo, useState } from "react";
import { Card, Typography, Button, Space, Toast, Modal, TextArea, Table, Tag, Input, Tabs, Pagination } from "@douyinfe/semi-ui-19";
import { IconCopy } from "@douyinfe/semi-icons";
import type { ColumnProps } from "@douyinfe/semi-ui-19/lib/es/table";

import { createAccounts, fetchAccounts, markAccountsUsed, type Account } from "@/lib/api";
import { StatCards } from "@/components/StatCards";
import { useIsMobile } from "@/lib/use-is-mobile";
import { MobileFilters } from "@/components/MobileFilters";

const { Title, Text } = Typography;
const PAGE_SIZE = 10;

async function copy(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text);
    Toast.success(`${label}已复制`);
  } catch {
    Toast.error("复制失败，请检查浏览器剪贴板权限");
  }
}

function fmtTime(v: string | null | undefined) {
  return v ? new Date(v).toLocaleString() : "—";
}

export default function FinishedAccountsPage() {
  const isMobile = useIsMobile();
  const [loading, setLoading] = useState(true);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [stats, setStats] = useState({
    accountsTotal: 0,
    accountsUnused: 0,
    accountsActivated: 0,
    accountsSold: 0,
  });
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [checkoutTarget, setCheckoutTarget] = useState<Account | null>(null);
  const [customer, setCustomer] = useState("");
  const [wechat, setWechat] = useState("");
  const [xianyu, setXianyu] = useState("");
  const [plan, setPlan] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [keyword, setKeyword] = useState("");
  const [statusTab, setStatusTab] = useState<"unsold" | "sold">("unsold");
  const [page, setPage] = useState(1);

  const load = async () => {
    setLoading(true);
    try {
      const accountsData = await fetchAccounts({ page: 1, page_size: 200 });
      setAccounts(accountsData.items);
      setStats({
        accountsTotal: accountsData.summary.total,
        accountsUnused: accountsData.summary.unused,
        accountsActivated: accountsData.summary.activated,
        accountsSold: Math.max(0, accountsData.summary.total - accountsData.summary.unused),
      });
    } catch (error) {
      Toast.error(error instanceof Error ? error.message : "加载成品号总览失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const summaryCards = [
    { label: "成品号总数", value: stats.accountsTotal },
    { label: "未出库成品号", value: stats.accountsUnused, color: "var(--semi-color-primary)" },
    { label: "已卖出成品号", value: stats.accountsSold, color: "var(--semi-color-warning)" },
    { label: "已激活成品号", value: stats.accountsActivated, color: "var(--semi-color-success)" },
  ];

  const filteredAccounts = useMemo(() => {
    const q = keyword.trim().toLowerCase();
    return accounts.filter((item) => {
      const matchStatus = statusTab === "unsold" ? !item.used : !!item.used;
      if (!matchStatus) return false;
      if (!q) return true;
      return [
        item.email,
        item.password,
        item.checkout_meta?.customer,
        item.checkout_meta?.wechat,
        item.checkout_meta?.xianyu,
        item.checkout_meta?.plan,
        item.checkout_meta?.note,
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(q));
    });
  }, [accounts, keyword, statusTab]);

  const pagedAccounts = useMemo(
    () => filteredAccounts.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [filteredAccounts, page],
  );

  useEffect(() => {
    setPage(1);
  }, [keyword, statusTab]);

  const handleImport = async () => {
    if (!importText.trim()) {
      Toast.warning("请粘贴成品号文本");
      return;
    }
    setBusy(true);
    try {
      const data = await createAccounts([], [], importText);
      Toast.success(`导入完成，新增 ${data.added ?? 0} 个`);
      setImportText("");
      setImportOpen(false);
      await load();
    } catch (error) {
      Toast.error(error instanceof Error ? error.message : "导入失败");
    } finally {
      setBusy(false);
    }
  };

  const openCheckout = (item: Account) => {
    setCheckoutTarget(item);
    setCustomer(item.checkout_meta?.customer || "");
    setWechat(item.checkout_meta?.wechat || "");
    setXianyu(item.checkout_meta?.xianyu || "");
    setPlan(item.checkout_meta?.plan || "");
    setNote(item.checkout_meta?.note || "");
  };

  const handleCheckout = async () => {
    if (!checkoutTarget) return;
    if (!customer.trim()) {
      Toast.warning("请至少填写卖给谁了");
      return;
    }
    setBusy(true);
    try {
      await markAccountsUsed(
        [checkoutTarget.access_token],
        true,
        {
          [checkoutTarget.access_token]: {
            customer: customer.trim(),
            wechat: wechat.trim(),
            xianyu: xianyu.trim(),
            plan: plan.trim(),
            note: note.trim(),
          },
        },
      );
      Toast.success(checkoutTarget.used ? "已更新卖出记录" : "已记录出库信息");
      setCheckoutTarget(null);
      await load();
    } catch (error) {
      Toast.error(error instanceof Error ? error.message : "记录失败");
    } finally {
      setBusy(false);
    }
  };

  const columns: ColumnProps<Account>[] = [
    {
      title: "邮箱",
      dataIndex: "email",
      render: (value: string | null) => value || "—",
    },
    {
      title: "密码",
      dataIndex: "password",
      render: (value: string | null) => value || "—",
    },
    {
      title: "2FA",
      dataIndex: "totp_secret",
      render: (value: string | null) => value ? `${value.slice(0, 4)}...${value.slice(-4)}` : "—",
    },
    {
      title: "会员状态",
      dataIndex: "plus_status",
      render: (value: string | null | undefined) => (
        <Tag color={value === "已激活" ? "green" : "grey"} type="light">
          {value || "未激活"}
        </Tag>
      ),
    },
    {
      title: "出库状态",
      dataIndex: "used",
      render: (value: boolean) => (
        <Tag color={value ? "grey" : "blue"} type="light">
          {value ? "已卖出" : "可出售"}
        </Tag>
      ),
    },
    {
      title: "卖给谁",
      render: (_: unknown, item: Account) => item.checkout_meta?.customer || "—",
    },
    {
      title: "出库信息",
      render: (_: unknown, item: Account) => {
        if (!item.checkout_meta) return "—";
        return [
          item.checkout_meta.wechat,
          item.checkout_meta.xianyu,
          item.checkout_meta.plan,
          item.checkout_meta.phone ? `手机号:${item.checkout_meta.phone}` : "",
        ].filter(Boolean).join(" / ") || "—";
      },
    },
    {
      title: "出库时间",
      render: (_: unknown, item: Account) => item.checkout_at || item.checkout_meta?.checkout_at || "—",
    },
    {
      title: "操作",
      render: (_: unknown, item: Account) => (
        <Button size="small" onClick={() => openCheckout(item)}>
          {item.used ? "编辑记录" : "记录卖出"}
        </Button>
      ),
    },
  ];

  return (
    <div>
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
        <div>
          <Title heading={isMobile ? 4 : 3} style={{ margin: 0 }}>
            成品号管理
          </Title>
          <Text type="tertiary">只保留成品号台账，支持导入、检索和记录卖出信息。</Text>
        </div>
        <Space wrap>
          <Button theme="solid" type="primary" onClick={() => setImportOpen(true)}>导入成品号</Button>
        </Space>
      </div>

      <StatCards mobile={isMobile} items={summaryCards} />

      <Card bodyStyle={{ padding: 0 }} loading={loading}>
        <div style={{ padding: "16px 16px 0" }}>
          <Title heading={5} style={{ marginTop: 0, marginBottom: 6 }}>
            成品号台账
          </Title>
          <Text type="tertiary">支持导入外部购买号，并记录卖给谁了、微信、闲鱼、套餐、备注和出库时间。</Text>
          <div style={{ marginTop: 12, marginBottom: 12 }}>
            {isMobile ? (
              <MobileFilters activeCount={keyword.trim() ? 1 : 0}>
                <Input
                  value={keyword}
                  onChange={setKeyword}
                  placeholder="搜索邮箱 / 客户 / 微信 / 闲鱼 / 套餐 / 备注"
                  style={{ width: "100%" }}
                />
              </MobileFilters>
            ) : (
              <Space wrap>
                <Input
                  value={keyword}
                  onChange={setKeyword}
                  placeholder="搜索邮箱 / 客户 / 微信 / 闲鱼 / 套餐 / 备注"
                  style={{ width: 320 }}
                />
              </Space>
            )}
          </div>
        </div>
        <Tabs activeKey={statusTab} onChange={(key) => setStatusTab(key as "unsold" | "sold")} type="line">
          <Tabs.TabPane tab={`可出售 (${accounts.filter((item) => !item.used).length})`} itemKey="unsold" />
          <Tabs.TabPane tab={`已卖出 (${accounts.filter((item) => !!item.used).length})`} itemKey="sold" />
        </Tabs>
        {isMobile ? (
          <FinishedAccountsMobileList
            accounts={pagedAccounts}
            loading={loading}
            total={filteredAccounts.length}
            page={page}
            pageSize={PAGE_SIZE}
            onPageChange={setPage}
            onEdit={openCheckout}
          />
        ) : (
          <Table columns={columns} dataSource={filteredAccounts} rowKey="access_token" pagination={false} />
        )}
      </Card>

      <Modal
        title="导入成品号"
        visible={importOpen}
        onCancel={() => setImportOpen(false)}
        onOk={() => void handleImport()}
        okText="导入"
        confirmLoading={busy}
        fullScreen={isMobile}
      >
        <Text type="tertiary">
          支持这种格式：邮箱 / 接码邮箱 / 密码 / 2FA密钥，也支持包含 token 的文本。
        </Text>
        <TextArea
          value={importText}
          onChange={setImportText}
          rows={10}
          style={{ marginTop: 8, fontFamily: "monospace" }}
          placeholder={"邮箱: idyllic.adage.xxx@icloud.com ---- 接码邮箱: http://icloudapi.xyz/show/... ---- 密码: SmartSpirit42$ ---- 2FA密钥: GLUAKLKVUX4EEXL6KUQ4JWCW657VPLGA"}
        />
      </Modal>

      <Modal
        title="记录卖出信息"
        visible={!!checkoutTarget}
        onCancel={() => setCheckoutTarget(null)}
        onOk={() => void handleCheckout()}
        okText="保存"
        confirmLoading={busy}
        fullScreen={isMobile}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Input value={customer} onChange={setCustomer} placeholder="卖给谁了 / 客户名" />
          <Input value={wechat} onChange={setWechat} placeholder="微信号（选填）" />
          <Input value={xianyu} onChange={setXianyu} placeholder="闲鱼号（选填）" />
          <Input value={plan} onChange={setPlan} placeholder="套餐（选填）" />
          <Input value={note} onChange={setNote} placeholder="备注（选填）" />
        </div>
      </Modal>
    </div>
  );
}

type FinishedAccountsMobileListProps = {
  accounts: Account[];
  loading: boolean;
  total: number;
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onEdit: (item: Account) => void;
};

function FinishedAccountsMobileList({
  accounts,
  loading,
  total,
  page,
  pageSize,
  onPageChange,
  onEdit,
}: FinishedAccountsMobileListProps) {
  if (!loading && accounts.length === 0) {
    return (
      <Card bodyStyle={{ padding: 32, textAlign: "center" }}>
        <Text type="tertiary">暂无成品号数据。</Text>
      </Card>
    );
  }

  return (
    <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
      {accounts.map((item) => (
        <Card key={item.access_token} bodyStyle={{ padding: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
            <Text
              strong
              ellipsis={{ showTooltip: true }}
              style={{ flex: 1, fontSize: 15 }}
              onClick={() => item.email && void copy(item.email, "邮箱")}
            >
              {item.email || "无邮箱"}
            </Text>
            <Tag color={item.plus_status === "已激活" ? "green" : "grey"} type="light">
              {item.plus_status || "未激活"}
            </Tag>
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
            <Tag color={item.used ? "grey" : "blue"} type="light">
              {item.used ? "已卖出" : "可出售"}
            </Tag>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 10 }}>
            <InfoLine label="密码" value={item.password || "—"} monospace copyable={!!item.password} />
            <InfoLine
              label="2FA"
              value={item.totp_secret ? `${item.totp_secret.slice(0, 4)}...${item.totp_secret.slice(-4)}` : "—"}
            />
            <InfoLine label="客户" value={item.checkout_meta?.customer || "—"} />
            <InfoLine
              label="出库"
              value={[
                item.checkout_meta?.wechat,
                item.checkout_meta?.xianyu,
                item.checkout_meta?.plan,
                item.checkout_meta?.phone ? `手机号:${item.checkout_meta.phone}` : "",
              ].filter(Boolean).join(" / ") || "—"}
            />
            <InfoLine label="时间" value={fmtTime(item.checkout_at || item.checkout_meta?.checkout_at)} />
          </div>

          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <Button size="small" icon={<IconCopy />} style={{ flex: 1 }} onClick={() => void copy(item.access_token, "access_token")}>
              复制 Token
            </Button>
            <Button size="small" type="primary" style={{ flex: 1 }} onClick={() => onEdit(item)}>
              {item.used ? "编辑记录" : "记录卖出"}
            </Button>
          </div>
        </Card>
      ))}

      {total > pageSize ? (
        <div style={{ display: "flex", justifyContent: "center", marginTop: 6 }}>
          <Pagination total={total} currentPage={page} pageSize={pageSize} onPageChange={onPageChange} />
        </div>
      ) : null}
    </div>
  );
}

function InfoLine({
  label,
  value,
  monospace = false,
  copyable = false,
}: {
  label: string;
  value: string;
  monospace?: boolean;
  copyable?: boolean;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
      <Text type="tertiary" size="small" style={{ width: 42, flexShrink: 0 }}>
        {label}
      </Text>
      <Text
        ellipsis={{ showTooltip: true }}
        style={{ flex: 1, fontSize: 12, fontFamily: monospace ? "monospace" : undefined }}
        onClick={() => copyable && void copy(value, label)}
      >
        {value}
      </Text>
    </div>
  );
}
