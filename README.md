# Bili Fav

用 AI 搜索和整理 B 站收藏，按需读取视频字幕、简介和评论，并把笔记写入本地 Obsidian 库。支持标准 MCP、JSON 命令行和 DSH 原生工具。所有对 B 站的操作均为读取。

## 安装

需要 Node.js 20 或更新版本。在仓库根目录运行：

```sh
npm ci
node cli/tool.mjs list
```

搜索公开视频和读取可用的公开材料可以匿名运行。同步自己的收藏夹或获取部分 AI 字幕需要登录。运行 `node cli/fav.mjs login`，按交互提示输入 B 站 Cookie，再运行 `node cli/fav.mjs fetch --all`。以后可加 `--incremental` 做增量同步。

`data/` 保存登录凭据和缓存，`vault/` 保存 Obsidian 笔记。两者均由运行时创建，并已设为 Git 忽略项。也可通过环境变量 `BILI_FAV_HOME` 指定已有的数据根目录。

## 接入 AI 客户端

### 本地 MCP

将客户端的 MCP 服务类型设为 stdio，命令填 `node`，参数填该仓库的 `mcp/index.mjs` **绝对路径**。使用 `mcpServers` 配置的客户端可参考：

```json
{
  "mcpServers": {
    "bili-fav": {
      "command": "node",
      "args": ["/absolute/path/to/bili-fav/mcp/index.mjs"]
    }
  }
}
```

### Streamable HTTP

设置至少 32 个字符的随机 `BILI_FAV_MCP_TOKEN` 后运行：

```sh
node mcp/index.mjs --http
```

默认地址为 `http://127.0.0.1:3875/mcp`，可用 `BILI_FAV_MCP_PORT` 改端口。客户端发送 `Authorization: Bearer <token>`。云端客户端需要能访问的 HTTPS 网关。网关向上游转发时使用本机服务的 `Host` 和 `Authorization`。若转发 `Origin`，将允许的完整来源设置为 `BILI_FAV_MCP_ORIGIN`。要求 OAuth 的客户端需要由网关提供 OAuth。

启用 MCP 后，返回的收藏信息和证据文本可能进入所用 AI 客户端的模型上下文。同一个 HTTP 进程会依次处理工具调用。多个进程连接同一份库时，错开刷新、更新缓存和写笔记。

### JSON CLI 和 DSH

```sh
node cli/tool.mjs list
node cli/tool.mjs call bili_library
```

`list` 输出工具描述和参数 JSON Schema，可用于注册自定义函数。调用格式为 `node cli/tool.mjs call <工具名> [JSON | -]`，其中 `-` 表示从标准输入读取参数。出错时返回 `{"ok":false,"error":"..."}` 和退出码 1。

DSH 原生工具的配置见 [DSH 接入](plugin/README.md)。

## 工具

| 工具 | 用途 |
| --- | --- |
| `bili_library` | 统计、待整理清单、同步收藏 |
| `bili_find` | 搜本地收藏和 B 站，按相关度排序 |
| `bili_feed` | 读取个性化推荐、热门、排行榜和主题最新视频 |
| `bili_read` | 准备视频证据包，返回证据状态和文件路径 |
| `bili_evidence` | 按 BV 号分页读指南、字幕、简介和评论，供 MCP 和 JSON CLI 使用 |
| `bili_note` | 写 Markdown 笔记、质检、重建 Obsidian 索引 |

常用流程是先运行 `bili_read`，再用 `bili_evidence` 取 `guide` 和需要的材料。继续翻页时，把返回的 `nextOffset` 作为下一次的 `offset`。写笔记时将 Markdown 正文传给 `bili_note` 的 `body` 参数。拼图通过本地文件提供。

本地转写需要 FFmpeg、FFprobe 和 whisper.cpp。可用 `node cli/fav.mjs doctor` 检查路径。Windows 上可用 `scripts/bootstrap.ps1` 安装媒体下载和处理工具，whisper.cpp 和模型需另行配置。

`npm test` 运行测试套件。MCP 和原生 DSH 的离线用例可用 `npm run test:portable` 和 `npm run test:plugin` 单独运行。

## 第三方致谢

本地转写复核参考了 [video-watch-plus](https://github.com/xinhailaopo/video-watch-plus) 和 [dsh-bili-watch](https://github.com/Sacredbluedragon/dsh-bili-watch)。相关授权声明在 [licenses/](licenses/)。
