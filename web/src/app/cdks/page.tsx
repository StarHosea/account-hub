"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  KeySquare,
  LoaderCircle,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  deleteCdks,
  exportCdks,
  fetchCdks,
  importCdks,
  type Cdk,
  type CdkCounts,
  type CdkStatus,
  type CdkType,
} from "@/lib/api";
import { useAuthGuard } from "@/lib/use-auth-guard";
import { cn } from "@/lib/utils";

const emptyCounts: CdkCounts = {
  by_type: { UPI: { available: 0, used: 0, invalid: 0 }, IDEL: { available: 0, used: 0, invalid: 0 } },
  available: 0,
  total: 0,
};

const statusLabel: Record<CdkStatus, string> = {
  available: "可用",
  used: "已用",
  invalid: "无效",
};

const statusBadge: Record<CdkStatus, "success" | "secondary" | "danger"> = {
  available: "success",
  used: "secondary",
  invalid: "danger",
};

function maskCdk(cdk: string) {
  if (cdk.length <= 12) return cdk;
  return `${cdk.slice(0, 6)}...${cdk.slice(-4)}`;
}

function maskToken(token?: string | null) {
  if (!token) return "—";
  if (token.length <= 18) return token;
  return `${token.slice(0, 12)}...${token.slice(-6)}`;
}

function formatDateTime(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function CdksPageContent() {
  const didLoadRef = useRef(false);
  const [cdks, setCdks] = useState<Cdk[]>([]);
  const [counts, setCounts] = useState<CdkCounts>(emptyCounts);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [typeFilter, setTypeFilter] = useState<CdkType | "all">("all");
  const [statusFilter, setStatusFilter] = useState<CdkStatus | "all">("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState("10");
  const [isLoading, setIsLoading] = useState(true);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importType, setImportType] = useState<CdkType>("UPI");
  const [isImporting, setIsImporting] = useState(false);

  const loadCdks = async () => {
    setIsLoading(true);
    try {
      const data = await fetchCdks();
      setCdks(data.items);
      setCounts(data.counts);
      setSelectedIds((prev) => prev.filter((id) => data.items.some((item) => item.cdk === id)));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "加载 CDK 列表失败");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (didLoadRef.current) return;
    didLoadRef.current = true;
    void loadCdks();
  }, []);

  const filtered = useMemo(() => {
    return cdks.filter((item) => {
      const typeMatched = typeFilter === "all" || item.type === typeFilter;
      const statusMatched = statusFilter === "all" || item.status === statusFilter;
      return typeMatched && statusMatched;
    });
  }, [cdks, statusFilter, typeFilter]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / Number(pageSize)));
  const safePage = Math.min(page, pageCount);
  const startIndex = (safePage - 1) * Number(pageSize);
  const currentRows = filtered.slice(startIndex, startIndex + Number(pageSize));
  const allCurrentSelected = currentRows.length > 0 && currentRows.every((row) => selectedIds.includes(row.cdk));

  const selectedCdks = useMemo(() => {
    const set = new Set(selectedIds);
    return cdks.filter((item) => set.has(item.cdk)).map((item) => item.cdk);
  }, [cdks, selectedIds]);

  const summaryCards = useMemo(
    () => [
      { key: "available", label: "可用总数", value: counts.available, color: "text-emerald-600" },
      { key: "total", label: "CDK 总数", value: counts.total, color: "text-stone-900" },
      {
        key: "upi",
        label: "UPI（可用/已用/无效）",
        value: `${counts.by_type.UPI.available} / ${counts.by_type.UPI.used} / ${counts.by_type.UPI.invalid}`,
        color: "text-blue-500",
      },
      {
        key: "idel",
        label: "IDEL（可用/已用/无效）",
        value: `${counts.by_type.IDEL.available} / ${counts.by_type.IDEL.used} / ${counts.by_type.IDEL.invalid}`,
        color: "text-violet-500",
      },
    ],
    [counts],
  );

  const paginationItems = useMemo(() => {
    const items: (number | "...")[] = [];
    const start = Math.max(1, safePage - 1);
    const end = Math.min(pageCount, safePage + 1);
    if (start > 1) items.push(1);
    if (start > 2) items.push("...");
    for (let current = start; current <= end; current += 1) items.push(current);
    if (end < pageCount - 1) items.push("...");
    if (end < pageCount) items.push(pageCount);
    return items;
  }, [pageCount, safePage]);

  const toggleSelectAll = (checked: boolean) => {
    if (checked) {
      setSelectedIds((prev) => Array.from(new Set([...prev, ...currentRows.map((item) => item.cdk)])));
      return;
    }
    setSelectedIds((prev) => prev.filter((id) => !currentRows.some((row) => row.cdk === id)));
  };

  const handleImport = async () => {
    if (!importText.trim()) {
      toast.error("请先粘贴要导入的 CDK");
      return;
    }
    setIsImporting(true);
    try {
      const data = await importCdks(importText, importType);
      setCdks(data.items);
      setCounts(data.counts);
      setImportText("");
      setImportOpen(false);
      setPage(1);
      toast.success(`导入完成，新增 ${data.result.added} 个，更新 ${data.result.updated} 个`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "导入 CDK 失败");
    } finally {
      setIsImporting(false);
    }
  };

  const handleDelete = async (items: string[]) => {
    if (items.length === 0) {
      toast.error("请先选择要删除的 CDK");
      return;
    }
    setIsDeleting(true);
    try {
      const data = await deleteCdks(items);
      setCdks(data.items);
      setCounts(data.counts);
      setSelectedIds((prev) => prev.filter((id) => data.items.some((item) => item.cdk === id)));
      toast.success(`删除 ${data.removed} 个 CDK`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除 CDK 失败");
    } finally {
      setIsDeleting(false);
    }
  };

  const handleExport = async (type?: CdkType) => {
    setIsExporting(true);
    try {
      await exportCdks(type);
      toast.success("导出已开始下载");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "导出 CDK 失败");
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <>
      <section className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-1">
          <div className="text-xs font-semibold tracking-[0.18em] text-stone-500 uppercase">CDK</div>
          <h1 className="text-2xl font-semibold tracking-tight">CDK 管理</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            className="h-10 rounded-xl border-stone-200 bg-white/80 px-4 text-stone-700 hover:bg-white"
            onClick={() => void loadCdks()}
            disabled={isLoading}
          >
            <RefreshCw className={cn("size-4", isLoading ? "animate-spin" : "")} />
            刷新
          </Button>
          <Button
            className="h-10 rounded-xl bg-stone-950 px-4 text-white hover:bg-stone-800"
            onClick={() => setImportOpen(true)}
          >
            <Upload className="size-4" />
            导入
          </Button>
          <Select
            value="export"
            onValueChange={(value) => {
              if (value === "all") void handleExport();
              else if (value === "UPI") void handleExport("UPI");
              else if (value === "IDEL") void handleExport("IDEL");
            }}
          >
            <SelectTrigger
              className="h-10 w-[120px] rounded-xl border-stone-200 bg-white/80 px-4 text-stone-700"
              disabled={isExporting}
            >
              <span className="flex items-center gap-2 text-sm">
                {isExporting ? <LoaderCircle className="size-4 animate-spin" /> : <Download className="size-4" />}
                导出
              </span>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">导出全部</SelectItem>
              <SelectItem value="UPI">仅导出 UPI</SelectItem>
              <SelectItem value="IDEL">仅导出 IDEL</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </section>

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {summaryCards.map((item) => (
          <Card key={item.key} className="rounded-2xl border-white/80 bg-white/90 shadow-sm">
            <CardContent className="p-4">
              <div className="mb-4 flex items-start justify-between">
                <span className="text-xs font-medium text-stone-400">{item.label}</span>
                <KeySquare className="size-4 text-stone-400" />
              </div>
              <div className={cn("font-semibold tracking-tight", item.color, typeof item.value === "number" ? "text-[1.75rem]" : "text-lg")}>
                {item.value}
              </div>
            </CardContent>
          </Card>
        ))}
      </section>

      <section className="space-y-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold tracking-tight">CDK 列表</h2>
            <Badge variant="secondary" className="rounded-lg bg-stone-200 px-2 py-0.5 text-stone-700">
              {filtered.length}
            </Badge>
          </div>
          <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
            <Select
              value={typeFilter}
              onValueChange={(value) => {
                setTypeFilter(value as CdkType | "all");
                setPage(1);
              }}
            >
              <SelectTrigger className="h-10 w-full rounded-xl border-stone-200 bg-white/85 lg:w-[150px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部类型</SelectItem>
                <SelectItem value="UPI">UPI</SelectItem>
                <SelectItem value="IDEL">IDEL</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={statusFilter}
              onValueChange={(value) => {
                setStatusFilter(value as CdkStatus | "all");
                setPage(1);
              }}
            >
              <SelectTrigger className="h-10 w-full rounded-xl border-stone-200 bg-white/85 lg:w-[150px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部状态</SelectItem>
                <SelectItem value="available">可用</SelectItem>
                <SelectItem value="used">已用</SelectItem>
                <SelectItem value="invalid">无效</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <Card className="overflow-hidden rounded-2xl border-white/80 bg-white/90 shadow-sm">
          <CardContent className="space-y-0 p-0">
            <div className="flex flex-wrap items-center gap-2 border-b border-stone-100 px-4 py-3 text-sm text-stone-500">
              <Button
                variant="ghost"
                className="h-8 rounded-lg px-3 text-rose-500 hover:bg-rose-50 hover:text-rose-600"
                onClick={() => void handleDelete(selectedCdks)}
                disabled={selectedCdks.length === 0 || isDeleting}
              >
                {isDeleting ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                删除选中
              </Button>
              {selectedIds.length > 0 ? (
                <span className="rounded-lg bg-stone-100 px-2.5 py-1 text-xs font-medium text-stone-600">
                  已选择 {selectedIds.length} 项
                </span>
              ) : null}
            </div>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] text-left">
                <thead className="border-b border-stone-100 text-[11px] uppercase tracking-[0.18em] text-stone-400">
                  <tr>
                    <th className="w-12 px-4 py-3">
                      <Checkbox
                        checked={allCurrentSelected}
                        onCheckedChange={(checked) => toggleSelectAll(Boolean(checked))}
                      />
                    </th>
                    <th className="w-64 px-4 py-3">CDK</th>
                    <th className="w-24 px-4 py-3">类型</th>
                    <th className="w-24 px-4 py-3">状态</th>
                    <th className="w-48 px-4 py-3">绑定账号</th>
                    <th className="w-32 px-4 py-3">导入时间</th>
                    <th className="w-24 px-4 py-3">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {currentRows.map((item) => (
                    <tr
                      key={item.cdk}
                      className="border-b border-stone-100/80 text-sm text-stone-600 transition-colors hover:bg-stone-50/70"
                    >
                      <td className="px-4 py-3">
                        <Checkbox
                          checked={selectedIds.includes(item.cdk)}
                          onCheckedChange={(checked) => {
                            setSelectedIds((prev) =>
                              checked
                                ? Array.from(new Set([...prev, item.cdk]))
                                : prev.filter((id) => id !== item.cdk),
                            );
                          }}
                        />
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-xs text-stone-700" title={item.cdk}>
                            {maskCdk(item.cdk)}
                          </span>
                          <button
                            type="button"
                            className="rounded-lg p-1 text-stone-400 transition hover:bg-stone-100 hover:text-stone-700"
                            onClick={() => {
                              void navigator.clipboard.writeText(item.cdk);
                              toast.success("CDK 已复制");
                            }}
                          >
                            <Copy className="size-4" />
                          </button>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant="outline" className="rounded-md border-stone-200 text-stone-600">
                          {item.type}
                        </Badge>
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant={statusBadge[item.status]} className="rounded-md">
                          {statusLabel[item.status]}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-xs leading-5 text-stone-500">{maskToken(item.bound_token)}</td>
                      <td className="px-4 py-3 text-xs leading-5 text-stone-500">{formatDateTime(item.imported_at)}</td>
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          className="rounded-lg p-2 text-stone-400 transition hover:bg-rose-50 hover:text-rose-500"
                          onClick={() => void handleDelete([item.cdk])}
                          disabled={isDeleting}
                        >
                          <Trash2 className="size-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {!isLoading && currentRows.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
                  <div className="rounded-xl bg-stone-100 p-3 text-stone-500">
                    <KeySquare className="size-5" />
                  </div>
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-stone-700">没有匹配的 CDK</p>
                    <p className="text-sm text-stone-500">导入 CDK 或调整筛选条件后重试。</p>
                  </div>
                </div>
              ) : null}
            </div>

            <div className="border-t border-stone-100 px-4 py-4">
              <div className="flex items-center justify-center gap-3 overflow-x-auto whitespace-nowrap">
                <div className="shrink-0 text-sm text-stone-500">
                  显示第 {filtered.length === 0 ? 0 : startIndex + 1} -{" "}
                  {Math.min(startIndex + Number(pageSize), filtered.length)} 条，共 {filtered.length} 条
                </div>
                <span className="shrink-0 text-sm leading-none text-stone-500">
                  {safePage} / {pageCount} 页
                </span>
                <Select
                  value={pageSize}
                  onValueChange={(value) => {
                    setPageSize(value);
                    setPage(1);
                  }}
                >
                  <SelectTrigger className="h-10 w-[108px] shrink-0 rounded-lg border-stone-200 bg-white text-sm leading-none">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="10">10 / 页</SelectItem>
                    <SelectItem value="20">20 / 页</SelectItem>
                    <SelectItem value="50">50 / 页</SelectItem>
                    <SelectItem value="100">100 / 页</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  variant="outline"
                  size="icon"
                  className="size-10 shrink-0 rounded-lg border-stone-200 bg-white"
                  disabled={safePage <= 1}
                  onClick={() => setPage((prev) => Math.max(1, prev - 1))}
                >
                  <ChevronLeft className="size-4" />
                </Button>
                {paginationItems.map((item, index) =>
                  item === "..." ? (
                    <span key={`ellipsis-${index}`} className="px-1 text-sm text-stone-400">
                      ...
                    </span>
                  ) : (
                    <Button
                      key={item}
                      variant={item === safePage ? "default" : "outline"}
                      className={cn(
                        "h-10 min-w-10 shrink-0 rounded-lg px-3",
                        item === safePage
                          ? "bg-stone-950 text-white hover:bg-stone-800"
                          : "border-stone-200 bg-white text-stone-700",
                      )}
                      onClick={() => setPage(item)}
                    >
                      {item}
                    </Button>
                  ),
                )}
                <Button
                  variant="outline"
                  size="icon"
                  className="size-10 shrink-0 rounded-lg border-stone-200 bg-white"
                  disabled={safePage >= pageCount}
                  onClick={() => setPage((prev) => Math.min(pageCount, prev + 1))}
                >
                  <ChevronRight className="size-4" />
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </section>

      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent showCloseButton={false} className="rounded-2xl p-6">
          <DialogHeader className="gap-2">
            <DialogTitle>导入 CDK</DialogTitle>
            <DialogDescription className="text-sm leading-6">一行一个 CDK，选择对应类型后导入。</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium text-stone-700">类型</label>
              <Select value={importType} onValueChange={(value) => setImportType(value as CdkType)}>
                <SelectTrigger className="h-11 rounded-xl border-stone-200 bg-white">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="UPI">UPI</SelectItem>
                  <SelectItem value="IDEL">IDEL</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-stone-700">CDK 列表</label>
              <Textarea
                value={importText}
                onChange={(event) => setImportText(event.target.value)}
                placeholder={"一行一个 CDK..."}
                className="min-h-56 resize-none rounded-xl border-stone-200 font-mono text-xs"
              />
            </div>
          </div>
          <DialogFooter className="pt-2">
            <Button
              variant="secondary"
              className="h-10 rounded-xl bg-stone-100 px-5 text-stone-700 hover:bg-stone-200"
              onClick={() => setImportOpen(false)}
              disabled={isImporting}
            >
              取消
            </Button>
            <Button
              className="h-10 rounded-xl bg-stone-950 px-5 text-white hover:bg-stone-800"
              onClick={() => void handleImport()}
              disabled={isImporting}
            >
              {isImporting ? <LoaderCircle className="size-4 animate-spin" /> : <Upload className="size-4" />}
              导入
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default function CdksPage() {
  const { isCheckingAuth, session } = useAuthGuard(["admin"]);

  if (isCheckingAuth || !session || session.role !== "admin") {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <LoaderCircle className="size-5 animate-spin text-stone-400" />
      </div>
    );
  }

  return <CdksPageContent />;
}
