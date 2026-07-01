// React 19 下 Semi 需手动注入 createRoot，否则 Toast/Modal 等 portal 组件不渲染。
// 必须在任何 Semi 组件渲染前执行，故置于所有导入之前。
// 参考：https://semi.design/zh-CN/ecosystem/react19
import "@douyinfe/semi-ui-19/react19-adapter";

import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import "@/styles/global.css";

import App from "@/App";

// 私密管理路径：后端注入 window.__ADMIN_BASE__；dev 下占位未替换则按根路径。
const injected = (window as unknown as { __ADMIN_BASE__?: string }).__ADMIN_BASE__ || "";
const basename = injected && !injected.includes("%%") ? injected : undefined;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter basename={basename}>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
