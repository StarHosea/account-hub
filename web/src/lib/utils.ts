import { clsx, type ClassValue } from "clsx";
import { validateAccountImport } from "@/lib/import-validation";

export function cn(...inputs: ClassValue[]) {
  return clsx(inputs);
}

/** 单次批量导入上限，与后端 services/*_service.py 的 MAX_IMPORT_ROWS 保持一致。 */
export const MAX_IMPORT_ROWS = 2000;

/** 统计批量导入文本的有效行数（去掉空行与 # 注释行），用于提交前的上限预检。 */
export function countImportRows(text: string): number {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#")).length;
}

/** 统计账号导入文本中的条目数（JSON / 账号池 / access_token 逐行）。 */
export function countAccountImportItems(text: string): number {
  return validateAccountImport(text).validCount;
}
