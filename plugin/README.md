# DSH 原生接入

用本地 link 将 `dsh-bili-fav-plugin` 安装到 DSH profile。

1. 在 profile 的 `package.json` 中添加依赖，例如 `"dsh-bili-fav-plugin": "link:/absolute/path/to/bili-fav/plugin"`。Windows 可在路径中使用正斜杠。
2. 在 `dsh.profile.bundles` 数组添加 `"dsh-bili-fav-plugin"`。
3. 在 profile 目录执行 `pnpm install`，重启 DSH。

工具列表应出现 `bili_library`、`bili_find`、`bili_feed`、`bili_read` 和 `bili_note`。证据包里的文件可以由 DSH 的本地文件读取工具打开。

`projectRoot` 默认从 link 指向的项目推算。插件以复制方式安装时，在 DSH 插件配置里将它设为 Bili Fav 项目根目录。工具超时配置项为 `timeoutMs`，默认 30 分钟用于刷新收藏和生成证据包。

其他客户端见 [通用接入说明](../README.md#接入-ai-客户端)。
