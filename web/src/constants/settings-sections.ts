export const SETTINGS_SECTIONS = [
  { id: "settings-base", label: "基础设置" },
  { id: "settings-register", label: "注册配置" },
  { id: "settings-activation", label: "激活设置" },
  { id: "settings-static-cache", label: "缓存设置" },
  { id: "settings-mail", label: "邮箱配置" },
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];
