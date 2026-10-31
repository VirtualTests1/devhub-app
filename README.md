# DevHub

Windows 桌面应用：把 GitHub 项目集中到一个图标墙，完成搜索、下载、启动和清理。

[![CI](https://github.com/VirtualTests1/devhub-app/actions/workflows/ci.yml/badge.svg)](https://github.com/VirtualTests1/devhub-app/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/VirtualTests1/devhub-app?display_name=tag)](https://github.com/VirtualTests1/devhub-app/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## 功能

- **项目墙**：搜索、排序、置顶、拖拽、多选。
- **下载**：`owner/repo` 或 GitHub 链接；自动降级网络、显示进度、支持重试和取消。
- **启动**：识别项目类型并生成命令；确认后运行，支持多步骤、暂停、停止和端口分配。
- **设置**：别名、封面、启动命令、端口段、Python 环境、分支。
- **记录与诊断**：操作记录、失败历史、网络诊断、环境状态；跨仓库健康、许可证与密钥卫生扫描（本地、只读）。
- **外观**：浅色/深色/跟随系统；部分界面支持英文（尚未全量翻译）。

## 环境

- Windows 10/11，WebView2。
- 源码构建：Node.js 22.6+、pnpm 10+、Rust、MSVC。测试直接用 `node --experimental-strip-types` 运行 `.ts`，该参数自 Node 22.6.0 引入（CI 用 22.x 验证）。

## 运行

```powershell
pnpm install
pnpm tauri dev
```

首次下载项目时如果没有 Git，点界面上的「自动安装内置 Git」即可；它把便携 Git 装到应用自己的目录，不需要管理员权限，也不改系统 Git。

完整步骤、便携版用法与这台机器上的构建注意事项见 [使用指南](portable/使用说明.md)。

## 构建

```powershell
pnpm tauri build --no-bundle
.\scripts\pack-portable.ps1
```

产物在 `src-tauri/target/release/`；便携 ZIP 在 `.pack/`。

## 测试

```powershell
pnpm test
pnpm gate
pnpm test:rust
```

## 目录

```
src/            React 前端
src-tauri/      Rust / Tauri 后端
tests/          前端测试
scripts/        构建、检查与验证脚本
portable/       便携版资源
```

## 发布

[GitHub Releases](https://github.com/VirtualTests1/devhub-app/releases) — 版本说明与源码包。当前版本仅提供源码，不含预编译安装包。

## 许可证

MIT
