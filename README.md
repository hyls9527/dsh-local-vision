# dsh-local-vision

通用本地视觉桥接工具插件（DSH profile bundle，v0.2.0）。

为纯文本模型（如 deepseek-v4-flash）提供"看图"能力，**兼容所有 OpenAI 兼容
的本地推理框架**：llama.cpp server、Ollama、LM Studio、vLLM/SGLang、Jan、
GPT4All、llamafile 等。纯 Node 实现，无 Python 依赖。

## 功能特性

- **多端点轮询**：配置多个本地推理服务，自动按序选择第一个"健康且含视觉模型"的端点
- **视觉模型自动探测**：`GET /v1/models` 枚举 + 名称启发式过滤（vl/vision/llava/minicpm/internvl/glm-4v/gpt-4o 等关键词）+ Ollama 原生 `/api/tags` capabilities 增强
- **仅视觉模型可用**：端点无视觉模型时明确报错并列出该端点全部模型
- **模型可选**：工具参数 `model` 可显式指定；缺省自动选端点上第一个视觉模型
- 保留 health 探测、取消信号、超时控制

## 安装（本机 profile）

```sh
# 构建（需 node + npm）
npm install && npm run build

# 已通过 link 依赖装入 web profile：
#   "dsh-local-vision": "link:<workspace>/dsh-local-vision"
# 并在 dsh.profile.bundles 含 "dsh-local-vision"
```

## 工具：local_vision

| 参数 | 说明 |
|---|---|
| `image` | 图片绝对路径（png/jpg/webp/gif/bmp 等），必填 |
| `question` | 要问模型的问题；缺省为详细描述图片内容 |
| `maxTokens` | 回答长度上限，默认 1024 |
| `model` | 视觉模型 id（可选）；缺省自动选择端点上第一个视觉模型 |

返回：`{ description, endpoint, model, usage? }`

## 插件配置（cordis.patch.yml 可覆盖）

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml 中覆盖端点列表示例：
- id: local-vision
  name: dsh-local-vision
  config:
    endpoints:
      - baseUrl: http://127.0.0.1:8090
        alias: llama.cpp
      - baseUrl: http://127.0.0.1:11434
        alias: ollama
      - baseUrl: http://127.0.0.1:1234
        alias: lm-studio
    timeoutMs: 900000
```

缺省端点：llama.cpp (`http://127.0.0.1:8090`) + Ollama (`http://127.0.0.1:11434`)。

## 与 local-vision 技能的分工

| 需求 | 用哪个 |
|---|---|
| 快速纯文字 OCR、发票、表格、UI 元素坐标 | `local-vision` 技能（PaddleOCR / OmniParser） |
| 语义理解：描述场景、看图问答、读懂截图含义 | 本插件（本地视觉模型，全离线） |

## 开发

```sh
npm run typecheck   # tsc --noEmit
npm run build       # esbuild → lib/index.js
```
