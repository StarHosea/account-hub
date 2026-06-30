// SPA：apiUrl 留空走同源，dev 由 Vite proxy 把 /api 转发到 :8000，生产由后端同源托管。
const webConfig = {
  apiUrl: "",
  appVersion: import.meta.env.VITE_APP_VERSION || "0.0.0",
};

export default webConfig;
