import { useEffect, useState } from "react";
import { Table, Card, Button, Tag, Toast, Modal, TextArea, Typography, Popconfirm, Space, Input, Select } from "@douyinfe/semi-ui-19";
import { IconRefresh, IconUpload, IconDelete, IconCopy, IconSearch, IconLink } from "@douyinfe/semi-icons";
import type { ColumnProps } from "@douyinfe/semi-ui-19/lib/es/table";

import { fetchMailboxes, importMailboxes, deleteMailboxes, markMailboxes, type Mailbox, type MailboxStats, type MailboxListParams } from "@/lib/api";
import { useDebouncedValue } from "@/lib/use-debounced-value";

const { Title, Text } = Typography;

const PAGE_SIZE = 10;
const EMPTY_STATS: MailboxStats = { total: 0, used: 0, unused: 0, in_use: 0 };

function copy(text: string, label: string) {
  void navigator.clipboard.writeText(text);
  Toast.success(`${label}已复制`);
}

export default function MailboxesPage() {
  const [items, setItems] = useState<Mailbox[]>([]);
  const [stats, setStats] = useState<MailboxStats>(EMPTY_STATS);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");

  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query, 300);
  const [statusFilter, setStatusFilter] = useState<"" | "unused" | "used" | "in_use">("");

  const buildParams = (overrides?: Partial<MailboxListParams>): MailboxListParams => ({
    q: debouncedQuery.trim() || undefined,
    status: statusFilter || undefined,
    page,
    page_size: PAGE_SIZE,
    ...overrides,
  });

  const load = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const data = await fetchMailboxes(buildParams());
      setItems(data.items);
      setStats(data.stats);
      setTotal(data.total);
      setSelected((prev) => prev.filter((id) => data.items.some((m) => m.email === id)));
    } catch (e) {
      Toast.error(e instanceof Error ? e.message : "加载邮箱失败");
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQuery, statusFilter, page]);

  const handleImport = async () => {
    if (!importText.trim()) {
      Toast.warning("请粘贴邮箱");
      return;
    }
    setBusy(true);
    try {
      const data = await importMailboxes(importText);
      setImportText("");
      setImportOpen(false);
      await load(true);
      Toast.success(`导入完成，新增 ${data.result.added}，更新 ${data.result.updated}`);
    } catch (e) {
      Toast.error(e instanceof Error ? e.message : "导入失败");
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (emails: string[]) => {
    if (!emails.length) return;
    setBusy(true);
    try {
      const data = await deleteMailboxes(emails);
      await load(true);
      Toast.success(`删除 ${data.removed} 个`);
    } catch (e) {
      Toast.error(e instanceof Error ? e.message : "删除失败");
    } finally {
      setBusy(false);
    }
  };

  const handleMark = async (emails: string[], used: boolean) => {
    if (!emails.length) {
      Toast.warning("请先选择邮箱");
      return;
    }
    setBusy(true);
    try {
      const data = await markMailboxes(emails, used);
      await load(true);
      Toast.success(`已标记 ${data.changed} 个为${used ? "已用" : "未用"}`);
    } catch (e) {
      Toast.error(e instanceof Error ? e.message : "标记失败");
    } finally {
      setBusy(false);
    }
  };

  const columns: ColumnProps<Mailbox>[] = [
    {
      title: "邮箱",
      dataIndex: "email",
      width: 300,
      render: (email: string) => (
        <Space>
          <Text ellipsis={{ showTooltip: true }} style={{ maxWidth: 230 }}>
            {email}
          </Text>
          <Button size="small" theme="borderless" icon={<IconCopy />} onClick={() => copy(email, "邮箱")} />
        </Space>
      ),
    },
    {
      title: "状态",
      width: 110,
      render: (_: unknown, m: Mailbox) => {
        if (m.in_use) return <Tag color="blue" type="light">占用中</Tag>;
        if (m.used) return <Tag color="grey" type="light">已用</Tag>;
        return <Tag color="green" type="light">可用</Tag>;
      },
    },
    {
      title: "接码地址",
      dataIndex: "fetch_url",
      width: 280,
      render: (url: string) =>
        url ? (
          <Space>
            <Text ellipsis={{ showTooltip: true }} style={{ maxWidth: 210, fontFamily: "monospace", fontSize: 12 }}>
              {url}
            </Text>
            <Button
              size="small"
              theme="borderless"
              icon={<IconLink />}
              title="打开接码地址"
              onClick={() => window.open(url, "_blank", "noopener")}
            />
            <Button size="small" theme="borderless" icon={<IconCopy />} onClick={() => copy(url, "接码地址")} />
          </Space>
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
      render: (_: unknown, m: Mailbox) => (
        <Popconfirm title="删除该邮箱？" onConfirm={() => void handleDelete([m.email])}>
          <Button size="small" theme="borderless" type="danger" icon={<IconDelete />} />
        </Popconfirm>
      ),
    },
  ];

  const cards = [
    { label: "邮箱总数", value: stats.total },
    { label: "可用", value: stats.unused, color: "var(--semi-color-success)" },
    { label: "已用", value: stats.used },
    { label: "占用中", value: stats.in_use, color: "var(--semi-color-primary)" },
  ];

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <Title heading={3} style={{ margin: 0 }}>
          邮箱管理
        </Title>
        <Space>
          <Button icon={<IconRefresh />} onClick={() => void load()} loading={loading}>
            刷新
          </Button>
          <Button icon={<IconUpload />} theme="solid" type="primary" onClick={() => setImportOpen(true)}>
            导入
          </Button>
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
          placeholder="搜索邮箱 / 接码地址"
          style={{ width: 240 }}
        />
        <Select
          value={statusFilter}
          onChange={(v) => {
            setStatusFilter((v as "" | "unused" | "used" | "in_use") ?? "");
            setPage(1);
          }}
          style={{ width: 130 }}
          optionList={[
            { label: "全部状态", value: "" },
            { label: "可用", value: "unused" },
            { label: "已用", value: "used" },
            { label: "占用中", value: "in_use" },
          ]}
        />
      </div>

      {selected.length > 0 ? (
        <div style={{ marginBottom: 12 }}>
          <Space>
            <Text type="tertiary">已选 {selected.length} 项</Text>
            <Button size="small" onClick={() => void handleMark(selected, true)} loading={busy}>
              标记已用
            </Button>
            <Button size="small" onClick={() => void handleMark(selected, false)} loading={busy}>
              标记未用
            </Button>
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
        dataSource={items}
        loading={loading}
        rowKey="email"
        tableLayout="fixed"
        scroll={{ x: 1020 }}
        pagination={{
          currentPage: page,
          pageSize: PAGE_SIZE,
          total,
          onPageChange: setPage,
        }}
        rowSelection={{ selectedRowKeys: selected, onChange: (keys) => setSelected((keys ?? []) as string[]) }}
        empty="暂无邮箱，先导入。"
      />

      <Modal title="导入邮箱" visible={importOpen} onCancel={() => setImportOpen(false)} onOk={() => void handleImport()} okText="导入" confirmLoading={busy}>
        <Text type="tertiary">按邮箱池约定格式粘贴，一行一个。</Text>
        <TextArea value={importText} onChange={setImportText} rows={10} style={{ marginTop: 8, fontFamily: "monospace" }} placeholder={"一行一个邮箱..."} />
      </Modal>
    </div>
  );
}
