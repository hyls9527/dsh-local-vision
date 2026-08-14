/**
 * dsh-local-vision — 通用本地视觉桥接工具插件（v0.2.0）
 *
 * 为纯文本模型（如 deepseek-v4-flash）提供"看图"能力，兼容所有
 * OpenAI 兼容的本地推理框架：llama.cpp server、Ollama、LM Studio、
 * vLLM/SGLang、Jan、GPT4All、llamafile 等。
 *
 * 设计要点：
 * - 纯 Node 实现，无 Python/see.py 依赖；
 * - 多端点配置，按序选择第一个"健康且含视觉模型"的端点；
 * - 视觉模型自动探测（/v1/models 名称启发式 + Ollama capabilities）；
 * - 工具参数可选 model，缺省用端点上的第一个视觉模型；
 * - 仅视觉模型可用——端点无视觉模型时报可操作的错误并列出模型清单。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-local-vision'
export const inject = ['tools']

/** 默认端点：llama.cpp 与 Ollama 的常用本地端口 */
const DEFAULT_ENDPOINTS = [
  { baseUrl: 'http://127.0.0.1:8090', alias: 'llama.cpp' },
  { baseUrl: 'http://127.0.0.1:11434', alias: 'ollama' },
]

const HEALTH_TIMEOUT_MS = 3000
const MODELS_TIMEOUT_MS = 5000
const RUN_TIMEOUT_MS = 900_000

/** 名称启发式：常见视觉模型关键词（小写匹配） */
const VISION_KEYWORDS = [
  'vl', 'vision', 'visual', 'llava', 'minicpm', 'internvl', 'xcomposer',
  'glm-4v', 'glm4v', 'gemini', 'gpt-4o', 'gpt-4-vision', 'phi-3-vision',
  'moondream', 'bakllava', 'cogvlm', 'idefics', 'paligemma', 'molmo',
  'smolvlm', 'deepseek-vl', 'yi-vl', 'qwen2-vl', 'qwen3-vl', 'qwen-vl',
  'ocr', 'pix2struct', 'fuyu', 'kosmos', 'flamingo',
]

interface Endpoint {
  /** 服务根地址，如 http://127.0.0.1:8090 */
  baseUrl: string
  /** 显示名，用于报错信息 */
  alias?: string
}

interface Config {
  /** 本地推理端点列表；缺省为 llama.cpp + Ollama */
  endpoints?: Endpoint[]
  /** 调用超时（ms），缺省 900000 */
  timeoutMs?: number
}

interface VisionModel {
  id: string
  endpoint: Endpoint
}

interface EndpointStatus {
  endpoint: Endpoint
  healthy: boolean
  error?: string
  models?: VisionModel[]
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms),
    ),
  ])
}

/** 探测端点健康：GET /health */
async function checkHealth(baseUrl: string): Promise<boolean> {
  try {
    const res = await withTimeout(fetch(`${baseUrl}/health`), HEALTH_TIMEOUT_MS)
    return res.ok
  } catch {
    return false
  }
}

/** 名称启发式判定视觉模型 */
function isVisionByName(modelId: string): boolean {
  const name = modelId.toLowerCase()
  return VISION_KEYWORDS.some((kw) => name.includes(kw))
}

/** Ollama 原生 /api/tags：capabilities 含 vision 判定 */
async function ollamaVisionIds(baseUrl: string): Promise<Set<string> | null> {
  try {
    const res = await withTimeout(fetch(`${baseUrl}/api/tags`), MODELS_TIMEOUT_MS)
    if (!res.ok) return null
    const data = (await res.json()) as { models?: Array<{ name: string; capabilities?: string[] }> }
    if (!data.models) return null
    const ids = new Set<string>()
    for (const m of data.models) {
      if (m.capabilities?.includes('vision')) ids.add(m.name)
    }
    return ids
  } catch {
    return null
  }
}

/** 枚举端点的视觉模型：/v1/models（名称启发式）+ Ollama capabilities 增强 */
async function listVisionModels(endpoint: Endpoint): Promise<VisionModel[]> {
  const baseUrl = endpoint.baseUrl
  const results = new Map<string, boolean>()

  // 1) OpenAI 兼容 /v1/models
  try {
    const res = await withTimeout(fetch(`${baseUrl}/v1/models`), MODELS_TIMEOUT_MS)
    if (res.ok) {
      const data = (await res.json()) as { data?: Array<{ id: string }> }
      for (const m of data.data ?? []) {
        results.set(m.id, isVisionByName(m.id))
      }
    }
  } catch {
    /* 非 OpenAI 兼容端点跳过 */
  }

  // 2) Ollama 原生 capabilities 增强（覆盖 /v1/models 无法表达的能力）
  const ollamaVision = await ollamaVisionIds(baseUrl)
  if (ollamaVision) {
    for (const id of ollamaVision) results.set(id, true)
  }

  const models: VisionModel[] = []
  for (const [id, vision] of results) {
    if (vision) models.push({ id, endpoint })
  }
  return models
}

/** 探测全部端点，返回按配置顺序的健康状态 + 视觉模型 */
async function probeEndpoints(endpoints: Endpoint[]): Promise<EndpointStatus[]> {
  const statuses: EndpointStatus[] = []
  for (const endpoint of endpoints) {
    const healthy = await checkHealth(endpoint.baseUrl)
    let models: VisionModel[] = []
    let error: string | undefined
    if (healthy) {
      try {
        models = await listVisionModels(endpoint)
      } catch (e) {
        error = e instanceof Error ? e.message : String(e)
      }
    }
    statuses.push({ endpoint, healthy, error, models })
  }
  return statuses
}

/** 调用 OpenAI 兼容 chat/completions 看图 */
async function callVision(
  endpoint: Endpoint,
  model: string,
  imagePath: string,
  question: string,
  maxTokens: number,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<{ description: string; promptTokens?: number; completionTokens?: number }> {
  // 读图并转 base64 data URI
  const { readFile } = await import('node:fs/promises')
  const path = await import('node:path')
  const buffer = await readFile(imagePath)
  const mime = mimeOf(path.extname(imagePath).toLowerCase())
  const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`

  const payload = {
    model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: dataUrl } },
          { type: 'text', text: question },
        ],
      },
    ],
    max_tokens: maxTokens,
    temperature: 0.3,
    stream: false,
  }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const onAbort = () => ctrl.abort()
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    const res = await fetch(`${endpoint.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`)
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    }
    const content = data.choices?.[0]?.message?.content
    if (!content) {
      throw new Error(`响应缺少内容: ${JSON.stringify(data).slice(0, 300)}`)
    }
    return {
      description: content.trim(),
      promptTokens: data.usage?.prompt_tokens,
      completionTokens: data.usage?.completion_tokens,
    }
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}

/** 根据扩展名推断 MIME */
function mimeOf(ext: string): string {
  switch (ext) {
    case '.png': return 'image/png'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.webp': return 'image/webp'
    case '.gif': return 'image/gif'
    case '.bmp': return 'image/bmp'
    default: return 'image/png'
  }
}

function renderStatus(statuses: EndpointStatus[]): string {
  return statuses
    .map((s) => {
      const name = s.endpoint.alias ?? s.endpoint.baseUrl
      if (!s.healthy) return `  - ${name} (${s.endpoint.baseUrl}): 不可用`
      if (!s.models || s.models.length === 0) {
        const errorPart = s.error ? `（${s.error}）` : ''
        return `  - ${name} (${s.endpoint.baseUrl}): 健康但未发现视觉模型${errorPart}`
      }
      return `  - ${name} (${s.endpoint.baseUrl}): ${s.models.map((m) => m.id).join(', ')}`
    })
    .join('\n')
}

export function apply(ctx: Context, config: Config = {}) {
  const endpoints = config.endpoints && config.endpoints.length > 0 ? config.endpoints : DEFAULT_ENDPOINTS
  const timeoutMs = config.timeoutMs ?? RUN_TIMEOUT_MS

  ctx.tools.register(defineTool({
    name: 'local_vision',
    description:
      '使用本地视觉模型理解图片：描述场景/物体/文字/颜色，或回答关于图片的问题。' +
      '兼容所有 OpenAI 兼容本地推理框架（llama.cpp / Ollama / LM Studio / vLLM 等）。' +
      '自动从配置的本地端点探测可用的视觉模型；输入图片绝对路径（png/jpg/webp 等）。' +
      '适合语义理解、看图问答；快速 OCR/表格/UI 坐标请用 local-vision 技能。',
    parameters: {
      image: { type: 'string', required: true, description: '图片绝对路径 (png/jpg/webp 等)' },
      question: { type: 'string', description: '要问模型的问题；缺省为详细描述图片内容' },
      maxTokens: { type: 'number', description: '回答长度上限，默认 1024' },
      model: { type: 'string', description: '视觉模型 id（可选）；缺省自动选择端点上第一个视觉模型' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          description: { type: 'string', required: true },
          endpoint: { type: 'string', required: true },
          model: { type: 'string', required: true },
          usage: {
            type: 'object',
            additionalProperties: false,
            properties: {
              promptTokens: { type: 'number' },
              completionTokens: { type: 'number' },
            },
          },
        },
      },
      render: (_args, value) => [
        { type: 'text' as const, text: value.description },
        ...(value.usage
          ? [{ type: 'text' as const, text: `\n[usage] prompt=${value.usage.promptTokens} completion=${value.usage.completionTokens}` }]
          : []),
        { type: 'text' as const, text: `\n[vision] ${value.endpoint} / ${value.model}` },
      ],
    },
    async execute(args, exec) {
      const image = args.image
      if (!image || image.trim() === '') {
        throw new Error('图片路径不能为空')
      }
      const question = args.question ?? '请详细描述这张图片的内容，包括场景、物体、文字、颜色和布局。'
      const maxTokens = args.maxTokens ?? 1024

      // 1) 探测端点：健康 + 视觉模型
      const statuses = await probeEndpoints(endpoints)
      const usable = statuses.filter((s) => s.healthy && s.models && s.models.length > 0)

      if (usable.length === 0) {
        throw new Error(
          '未找到可用的本地视觉服务。端点状态：\n' + renderStatus(statuses) +
          '\n请确认至少一个本地推理框架（llama.cpp / Ollama / LM Studio / vLLM）正在运行且已加载视觉模型（如 qwen2.5-vl、llava、minicpm-v 等）。'
        )
      }

      // 2) 选择模型：显式指定 > 首个可用视觉模型
      let target: VisionModel | undefined
      if (args.model) {
        for (const s of usable) {
          const hit = s.models!.find((m) => m.id === args.model)
          if (hit) { target = hit; break }
        }
        if (!target) {
          throw new Error(
            `模型 "${args.model}" 不是可用视觉模型。可用端点与模型：\n` + renderStatus(usable)
          )
        }
      } else {
        target = usable[0].models![0]
      }

      // 3) 调用视觉端点
      try {
        const result = await callVision(
          target.endpoint, target.id, image, question, maxTokens, timeoutMs, exec.signal,
        )
        return {
          description: result.description,
          endpoint: `${target.endpoint.alias ?? target.endpoint.baseUrl} (${target.endpoint.baseUrl})`,
          model: target.id,
          usage: result.promptTokens !== undefined || result.completionTokens !== undefined
            ? { promptTokens: result.promptTokens, completionTokens: result.completionTokens }
            : undefined,
        }
      } catch (e) {
        const err = e as { message?: string }
        if (exec.signal.aborted) {
          throw new Error('local_vision 执行已被取消')
        }
        throw new Error(`local_vision 调用失败（${target.endpoint.baseUrl}/${target.id}）: ${err.message ?? String(e)}`)
      }
    },
  }))
}
