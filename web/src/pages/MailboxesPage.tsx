import { useEffect, useMemo, useState } from "react";
import {
  Table,
  Card,
  Button,
  Tag,
  Toast,
  Modal,
  TextArea,
  Typography,
  Popconfirm,
  Space,
  Input,
  Select,
  Checkbox,
  Pagination,
} from "@douyinfe/semi-ui-19";
import { IconRefresh, IconUpload, IconDownload, IconDelete, IconCopy, IconSearch, IconLink, IconTick, IconClose } from "@douyinfe/semi-icons";
import type { ColumnProps } from "@douyinfe/semi-ui-19/lib/es/table";

import { fetchMailboxes, importMailboxes, deleteMailboxes, markMailboxes, fetchMailboxesExportText, type Mailbox, type MailboxStats, type MailboxListParams } from "@/lib/api";
import { copyToClipboard as copy } from "@/lib/clipboard";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import { useIsMobile } from "@/lib/use-is-mobile";
import { MAX_IMPORT_ROWS, countImportRows } from "@/lib/utils";
import { StatCards } from "@/components/StatCards";
import { MobileFilters } from "@/components/MobileFilters";

const { Title, Text } = Typography;

const PAGE_SIZE = 10;
const EMPTY_STATS: MailboxStats = { total: 0, used: 0, unused: 0, in_use: 0 };

function statusTag(m: Mailbox) {
  if (m.used) return <Tag color="grey" type="light">已注册</Tag>;
  if (m.in_use) return <Tag color="blue" type="light">注册中</Tag>;
  return <Tag color="green" type="light">待注册</Tag>;
}

function fmtTime(v: string | null) {
  return v ? new Date(v).toLocaleString() : "—";
}

export default function MailboxesPage() {
  const isMobile = useIsMobile();

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
    const rows = countImportRows(importText);
    if (rows > MAX_IMPORT_ROWS) {
      Toast.warning(`单次最多导入 ${MAX_IMPORT_ROWS} 条，当前 ${rows} 条，请分批导入`);
      return;
    }
    setBusy(true);
    try {
      const data = await importMailboxes(importText);
      setImportText("");
      setImportOpen(false);
      await load(true);
      Toast.success(
        `导入完成，新增 ${data.result.added}，更新 ${data.result.updated}，跳过重复 ${data.result.skipped}`,
      );
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
      Toast.success(`已标记 ${data.changed} 个为${used ? "已注册" : "待注册"}`);
    } catch (e) {
      Toast.error(e instanceof Error ? e.message : "标记失败");
    } finally {
      setBusy(false);
    }
  };

  // 导出邮箱池：每行 `邮箱---收件地址`。
  const handleExport = async () => {
    setBusy(true);
    try {
      const text = await fetchMailboxesExportText();
      if (!text.trim()) {
        Toast.warning("没有可导出的邮箱");
        return;
      }
      const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `mailboxes-${Date.now()}.txt`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (e) {
      Toast.error(e instanceof Error ? e.message : "导出失败");
    } finally {
      setBusy(false);
    }
  };

  const allOnPageSelected = items.length > 0 && items.every((m) => selected.includes(m.email));
  const toggleSelectAll = () => setSelected(allOnPageSelected ? [] : items.map((m) => m.email));
  const toggleOne = (email: string) =>
    setSelected((prev) => (prev.includes(email) ? prev.filter((e) => e !== email) : [...prev, email]));

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
    { title: "状态", width: 110, render: (_: unknown, m: Mailbox) => statusTag(m) },
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
          {fmtTime(v)}
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
    { label: "待注册", value: stats.unused, color: "var(--semi-color-success)" },
    { label: "已注册", value: stats.used },
    { label: "注册中", value: stats.in_use, color: "var(--semi-color-primary)" },
  ];

  const filterControls = (
    <>
      <Input
        prefix={<IconSearch />}
        value={query}
        onChange={(v) => {
          setQuery(v);
          setPage(1);
        }}
        showClear
        placeholder="搜索邮箱 / 接码地址"
        style={{ width: isMobile ? "100%" : 240 }}
      />
      <Select
        value={statusFilter}
        onChange={(v) => {
          setStatusFilter((v as "" | "unused" | "used" | "in_use") ?? "");
          setPage(1);
        }}
        style={{ width: isMobile ? "100%" : 130 }}
        optionList={[
          { label: "全部状态", value: "" },
          { label: "待注册", value: "unused" },
          { label: "已注册", value: "used" },
          { label: "注册中", value: "in_use" },
        ]}
      />
    </>
  );
  const activeFilterCount = (query.trim() ? 1 : 0) + (statusFilter ? 1 : 0);

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
        <Title heading={isMobile ? 4 : 3} style={{ margin: 0 }}>
          邮箱管理
        </Title>
        <Space spacing={8} style={{ flexWrap: "wrap" }}>
          <Button icon={<IconRefresh />} onClick={() => void load()} loading={loading}>
            刷新
          </Button>
          <Button icon={<IconUpload />} theme="solid" type="primary" onClick={() => setImportOpen(true)}>
            导入
          </Button>
          <Button icon={<IconDownload />} onClick={() => void handleExport()} loading={busy}>
            导出
          </Button>
        </Space>
      </div>

      <StatCards mobile={isMobile} items={cards} />

      {isMobile ? (
        <MobileFilters activeCount={activeFilterCount}>{filterControls}</MobileFilters>
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginBottom: 16 }}>{filterControls}</div>
      )}

      {selected.length > 0 ? (
        <div style={{ marginBottom: 12 }}>
          <Space style={{ flexWrap: "wrap" }}>
            <Text type="tertiary">已选 {selected.length} 项</Text>
            <Button size="small" icon={<IconTick />} onClick={() => void handleMark(selected, true)} loading={busy}>
              标记已注册
            </Button>
            <Button size="small" icon={<IconClose />} onClick={() => void handleMark(selected, false)} loading={busy}>
              标记待注册
            </Button>
            <Popconfirm title={`删除选中的 ${selected.length} 个？`} onConfirm={() => void handleDelete(selected)}>
              <Button size="small" type="danger" icon={<IconDelete />}>
                删除选中
              </Button>
            </Popconfirm>
          </Space>
        </div>
      ) : null}

      {isMobile ? (
        <MobileList
          items={items}
          loading={loading}
          selected={selected}
          allSelected={allOnPageSelected}
          onToggleAll={toggleSelectAll}
          onToggle={toggleOne}
          onMark={(email, used) => void handleMark([email], used)}
          onDelete={(email) => void handleDelete([email])}
          page={page}
          pageSize={PAGE_SIZE}
          total={total}
          onPageChange={setPage}
        />
      ) : (
        <Table
          columns={columns}
          dataSource={items}
          loading={loading}
          rowKey="email"
          tableLayout="fixed"
          scroll={{ x: 1020 }}
          pagination={{ currentPage: page, pageSize: PAGE_SIZE, total, onPageChange: setPage }}
          rowSelection={{ selectedRowKeys: selected, onChange: (keys) => setSelected((keys ?? []) as string[]) }}
          empty="暂无邮箱，先导入。"
        />
      )}

      <Modal
        title="导入邮箱"
        visible={importOpen}
        onCancel={() => setImportOpen(false)}
        onOk={() => void handleImport()}
        okText="导入"
        confirmLoading={busy}
        maskClosable={false}
        fullScreen={isMobile}
      >
        <Text type="tertiary">按邮箱池约定格式粘贴，一行一个 <Text code>邮箱---收件地址</Text>（兼容旧 <Text code>----</Text> 分隔）。</Text>
        <TextArea value={importText} onChange={setImportText} rows={isMobile ? 12 : 10} style={{ marginTop: 8, fontFamily: "monospace" }} placeholder={"一行一个邮箱..."} />
      </Modal>
    </div>
  );
}

// ───────────────────────── 手机端卡片流 ─────────────────────────

type MobileListProps = {
  items: Mailbox[];
  loading: boolean;
  selected: string[];
  allSelected: boolean;
  onToggleAll: () => void;
  onToggle: (email: string) => void;
  onMark: (email: string, used: boolean) => void;
  onDelete: (email: string) => void;
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
};

function MobileList({
  items,
  loading,
  selected,
  allSelected,
  onToggleAll,
  onToggle,
  onMark,
  onDelete,
  page,
  pageSize,
  total,
  onPageChange,
}: MobileListProps) {
  if (!loading && items.length === 0) {
    return (
      <Card bodyStyle={{ padding: 32, textAlign: "center" }}>
        <Text type="tertiary">暂无邮箱，先导入。</Text>
      </Card>
    );
  }

  return (
    <div>
      <div style={{ marginBottom: 8, paddingLeft: 4 }}>
        <Checkbox checked={allSelected} onChange={onToggleAll}>
          <Text type="tertiary" size="small">
            全选本页
          </Text>
        </Checkbox>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {items.map((m) => {
          const checked = selected.includes(m.email);
          return (
            <Card
              key={m.email}
              bodyStyle={{ padding: 14 }}
              style={{ borderColor: checked ? "var(--semi-color-primary)" : undefined }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                <Checkbox checked={checked} onChange={() => onToggle(m.email)} />
                <Text
                  strong
                  ellipsis={{ showTooltip: true }}
                  style={{ flex: 1, fontSize: 15 }}
                  onClick={() => copy(m.email, "邮箱")}
                >
                  {m.email}
                </Text>
                {statusTag(m)}
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 10, minWidth: 0 }}>
                <Text type="tertiary" size="small" style={{ flexShrink: 0 }}>
                  接码
                </Text>
                {m.fetch_url ? (
                  <>
                    <Text ellipsis={{ showTooltip: true }} style={{ flex: 1, fontSize: 12 }}>
                      {m.fetch_url}
                    </Text>
                    <Button size="small" theme="borderless" icon={<IconCopy />} onClick={() => copy(m.fetch_url, "接码地址")} />
                    <Button
                      size="small"
                      theme="borderless"
                      icon={<IconLink />}
                      onClick={() => window.open(m.fetch_url, "_blank", "noopener")}
                    />
                  </>
                ) : (
                  <Text type="tertiary">—</Text>
                )}
              </div>

              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                <Button
                  size="small"
                  icon={m.used ? <IconClose /> : <IconTick />}
                  style={{ flex: 1 }}
                  onClick={() => onMark(m.email, !m.used)}
                >
                  {m.used ? "标记待注册" : "标记已注册"}
                </Button>
                <Popconfirm title="删除该邮箱？" onConfirm={() => onDelete(m.email)}>
                  <Button size="small" type="danger" theme="borderless" icon={<IconDelete />} />
                </Popconfirm>
              </div>
            </Card>
          );
        })}
      </div>

      {total > pageSize ? (
        <div style={{ display: "flex", justifyContent: "center", marginTop: 16 }}>
          <Pagination total={total} currentPage={page} pageSize={pageSize} onPageChange={onPageChange} />
        </div>
      ) : null}
    </div>
  );
}
