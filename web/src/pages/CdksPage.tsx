import { useEffect, useState } from "react";
import {
  Table,
  Card,
  Button,
  Tag,
  Toast,
  Modal,
  Select,
  TextArea,
  Typography,
  Dropdown,
  Popconfirm,
  Space,
  Input,
} from "@douyinfe/semi-ui-19";
import { IconRefresh, IconUpload, IconDownload, IconDelete, IconCopy, IconSearch } from "@douyinfe/semi-icons";
import type { ColumnProps } from "@douyinfe/semi-ui-19/lib/es/table";

import {
  fetchCdks,
  importCdks,
  deleteCdks,
  exportCdks,
  type Cdk,
  type CdkCounts,
  type CdkType,
  type CdkStatus,
  type CdkListParams,
} from "@/lib/api";
import { useDebouncedValue } from "@/lib/use-debounced-value";

const { Title, Text } = Typography;

const PAGE_SIZE = 10;

const STATUS_TAG: Record<CdkStatus, { text: string; color: string }> = {
  available: { text: "可用", color: "green" },
  used: { text: "已用", color: "grey" },
  invalid: { text: "无效", color: "red" },
};

const EMPTY_COUNTS: CdkCounts = {
  by_type: { UPI: { available: 0, used: 0, invalid: 0 }, IDEL: { available: 0, used: 0, invalid: 0 } },
  available: 0,
  total: 0,
};

function copy(text: string, label: string) {
  void navigator.clipboard.writeText(text);
  Toast.success(`${label}已复制`);
}

function maskCdk(c: string) {
  return c.length <= 12 ? c : `${c.slice(0, 6)}...${c.slice(-4)}`;
}

export default function CdksPage() {
  const [cdks, setCdks] = useState<Cdk[]>([]);
  const [counts, setCounts] = useState<CdkCounts>(EMPTY_COUNTS);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importType, setImportType] = useState<CdkType>("UPI");
  const [detail, setDetail] = useState<Cdk | null>(null);

  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query, 300);
  const [statusFilter, setStatusFilter] = useState<"" | CdkStatus>("");
  const [typeFilter, setTypeFilter] = useState<"" | CdkType>("");

  const buildParams = (overrides?: Partial<CdkListParams>): CdkListParams => ({
    q: debouncedQuery.trim() || undefined,
    status: statusFilter || undefined,
    type: typeFilter || undefined,
    page,
    page_size: PAGE_SIZE,
    ...overrides,
  });

  const load = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const data = await fetchCdks(buildParams());
      setCdks(data.items);
      setCounts(data.counts);
      setTotal(data.total);
      setSelected((prev) => prev.filter((id) => data.items.some((c) => c.cdk === id)));
    } catch (e) {
      Toast.error(e instanceof Error ? e.message : "加载 CDK 失败");
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQuery, statusFilter, typeFilter, page]);

  const handleImport = async () => {
    if (!importText.trim()) {
      Toast.warning("请粘贴 CDK");
      return;
    }
    setBusy(true);
    try {
      const data = await importCdks(importText, importType);
      setImportText("");
      setImportOpen(false);
      await load(true);
      Toast.success(`导入完成，新增 ${data.result.added} 个，更新 ${data.result.updated} 个`);
    } catch (e) {
      Toast.error(e instanceof Error ? e.message : "导入失败");
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (items: string[]) => {
    if (!items.length) return;
    setBusy(true);
    try {
      const data = await deleteCdks(items);
      await load(true);
      Toast.success(`删除 ${data.removed} 个`);
    } catch (e) {
      Toast.error(e instanceof Error ? e.message : "删除失败");
    } finally {
      setBusy(false);
    }
  };

  const columns: ColumnProps<Cdk>[] = [
    {
      title: "CDK",
      dataIndex: "cdk",
      width: 220,
      render: (cdk: string) => (
        <Space>
          <Text style={{ fontFamily: "monospace", fontSize: 12 }}>{maskCdk(cdk)}</Text>
          <Button size="small" theme="borderless" icon={<IconCopy />} onClick={() => copy(cdk, "CDK")} />
        </Space>
      ),
    },
    { title: "类型", dataIndex: "type", width: 90, render: (t: string) => <Tag type="ghost">{t}</Tag> },
    {
      title: "状态",
      dataIndex: "status",
      width: 90,
      render: (s: CdkStatus) => (
        <Tag color={STATUS_TAG[s].color as never} type="light">
          {STATUS_TAG[s].text}
        </Tag>
      ),
    },
    {
      title: "绑定账号",
      width: 260,
      render: (_: unknown, c: Cdk) =>
        c.bound_account?.email ? (
          <Button theme="borderless" type="primary" style={{ padding: 0 }} onClick={() => setDetail(c)}>
            <Text ellipsis={{ showTooltip: true }} style={{ maxWidth: 220, color: "var(--semi-color-primary)" }}>
              {c.bound_account.email}
            </Text>
          </Button>
        ) : c.bound_token ? (
          <Text type="tertiary">{maskCdk(c.bound_token)}（账号已删除）</Text>
        ) : (
          <Text type="tertiary">—</Text>
        ),
    },
    {
      title: "导入时间",
      dataIndex: "imported_at",
      width: 150,
      render: (v: string | null) => (
        <Text type="tertiary" size="small">
          {v ? new Date(v).toLocaleString() : "—"}
        </Text>
      ),
    },
    {
      title: "操作",
      width: 80,
      fixed: "right",
      render: (_: unknown, c: Cdk) => (
        <Popconfirm title="删除该 CDK？" onConfirm={() => void handleDelete([c.cdk])}>
          <Button size="small" theme="borderless" type="danger" icon={<IconDelete />} />
        </Popconfirm>
      ),
    },
  ];

  const cards = [
    { label: "可用总数", value: counts.available, color: "var(--semi-color-success)" },
    { label: "CDK 总数", value: counts.total },
    { label: "UPI（可用/已用/无效）", value: `${counts.by_type.UPI.available} / ${counts.by_type.UPI.used} / ${counts.by_type.UPI.invalid}` },
    { label: "IDEL（可用/已用/无效）", value: `${counts.by_type.IDEL.available} / ${counts.by_type.IDEL.used} / ${counts.by_type.IDEL.invalid}` },
  ];

  const acc = detail?.bound_account;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <Title heading={3} style={{ margin: 0 }}>
          CDK 管理
        </Title>
        <Space>
          <Button icon={<IconRefresh />} onClick={() => void load()} loading={loading}>
            刷新
          </Button>
          <Button icon={<IconUpload />} theme="solid" type="primary" onClick={() => setImportOpen(true)}>
            导入
          </Button>
          <Dropdown
            trigger="click"
            render={
              <Dropdown.Menu>
                <Dropdown.Item onClick={() => void exportCdks()}>导出全部</Dropdown.Item>
                <Dropdown.Item onClick={() => void exportCdks("UPI")}>仅导出 UPI</Dropdown.Item>
                <Dropdown.Item onClick={() => void exportCdks("IDEL")}>仅导出 IDEL</Dropdown.Item>
              </Dropdown.Menu>
            }
          >
            <Button icon={<IconDownload />}>导出</Button>
          </Dropdown>
        </Space>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 16 }}>
        {cards.map((c) => (
          <Card key={c.label} bodyStyle={{ padding: 16 }}>
            <Text type="tertiary" size="small">
              {c.label}
            </Text>
            <div style={{ fontSize: 22, fontWeight: 600, color: c.color, marginTop: 4 }}>{c.value}</div>
          </Card>
        ))}
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginBottom: 16 }}>
        <Input
          prefix={<IconSearch />}
          value={query}
          onChange={(v) => {
            setQuery(v);
            setPage(1);
          }}
          showClear
          placeholder="搜索 CDK / 绑定邮箱"
          style={{ width: 240 }}
        />
        <Select
          value={statusFilter}
          onChange={(v) => {
            setStatusFilter((v as "" | CdkStatus) ?? "");
            setPage(1);
          }}
          style={{ width: 130 }}
          optionList={[
            { label: "全部状态", value: "" },
            { label: "可用", value: "available" },
            { label: "已用", value: "used" },
            { label: "无效", value: "invalid" },
          ]}
        />
        <Select
          value={typeFilter}
          onChange={(v) => {
            setTypeFilter((v as "" | CdkType) ?? "");
            setPage(1);
          }}
          style={{ width: 130 }}
          optionList={[
            { label: "全部类型", value: "" },
            { label: "UPI", value: "UPI" },
            { label: "IDEL", value: "IDEL" },
          ]}
        />
      </div>

      {selected.length > 0 ? (
        <div style={{ marginBottom: 12 }}>
          <Space>
            <Text type="tertiary">已选 {selected.length} 项</Text>
            <Popconfirm title={`删除选中的 ${selected.length} 个？`} onConfirm={() => void handleDelete(selected)}>
              <Button size="small" type="danger" icon={<IconDelete />}>
                删除选中
              </Button>
            </Popconfirm>
          </Space>
        </div>
      ) : null}

      <Table
        columns={columns}
        dataSource={cdks}
        loading={loading}
        rowKey="cdk"
        tableLayout="fixed"
        scroll={{ x: 990 }}
        pagination={{
          currentPage: page,
          pageSize: PAGE_SIZE,
          total,
          onPageChange: setPage,
        }}
        rowSelection={{ selectedRowKeys: selected, onChange: (keys) => setSelected((keys ?? []) as string[]) }}
        empty="暂无 CDK，先导入。"
      />

      {/* 导入弹窗 */}
      <Modal title="导入 CDK" visible={importOpen} onCancel={() => setImportOpen(false)} onOk={() => void handleImport()} okText="导入" confirmLoading={busy}>
        <div style={{ display: "flex", flexDirection: "column", gap: 12, paddingTop: 8 }}>
          <div>
            <Text style={{ display: "block", marginBottom: 6 }}>类型</Text>
            <Select
              value={importType}
              onChange={(v) => setImportType(v as CdkType)}
              style={{ width: "100%" }}
              optionList={[
                { label: "UPI", value: "UPI" },
                { label: "IDEL", value: "IDEL" },
              ]}
            />
          </div>
          <div>
            <Text style={{ display: "block", marginBottom: 6 }}>CDK 列表（一行一个）</Text>
            <TextArea value={importText} onChange={setImportText} rows={10} style={{ fontFamily: "monospace" }} placeholder={"一行一个 CDK..."} />
          </div>
        </div>
      </Modal>

      {/* 绑定账号穿透弹窗 */}
      <Modal title="绑定账号信息" visible={!!detail} onCancel={() => setDetail(null)} footer={null}>
        {acc ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 10, paddingTop: 8 }}>
            <Space>
              <Tag color={acc.status === "异常" || acc.status === "禁用" ? "red" : "green"} type="light">
                {acc.status === "异常" || acc.status === "禁用" ? "失效" : "存活"}
              </Tag>
              <Tag color={acc.plus_status === "已激活" ? "green" : "grey"} type="light">
                {acc.plus_status ?? "未激活"}
              </Tag>
            </Space>
            {[
              { label: "邮箱", value: acc.email },
              { label: "接码地址", value: acc.fetch_url },
              { label: "密码", value: acc.password },
              { label: "2FA 密钥", value: acc.totp_secret || "（未开启）" },
            ].map((row) => (
              <div key={row.label} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                <Text type="tertiary" size="small" style={{ flexShrink: 0 }}>
                  {row.label}
                </Text>
                <Space style={{ minWidth: 0 }}>
                  <Text ellipsis={{ showTooltip: true }} style={{ maxWidth: 320, fontFamily: "monospace", fontSize: 12 }}>
                    {row.value || "—"}
                  </Text>
                  {row.value ? (
                    <Button size="small" theme="borderless" icon={<IconCopy />} onClick={() => copy(String(row.value), row.label)} />
                  ) : null}
                </Space>
              </div>
            ))}
          </div>
        ) : (
          <Text type="tertiary">该账号已不存在。</Text>
        )}
      </Modal>
    </div>
  );
}
