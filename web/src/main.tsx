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
