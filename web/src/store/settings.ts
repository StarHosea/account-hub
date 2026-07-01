
import { create } from "zustand";
import { toast } from "sonner";

import {
  fetchActivation,
  fetchRegisterConfig,
  fetchSettingsConfig,
  resetRegister as resetRegisterApi,
  startRegister,
  stopRegister,
  updateActivationConfig,
  updateRegisterConfig,
  updateSettingsConfig,
  type ActivationConfig,
  type RegisterConfig,
  type RegisterProvider,
  type RegisterProviderType,
  type SettingsConfig,
} from "@/lib/api";

function normalizeConfig(config: SettingsConfig): SettingsConfig {
  return {
    ...config,
    refresh_account_interval_minute: Number(config.refresh_account_interval_minute || 5),
    auto_remove_invalid_accounts: Boolean(config.auto_remove_invalid_accounts),
    auto_remove_rate_limited_accounts: Boolean(config.auto_remove_rate_limited_accounts),
    auto_relogin_after_refresh: Boolean(config.auto_relogin_after_refresh),
    log_levels: Array.isArray(config.log_levels) ? config.log_levels : [],
    proxy: typeof config.proxy === "string" ? config.proxy : "",
    global_system_prompt: String(config.global_system_prompt || ""),
    sensitive_words: Array.isArray(config.sensitive_words) ? config.sensitive_words : [],
  };
}

type SettingsStore = {
  config: SettingsConfig | null;
  isLoadingConfig: boolean;
  isSavingConfig: boolean;

  registerConfig: RegisterConfig | null;
  isLoadingRegister: boolean;
  isSavingRegister: boolean;

  activationConfig: ActivationConfig | null;
  isLoadingActivationConfig: boolean;
  isSavingActivationConfig: boolean;

  initialize: () => Promise<void>;
  loadConfig: () => Promise<void>;
  saveConfig: () => Promise<boolean>;
  setRefreshAccountIntervalMinute: (value: string) => void;
  setAutoRemoveInvalidAccounts: (value: boolean) => void;
  setAutoRemoveRateLimitedAccounts: (value: boolean) => void;
  setAutoReloginAfterRefresh: (value: boolean) => void;
  setLogLevel: (level: string, enabled: boolean) => void;
  setProxy: (value: string) => void;
  setGlobalSystemPrompt: (value: string) => void;
  setSensitiveWordsText: (value: string) => void;

  loadRegister: (silent?: boolean) => Promise<void>;
  setRegisterConfig: (config: RegisterConfig) => void;
  setRegisterProxy: (value: string) => void;
  setRegisterTotal: (value: string) => void;
  setRegisterThreads: (value: string) => void;
  setRegisterEnable2fa: (value: boolean) => void;
  setRegisterRegions: (values: string[]) => void;
  setRegisterIpwebRotate: (value: boolean) => void;
  setRegisterIpDuration: (value: number) => void;
  setRegisterMailField: (key: "request_timeout" | "wait_timeout" | "wait_interval", value: string) => void;
  setRegisterProviderType: (type: RegisterProviderType) => void;
  updateRegisterProvider: (updates: Partial<RegisterProvider>) => void;
  saveRegister: () => Promise<void>;
  toggleRegister: () => Promise<void>;
  resetRegister: () => Promise<void>;

  loadActivationConfig: () => Promise<void>;
  setActivationConfig: (config: ActivationConfig) => void;
  setActivationConfigField: (
    key: "base_url" | "api_key" | "concurrency" | "poll_interval" | "poll_timeout" | "max_attempts_per_type",
    value: string,
  ) => void;
  setActivationAutoActivate: (value: boolean) => void;
  saveActivationConfig: () => Promise<void>;
};

function buildRegisterPayload(config: RegisterConfig): Partial<RegisterConfig> {
  return {
    mail: config.mail,
    proxy: config.proxy.trim(),
    total: Math.max(1, Number(config.total) || 1),
    threads: Math.max(1, Number(config.threads) || 1),
    enable_2fa: Boolean(config.enable_2fa),
    regions: config.regions && config.regions.length ? config.regions : ["US"],
    ipweb_rotate: Boolean(config.ipweb_rotate),
    ip_duration: Math.min(2880, Math.max(1, Number(config.ip_duration) || 120)),
  };
}

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  config: null,
  isLoadingConfig: true,
  isSavingConfig: false,

  registerConfig: null,
  isLoadingRegister: true,
  isSavingRegister: false,

  activationConfig: null,
  isLoadingActivationConfig: true,
  isSavingActivationConfig: false,

  initialize: async () => {
    await Promise.allSettled([get().loadConfig(), get().loadActivationConfig()]);
  },

  loadConfig: async () => {
    set({ isLoadingConfig: true });
    try {
      const data = await fetchSettingsConfig();
      set({ config: normalizeConfig(data.config) });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "加载系统配置失败");
    } finally {
      set({ isLoadingConfig: false });
    }
  },

  saveConfig: async () => {
    const { config } = get();
    if (!config) {
      return false;
    }

    set({ isSavingConfig: true });
    try {
      const data = await updateSettingsConfig({
        ...config,
        refresh_account_interval_minute: Math.max(1, Number(config.refresh_account_interval_minute) || 1),
        auto_remove_invalid_accounts: Boolean(config.auto_remove_invalid_accounts),
        auto_remove_rate_limited_accounts: Boolean(config.auto_remove_rate_limited_accounts),
        auto_relogin_after_refresh: Boolean(config.auto_relogin_after_refresh),
        proxy: config.proxy.trim(),
        global_system_prompt: String(config.global_system_prompt || "").trim(),
        sensitive_words: (config.sensitive_words || []).map((item) => String(item).trim()).filter(Boolean),
      });
      set({ config: normalizeConfig(data.config) });
      toast.success("配置已保存");
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存系统配置失败");
      return false;
    } finally {
      set({ isSavingConfig: false });
    }
  },

  setRefreshAccountIntervalMinute: (value) => {
    set((state) => (state.config ? { config: { ...state.config, refresh_account_interval_minute: value } } : {}));
  },

  setAutoRemoveInvalidAccounts: (value) => {
    set((state) => (state.config ? { config: { ...state.config, auto_remove_invalid_accounts: value } } : {}));
  },

  setAutoRemoveRateLimitedAccounts: (value) => {
    set((state) => (state.config ? { config: { ...state.config, auto_remove_rate_limited_accounts: value } } : {}));
  },

  setAutoReloginAfterRefresh: (value) => {
    set((state) => (state.config ? { config: { ...state.config, auto_relogin_after_refresh: value } } : {}));
  },

  setLogLevel: (level, enabled) => {
    set((state) => {
      if (!state.config) return {};
      const levels = new Set(state.config.log_levels || []);
      if (enabled) levels.add(level);
      else levels.delete(level);
      return { config: { ...state.config, log_levels: Array.from(levels) } };
    });
  },

  setProxy: (value) => {
    set((state) => (state.config ? { config: { ...state.config, proxy: value } } : {}));
  },

  setGlobalSystemPrompt: (value) => {
    set((state) => (state.config ? { config: { ...state.config, global_system_prompt: value } } : {}));
  },

  setSensitiveWordsText: (value) => {
    set((state) => (state.config ? { config: { ...state.config, sensitive_words: value.split("\n") } } : {}));
  },

  loadRegister: async (silent = false) => {
    if (!silent) set({ isLoadingRegister: true });
    try {
      const data = await fetchRegisterConfig();
      set({ registerConfig: data.register });
    } catch (error) {
      if (!silent) toast.error(error instanceof Error ? error.message : "加载注册配置失败");
    } finally {
      if (!silent) set({ isLoadingRegister: false });
    }
  },

  setRegisterConfig: (config) => {
    set({ registerConfig: config, isLoadingRegister: false });
  },

  setRegisterProxy: (value) => {
    set((state) => (state.registerConfig ? { registerConfig: { ...state.registerConfig, proxy: value } } : {}));
  },

  setRegisterTotal: (value) => {
    set((state) =>
      state.registerConfig ? { registerConfig: { ...state.registerConfig, total: Number(value) || 0 } } : {},
    );
  },

  setRegisterThreads: (value) => {
    set((state) =>
      state.registerConfig ? { registerConfig: { ...state.registerConfig, threads: Number(value) || 0 } } : {},
    );
  },

  setRegisterEnable2fa: (value) => {
    set((state) =>
      state.registerConfig ? { registerConfig: { ...state.registerConfig, enable_2fa: value } } : {},
    );
  },

  setRegisterRegions: (values) => {
    set((state) =>
      state.registerConfig ? { registerConfig: { ...state.registerConfig, regions: values } } : {},
    );
  },

  setRegisterIpwebRotate: (value) => {
    set((state) =>
      state.registerConfig ? { registerConfig: { ...state.registerConfig, ipweb_rotate: value } } : {},
    );
  },

  setRegisterIpDuration: (value) => {
    set((state) =>
      state.registerConfig ? { registerConfig: { ...state.registerConfig, ip_duration: value } } : {},
    );
  },

  setRegisterMailField: (key, value) => {
    set((state) =>
      state.registerConfig
        ? {
            registerConfig: {
              ...state.registerConfig,
              mail: { ...state.registerConfig.mail, [key]: Number(value) || 0 },
            },
          }
        : {},
    );
  },

  setRegisterProviderType: (type) => {
    set((state) => {
      if (!state.registerConfig) return {};
      const existing = state.registerConfig.mail.providers?.[0] || ({} as RegisterProvider);
      const provider: RegisterProvider =
        type === "cloudmail_gen"
          ? {
              type,
              enable: true,
              api_base: String(existing.api_base || ""),
              admin_email: String(existing.admin_email || ""),
              admin_password: String(existing.admin_password || ""),
              domain: Array.isArray(existing.domain) ? existing.domain : [],
              subdomain: Array.isArray(existing.subdomain) ? existing.subdomain : [],
              email_prefix: String(existing.email_prefix || ""),
            }
          : { type, enable: true };
      return {
        registerConfig: {
          ...state.registerConfig,
          mail: { ...state.registerConfig.mail, providers: [provider] },
        },
      };
    });
  },

  updateRegisterProvider: (updates) => {
    set((state) => {
      if (!state.registerConfig) return {};
      const providers = [...(state.registerConfig.mail.providers || [])];
      const current = providers[0] || ({ type: "api_mailbox", enable: true } as RegisterProvider);
      providers[0] = { ...current, ...updates };
      return {
        registerConfig: { ...state.registerConfig, mail: { ...state.registerConfig.mail, providers } },
      };
    });
  },

  saveRegister: async () => {
    const { registerConfig } = get();
    if (!registerConfig) return;
    try {
      set({ isSavingRegister: true });
      const data = await updateRegisterConfig(buildRegisterPayload(registerConfig));
      set({ registerConfig: data.register });
      toast.success("注册配置已保存");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存注册配置失败");
    } finally {
      set({ isSavingRegister: false });
    }
  },

  toggleRegister: async () => {
    const { registerConfig } = get();
    if (!registerConfig) return;
    set({ isSavingRegister: true });
    try {
      if (!registerConfig.enabled) {
        await updateRegisterConfig(buildRegisterPayload(registerConfig));
      }
      const data = registerConfig.enabled ? await stopRegister() : await startRegister();
      set({ registerConfig: data.register });
      toast.success(registerConfig.enabled ? "注册任务已停止" : "注册任务已启动");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "切换注册状态失败");
    } finally {
      set({ isSavingRegister: false });
    }
  },

  resetRegister: async () => {
    set({ isSavingRegister: true });
    try {
      const data = await resetRegisterApi();
      set({ registerConfig: data.register });
      toast.success("注册统计已重置");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "重置注册统计失败");
    } finally {
      set({ isSavingRegister: false });
    }
  },

  loadActivationConfig: async () => {
    set({ isLoadingActivationConfig: true });
    try {
      const data = await fetchActivation();
      set({ activationConfig: data.config });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "加载 Plus 激活配置失败");
    } finally {
      set({ isLoadingActivationConfig: false });
    }
  },

  setActivationConfig: (config) => {
    set({ activationConfig: config });
  },

  setActivationConfigField: (key, value) => {
    set((state) => {
      if (!state.activationConfig) return {};
      if (key === "base_url" || key === "api_key") {
        return { activationConfig: { ...state.activationConfig, [key]: value } };
      }
      return { activationConfig: { ...state.activationConfig, [key]: Number(value) || 0 } };
    });
  },

  setActivationAutoActivate: (value) => {
    set((state) =>
      state.activationConfig
        ? { activationConfig: { ...state.activationConfig, auto_activate_after_register: value } }
        : {},
    );
  },

  saveActivationConfig: async () => {
    const { activationConfig } = get();
    if (!activationConfig) return;
    set({ isSavingActivationConfig: true });
    try {
      const data = await updateActivationConfig({
        base_url: String(activationConfig.base_url || "").trim(),
        concurrency: Math.max(1, Number(activationConfig.concurrency) || 1),
        poll_interval: Math.max(1, Number(activationConfig.poll_interval) || 1),
        poll_timeout: Math.max(1, Number(activationConfig.poll_timeout) || 1),
        max_attempts_per_type: Math.max(1, Number(activationConfig.max_attempts_per_type) || 1),
        auto_activate_after_register: Boolean(activationConfig.auto_activate_after_register),
        // 仅在用户填写了新 api_key 时提交（写入式字段）
        ...(activationConfig.api_key ? { api_key: activationConfig.api_key } : {}),
      });
      set({ activationConfig: data.config });
      toast.success("Plus 激活配置已保存");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存 Plus 激活配置失败");
    } finally {
      set({ isSavingActivationConfig: false });
    }
  },
}));
