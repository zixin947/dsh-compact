# dsh-compact 独立仓库设计

## 目标

在 GitHub 账号 `zixin947` 下创建公开仓库 `dsh-compact`，用于独立维护和分发 DeepSeek Harness 的上下文压缩插件。仓库首个版本沿用 EAC 主项目 PR #145 中已经验证的插件实现。

## 仓库内容

首版只包含插件运行与使用所需内容：

- `lib/`：插件服务端、客户端、策略、压缩引擎和复合 Agent 入口。
- `package.json`：包入口、导出、DSH 元数据、依赖和 GitHub 仓库信息。
- `cordis.patch.yml`：默认挂载 `dsh-compact`。
- `README.md`：中文功能说明、安装方法、配置项、工作机制和注意事项。
- `LICENSE`：MIT License。
- `.gitignore`：忽略依赖、日志和本地构建产物。

EAC 主项目的 preset 迁移器、桌面宿主代码和集成测试不复制到独立仓库，因为它们属于 EAC 产品集成层，不属于插件本体。

## 发布方式

- GitHub 仓库：`https://github.com/zixin947/dsh-compact`
- 可见性：公开。
- 默认分支：`main`。
- 初始版本：`1.0.0`。
- 首次提交使用当前已通过测试的插件源码。
- 暂不配置 npm 自动发布和独立 CI；插件继续在 EAC 主项目中完成集成测试。

## README 内容

README 使用中文，至少包括：

1. 插件简介和适用范围。
2. 自动压缩、手动 `/compact`、工具结果裁剪和溢出恢复能力。
3. GitHub 安装示例及 EAC 内置版本说明。
4. `thresholdRatio`、`retainRatio`、`recoverOnOverflow`、`maxOverflowRetries` 和模型覆盖配置。
5. 单次压力检查最多生成一次摘要的行为说明。
6. 安全边界、兼容版本、许可证和问题反馈入口。

## 验证标准

- 独立仓库文件与 EAC PR #145 中的插件源码一致。
- `package.json` 可以被 Node.js 正常解析，导出文件全部存在。
- 默认参数保持 `thresholdRatio: 0.75`、`retainRatio: 0.20`。
- `compactionRetries` 保持为 `0`，避免同一回合连续压缩。
- Git 工作区干净，远程 `main` 与本地首个版本一致。

