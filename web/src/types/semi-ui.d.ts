import "@douyinfe/semi-ui-19";

// Semi 的 Table 运行时支持 `tableLayout`（见组件 propTypes / defaultProps），
// 但其类型定义 TableProps 漏声明了该字段，导致使用处报 TS2322。这里按运行时取值补齐声明。
declare module "@douyinfe/semi-ui-19/lib/es/table/interface" {
  interface TableProps<RecordType extends Record<string, any> = any> {
    tableLayout?: "" | "fixed" | "auto";
  }
}
