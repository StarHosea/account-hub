"use client";

import { LoaderCircle, Save, Zap } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

import { useSettingsStore } from "../store";

export function ActivationConfigCard() {
  const config = useSettingsStore((state) => state.activationConfig);
  const isLoading = useSettingsStore((state) => state.isLoadingActivationConfig);
  const isSaving = useSettingsStore((state) => state.isSavingActivationConfig);
  const setField = useSettingsStore((state) => state.setActivationConfigField);
  const setAutoActivate = useSettingsStore((state) => state.setActivationAutoActivate);
  const save = useSettingsStore((state) => state.saveActivationConfig);

  return (
    <Card className="rounded-2xl border-white/80 bg-white/90 shadow-sm">
      <CardContent className="space-y-6 p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-xl bg-stone-100">
              <Zap className="size-5 text-stone-600" />
            </div>
            <div>
              <h2 className="text-lg font-semibold tracking-tight">Plus 激活配置</h2>
              <p className="text-sm text-stone-500">配置 CDK 兑换上游地址、密钥与并发参数，号池管理页用于批量激活 Plus。</p>
            </div>
          </div>
          <Badge variant={config?.has_api_key ? "success" : "secondary"} className="w-fit rounded-md px-2.5 py-1">
            {config?.has_api_key ? "API Key 已配置" : "API Key 未配置"}
          </Badge>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-10">
            <LoaderCircle className="size-5 animate-spin text-stone-400" />
          </div>
        ) : (
          <>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2 md:col-span-2">
                <label className="text-sm text-stone-700">上游 Base URL</label>
                <Input
                  value={String(config?.base_url || "")}
                  onChange={(event) => setField("base_url", event.target.value)}
                  placeholder="https://example.com"
                  className="h-10 rounded-xl border-stone-200 bg-white"
                />
              </div>
              <div className="space-y-2 md:col-span-2">
                <label className="text-sm text-stone-700">API Key</label>
                <Input
                  type="password"
                  value={String(config?.api_key || "")}
                  onChange={(event) => setField("api_key", event.target.value)}
                  placeholder={config?.has_api_key ? "已配置，留空则保持不变" : "请输入 API Key"}
                  className="h-10 rounded-xl border-stone-200 bg-white"
                />
                <p className="text-xs text-stone-500">出于安全考虑不会回显，留空保存则保持原有密钥不变。</p>
              </div>
              <div className="space-y-2">
                <label className="text-sm text-stone-700">并发数</label>
                <Input
                  value={String(config?.concurrency ?? "")}
                  onChange={(event) => setField("concurrency", event.target.value)}
                  className="h-10 rounded-xl border-stone-200 bg-white"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm text-stone-700">每类型最大尝试次数</label>
                <Input
                  value={String(config?.max_attempts_per_type ?? "")}
                  onChange={(event) => setField("max_attempts_per_type", event.target.value)}
                  className="h-10 rounded-xl border-stone-200 bg-white"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm text-stone-700">轮询间隔（秒）</label>
                <Input
                  value={String(config?.poll_interval ?? "")}
                  onChange={(event) => setField("poll_interval", event.target.value)}
                  className="h-10 rounded-xl border-stone-200 bg-white"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm text-stone-700">轮询超时（秒）</label>
                <Input
                  value={String(config?.poll_timeout ?? "")}
                  onChange={(event) => setField("poll_timeout", event.target.value)}
                  className="h-10 rounded-xl border-stone-200 bg-white"
                />
              </div>
            </div>

            <label className="flex items-start gap-3 rounded-xl border border-stone-200 bg-stone-50/60 p-4">
              <input
                type="checkbox"
                checked={Boolean(config?.auto_activate_after_register)}
                onChange={(event) => setAutoActivate(event.target.checked)}
                className="mt-0.5 size-4 accent-stone-900"
              />
              <span className="text-sm">
                <span className="font-medium text-stone-800">注册成功后自动激活 Plus</span>
                <span className="mt-0.5 block text-xs text-stone-500">
                  注册机每注册成功一个账号，若有可用 CDK 且已配置 API Key，自动匹配 CDK 尝试激活 Plus（UPI/IDEL 各 3 次）。
                </span>
              </span>
            </label>

            <div className="flex justify-end">
              <Button
                className="h-10 rounded-xl bg-stone-950 px-5 text-white hover:bg-stone-800"
                onClick={() => void save()}
                disabled={isSaving}
              >
                {isSaving ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}
                保存配置
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
