import { Typography } from "@douyinfe/semi-ui-19";
import type { ImportLineIssue } from "@/lib/import-validation";

const { Text } = Typography;

type Props = {
  count: number;
  unit?: string;
  maxRows?: number;
  issues?: ImportLineIssue[];
  maxIssueShow?: number;
};

/** 导入弹窗内文本框下方的实时条数与格式校验提示。 */
export default function ImportCountHint({
  count,
  unit = "条",
  maxRows,
  issues = [],
  maxIssueShow = 4,
}: Props) {
  const overLimit = maxRows != null && count > maxRows;
  const issueCount = issues.length;
  const shownIssues = issues.slice(0, maxIssueShow);
  const hiddenIssueCount = Math.max(0, issueCount - shownIssues.length);

  return (
    <div style={{ marginTop: 6 }}>
      {shownIssues.map((issue) => (
        <Text key={`${issue.line}-${issue.message}`} type="danger" size="small" style={{ display: "block" }}>
          第 {issue.line} 行：{issue.message}
          {issue.text ? `（${issue.text}）` : ""}
        </Text>
      ))}
      {hiddenIssueCount > 0 && (
        <Text type="danger" size="small" style={{ display: "block" }}>
          另有 {hiddenIssueCount} 行格式错误…
        </Text>
      )}
      <Text
        type={overLimit || issueCount > 0 ? "danger" : "tertiary"}
        size="small"
        style={{ display: "block", marginTop: issueCount > 0 ? 4 : 0, textAlign: "right" }}
      >
        {issueCount > 0 ? `可导入 ${count} ${unit}，${issueCount} 行格式错误` : `当前 ${count} ${unit}`}
        {overLimit && maxRows != null ? `（超出上限 ${maxRows}）` : ""}
      </Text>
    </div>
  );
}
