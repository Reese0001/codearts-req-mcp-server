# codearts-req-mcp-server

华为云 CodeArts 需求管理（Req）的本地 stdio MCP Server，基于官方 `@modelcontextprotocol/sdk`，封装两个工具：

- `create_project`：创建项目（`POST /v4/project`）
- `list_projects`：查询项目列表（`GET /v4/projects`）

鉴权通过 **AK/SK 签名**（SDK-HMAC-SHA256 算法），请求头携带 `Authorization` 与 `X-Sdk-Date`。

## 目录结构

```
codearts-req-mcp-server/
├── server.mjs          # MCP Server 主文件（可直接运行，也导出处理函数供测试）
├── server.test.mjs     # 配套测试（node:test）
├── package.json
└── README.md
```

## 一、安装依赖

```bash
cd codearts-req-mcp-server
npm install --registry=https://repo.huaweicloud.com/repository/npm/
```

依赖：`@modelcontextprotocol/sdk`（Node.js ≥ 18）。

## 二、环境变量

| 变量名 | 必填 | 说明 | 示例 |
| --- | --- | --- | --- |
| `CODEARTS_REQ_ENDPOINT` | 是 | CodeArts Req 终端节点 | `https://projectman-ext.cn-north-4.myhuaweicloud.com` |
| `CODEARTS_REQ_AK` | 是 | 华为云访问密钥 Access Key Id | 从控制台「我的凭证 → 访问密钥」获取 |
| `CODEARTS_REQ_SK` | 是 | 华为云访问密钥 Secret Access Key | 与 AK 配对使用，创建时仅显示一次 |
| `CODEARTS_REQ_PROXY` | 否 | SOCKS5 代理（内网环境按需配置） | `socks5://127.0.0.1:10808` |

### AK/SK 获取方式

登录华为云控制台 → 右上角头像 → 「我的凭证」→「访问密钥」→「新增访问密钥」，下载 `credentials.csv` 文件，其中包含 Access Key Id 和 Secret Access Key。

> AK/SK 是长期有效凭证，无需像 IAM Token 那样 24 小时刷新一次。

## 三、启动命令

```bash
# 方式一：直接运行
CODEARTS_REQ_ENDPOINT=https://projectman-ext.cn-north-4.myhuaweicloud.com \
CODEARTS_REQ_AK=<你的AK> \
CODEARTS_REQ_SK=<你的SK> \
node server.mjs

# 方式二：npm 脚本
npm start
```

Server 通过 stdio 与 MCP 客户端通信，启动后等待 JSON-RPC 消息。

## 四、码道（CodeArts Doer）配置

在码道 MCP 配置文件 `.codeartsdoer/mcp/mcp_settings.json` 中添加：

```json
{
  "mcpServers": {
    "codearts-req": {
      "command": "node",
      "args": [
        "D:/DevProject/ict/codearts-case-basics-res-1/codearts-req-mcp-server/server.mjs"
      ],
      "env": {
        "CODEARTS_REQ_ENDPOINT": "https://projectman-ext.cn-north-4.myhuaweicloud.com",
        "CODEARTS_REQ_AK": "<填入你的 Access Key Id>",
        "CODEARTS_REQ_SK": "<填入你的 Secret Access Key>"
      }
    }
  }
}
```

修改后码道会自动重载 MCP 服务。工具调用名称为 `codearts-req_create_project`、`codearts-req_list_projects`（带服务名前缀）。

## 五、工具说明

### create_project

创建 CodeArts 需求管理项目。

**参数：**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `project_name` | string | 是 | 1-128 字符 |
| `project_type` | enum | 是 | `scrum` / `normal` / `xboard` / `basic` / `phoenix` / `ipd` |
| `description` | string | 否 | 项目描述 |
| `enterprise_id` | string | 否 | 企业项目 ID |
| `source` | string | 否 | 0-64 字符 |
| `template_id` | enum | 否 | `10001` / `10002` / `10003`；`project_type=ipd` 时必传 |

**返回：** `project_id`、`project_num_id`、`project_name`、`project_type`、`user_num_id`

### list_projects

查询项目列表。

**参数：**

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `offset` | integer | 否 | 0 | 0-10000，须为 `limit` 整数倍；服务端必传，未传时客户端默认 0 |
| `limit` | integer | 否 | 10 | 1-1000；服务端必传，未传时客户端默认 10 |
| `search` | string | 否 | - | 搜索关键字 |
| `project_type` | enum | 否 | - | `scrum` / `normal` / `xboard` |
| `sort` | string | 否 | - | 格式 `字段:方向`，多组逗号分隔，最多 4 组，方向 `asc`/`desc` |
| `archive` | boolean | 否 | - | 是否归档 |
| `query_type` | enum | 否 | - | `domain_projects` / `absent` |

**返回：** `projects`（数组）、`total`（整数）

## 六、错误处理

所有错误均以 `isError: true` 的结构化中文提示返回，不静默吞错、不崩溃：

| error_code | 触发条件 |
| --- | --- |
| `INVALID_ARGUMENTS` | 参数校验失败 |
| `MISSING_CONFIG` | 缺少 `CODEARTS_REQ_ENDPOINT`、`CODEARTS_REQ_AK` 或 `CODEARTS_REQ_SK` |
| `NETWORK_ERROR` | 网络请求失败或响应解析失败 |
| 透传 `error_code` | 华为云 API 报错，附带 `error_msg` 与 `http_status` |

错误响应示例：

```json
{
  "error": true,
  "error_code": "INVALID_ARGUMENTS",
  "error_msg": "参数校验失败：\n1. project_name 必填，且为 1-128 字符的字符串"
}
```

## 七、测试

```bash
npm test
```

使用 Node.js 内置 `node:test`，覆盖参数校验、配置缺失、AK/SK 签名生成（query 排序、RFC3986 转义、非标准端口）、API 成功/报错、网络异常等场景。

> **注意**：终端节点 `projectman-ext` 的验签服务要求 canonical URI 带尾斜杠（如 `/v4/project/`），`server.mjs` 的 `buildSignature` 已按此处理，请勿删除该逻辑。

## 八、安全提示

- AK/SK 是长期有效凭证，妥善保管，切勿提交到版本库
- 不要将 AK/SK 或密码写入代码、文档或日志