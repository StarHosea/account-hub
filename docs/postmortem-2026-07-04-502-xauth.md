# 生产 502 故障复盘（2026-07-04）

- **现象**：部署后 `hao.shuangdeng.space` 返回 502 Bad Gateway
- **根因**：镜像缺 `xauth`，注册引擎容器入口 `xvfb-run` 启动即崩溃反复重启
- **状态**：已修复（PR #17 / #18 / #19 均合并），站点内外均 200

## 根因

容器入口用 `xvfb-run -a` 启动有头 Xvfb（CloakBrowser 注册引擎需要），`xvfb-run` 依赖 `xauth`。镜像里 `xauth` 不存在 → 启动即 `xauth command not found`（exit 3）→ 反复重启 → 8090 无监听 → OpenResty 502。

**依赖是哪次丢的：**

| 提交 | 动作 | 结果 |
|---|---|---|
| `0a291f4` 引入 Xvfb 引擎 | 装 `xvfb x11-utils xauth` | ✅ 正常 |
| `1fc4b2c` 对齐 CloakBrowser 依赖 | 重写 apt 列表，**误删 x11-utils + xauth** + 加 `--no-install-recommends` | ❌ 502 |
| `6590612` 改 arm64 runner | 只改 CI，与故障无关 |

> 与 ARM 无关，架构一直匹配。是「对齐依赖」那次重写 apt 列表时删掉了运行必需的 `xauth`/`x11-utils`。

## 修复

| PR | 内容 |
|---|---|
| #17 | Dockerfile 补回 `xauth` |
| #18 | Dockerfile 补回 `x11-utils` |
| #19 | deploy 脚本改 `up -d --pull always --force-recreate`，修复"CI 成功但服务器仍跑旧镜像" |

## 关键教训

1. **改 apt 依赖列表时，删除项要逐个核对运行时是否仍需要**——本次即误删运行必需的 `xauth`/`x11-utils`。
2. **Docker Compose + CI 部署必须用 `--pull always --force-recreate`**：`compose up` 在配置未变时不会因 latest digest 更新而重建容器，否则"CI 成功却跑旧镜像"（本次两次踩坑）。
3. **`--no-install-recommends` 的镜像，凡依赖 Recommends 兜底的隐式包都应显式列出**。

## 后续改进

- [ ] 关键系统依赖加构建期断言（如 `RUN command -v xauth`），缺失时让**构建**失败而非**运行**失败。
- [ ] deploy 增加部署后自检：`curl -f 127.0.0.1:8090` + 校验关键二进制，失败即告警。
