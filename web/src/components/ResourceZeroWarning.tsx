import { Space, Typography } from "@douyinfe/semi-ui-19";
import { IconAlertTriangle } from "@douyinfe/semi-icons";

const { Text } = Typography;

type Props = {
  title?: string;
  hints: string[];
};

/** 启动前资源不足时的醒目提示条。 */
export default function ResourceZeroWarning({ title = "暂时无法启动", hints }: Props) {
  if (!hints.length) return null;
  return (
    <div
      style={{
        marginBottom: 16,
        padding: "12px 16px",
        borderRadius: 8,
        background: "var(--semi-color-warning-light-default)",
        border: "1px solid var(--semi-color-warning-light-active)",
      }}
    >
      <Space vertical align="start" spacing={6}>
        <Space align="center" spacing={6}>
          <IconAlertTriangle style={{ color: "var(--semi-color-warning)", fontSize: 16 }} />
          <Text strong style={{ color: "var(--semi-color-warning)" }}>
            {title}
          </Text>
        </Space>
        {hints.map((hint) => (
          <Text key={hint} size="small" type="secondary" style={{ paddingLeft: 22 }}>
            {hint}
          </Text>
        ))}
      </Space>
    </div>
  );
}
