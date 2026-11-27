# stash-hub

个人维护的 [Stash](https://stash.wiki/) 覆写（`.stoverride`）与配套脚本仓库。

## 覆写清单

| 名称 | 说明 | 覆写链接 | 一键安装 |
| :--- | :--- | :--- | :--- |
| **YouTube AdBlock (iOS App)** | 去除 YouTube iOS App 首页信息流、推荐流、搜索结果、播放页横幅、片头/片中/片尾及 Shorts 广告 | [Raw](https://raw.githubusercontent.com/xyz2332/stash-hub/main/overrides/youtube-adblock.stoverride) | [![安装到 Stash](https://img.shields.io/badge/安装到-Stash-007AFF?style=flat-square)](https://link.stash.ws/install-override/raw.githubusercontent.com/xyz2332/stash-hub/main/overrides/youtube-adblock.stoverride) |

## 目录结构

```text
stash-hub/
├── overrides/               # Stash 覆写文件（.stoverride）
├── scripts/                 # 配套 JS 脚本（与覆写同名对应）
├── .github/workflows/       # 自动校验 YAML 与 JS 语法的 GitHub Actions
└── README.md
```

## 使用说明

1. 在 Stash 中确保已开启 **MitM**（并信任 CA 证书）、**重写** 与 **脚本** 总开关。
2. 点击上方「安装到 Stash」，或在 Stash 的「覆写 → 从链接下载」中填入对应 Raw 地址。
3. 更新规则或脚本后推送至 `main` 分支，在 Stash 中点击「更新外部资源」即可拉取最新版本。
