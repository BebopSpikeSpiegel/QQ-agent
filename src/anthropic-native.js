// Anthropic 直连走原生 Messages API（官方 SDK），为了提示词缓存。
//
// 为什么不用 api.anthropic.com/v1/chat/completions（OpenAI 兼容口）：那条路不带 cache_control，
// 10/31 切到直连后 4 天缓存命中一直是 0，每次运行 ~28k token 全价重发（一天 $11 左右）。
// 这里在进程内把 llm.js 拼好的 OpenAI 形请求体翻成 Messages API 参数，响应再翻回 OpenAI 形，
// llm.js 的降级重试 / 解析 / usage 统计全都不用动。翻译规则沿用 scripts/anthropic-bridge.mjs。
//
// 缓存断点（最多 4 个，长 TTL 必须在前）：
//   1. system（连带前面的 tools）           1h —— 所有群、所有运行都一样
//   2. 用户提示里【角色设定】段末尾           1h —— 角色卡每小时才被学习插件刷新一次
//   3. 【记忆】+【已读信息】段末尾            5m —— 锚点设计让它在连续触发间保持字节不变
//   4. 最后一条消息的最后一块                 5m —— 同一次运行的多轮工具循环逐轮命中
// 段落顺序见 prompt.js buildUserPrompt 的"按变化频率排序"注释。
import Anthropic from '@anthropic-ai/sdk';
import crypto from 'node:crypto';

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
// 服务端 fallbacks: "default"（被安全分类器拒掉时服务端换模型重跑）只在这几个模型上可用
const FALLBACK_MODELS = new Set(['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1']);
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/** 只有官方域名走原生；中转站 / 本地桥照旧走 OpenAI 兼容口。api.anthropicNative=false 可关。 */
export function useAnthropicNative(api = {}) {
  if (api.anthropicNative === false) return false;
  try { return new URL(String(api.baseUrl || '')).hostname === 'api.anthropic.com'; } catch { return false; }
}

const clients = new Map();
function clientFor(apiKey, baseUrl, timeoutMs) {
  // SDK 自己会补 /v1，baseURL 只要域名
  const root = String(baseUrl || '').replace(/\/v1\/?$/, '').replace(/\/+$/, '');
  const key = `${root}|${apiKey}|${timeoutMs}`;
  if (!clients.has(key)) {
    // 重试交给 llm.js 外层的 chatCompletionWithRetry，这里不叠
    clients.set(key, new Anthropic({ apiKey, baseURL: root, timeout: timeoutMs, maxRetries: 0 }));
  }
  return clients.get(key);
}

function textOf(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((p) => p?.type === 'text').map((p) => p.text).join('\n');
  return String(content);
}

/** OpenAI 内容部件 → Anthropic 内容块（文本 / 图片；视频降级成文字说明）。 */
function toBlocks(content) {
  if (content == null) return [];
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  const blocks = [];
  for (const part of Array.isArray(content) ? content : [content]) {
    if (part?.type === 'text') {
      if (part.text) blocks.push({ type: 'text', text: part.text });
    } else if (part?.type === 'image_url') {
      const url = String(part.image_url?.url ?? part.image_url ?? '');
      const m = /^data:([\w/+.-]+);base64,(.+)$/s.exec(url);
      const mediaType = m ? m[1].toLowerCase().replace('image/jpg', 'image/jpeg') : '';
      if (m && IMAGE_TYPES.has(mediaType)) {
        blocks.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: m[2] } });
      } else if (/^https?:\/\//i.test(url)) {
        blocks.push({ type: 'image', source: { type: 'url', url } });
      } else {
        blocks.push({ type: 'text', text: '[图片：格式不受支持，已省略]' });
      }
    } else if (part?.type === 'video_url') {
      blocks.push({ type: 'text', text: '[视频：Claude 不能直接读视频，已省略]' });
    }
  }
  return blocks;
}

function safeJson(s) {
  try { const v = JSON.parse(s || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}

/** OpenAI 消息 → Messages API 消息：同角色合并，tool 结果并进一条 user，首条必须是 user。 */
function buildMessages(rest) {
  const out = [];
  const push = (role, blocks) => {
    if (!blocks.length) return;
    const last = out[out.length - 1];
    if (last?.role === role) last.content.push(...blocks);
    else out.push({ role, content: [...blocks] });
  };
  for (const m of rest) {
    if (m.role === 'user') {
      push('user', toBlocks(m.content));
    } else if (m.role === 'assistant') {
      const blocks = [];
      const text = textOf(m.content);
      if (text) blocks.push({ type: 'text', text });
      for (const call of m.tool_calls || []) {
        blocks.push({ type: 'tool_use', id: call.id, name: call.function?.name, input: safeJson(call.function?.arguments) });
      }
      push('assistant', blocks);
    } else if (m.role === 'tool') {
      push('user', [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: textOf(m.content) || '(空)' }]);
    }
  }
  if (out[0]?.role !== 'user') out.unshift({ role: 'user', content: [{ type: 'text', text: '(对话开始)' }] });
  if (out[out.length - 1]?.role !== 'user') out.push({ role: 'user', content: [{ type: 'text', text: '继续。' }] });
  return out;
}

// 用户提示切段：第一处标记前 = 角色设定；第二处标记前 = 记忆 + 已读信息
const PERSONA_END = ['\n\n【可用表情包】', '\n\n【引导说明】', '\n\n【记忆】', '\n\n【已读信息】'];
const HISTORY_END = ['\n\n【新已读信息】', '\n\n【未读信息】'];

function firstIndex(text, markers, from = 0) {
  let best = -1;
  for (const mk of markers) {
    const i = text.indexOf(mk, from);
    if (i >= 0 && (best < 0 || i < best)) best = i;
  }
  return best;
}

/** 把第一条用户消息开头的大段文本切成 角色设定 / 记忆+已读 / 其余 三块，前两块打缓存断点。 */
function splitPromptForCache(messages) {
  const first = messages[0];
  const block = first?.content?.[0];
  if (!block || block.type !== 'text') return 0;
  const text = block.text;
  const a = firstIndex(text, PERSONA_END);
  if (a <= 0) return 0;
  const b = firstIndex(text, HISTORY_END, a + 1);
  const pieces = [{ type: 'text', text: text.slice(0, a), cache_control: { type: 'ephemeral', ttl: '1h' } }];
  if (b > a) {
    pieces.push({ type: 'text', text: text.slice(a, b), cache_control: { type: 'ephemeral' } });
    pieces.push({ type: 'text', text: text.slice(b) });
  } else {
    pieces.push({ type: 'text', text: text.slice(a) });
  }
  first.content.splice(0, 1, ...pieces);
  return pieces.filter((p) => p.cache_control).length;
}

/** 关思考的写法因模型而异：Sonnet 5.5 只认 between_tools；Opus 5.5 / Fable 关不了，不发。 */
function thinkingOff(model) {
  if (/^claude-sonnet-5-5/.test(model)) return { type: 'between_tools' };
  if (/^claude-(opus-5-5|fable-|mythos-)/.test(model)) return null;
  return { type: 'disabled' };
}

function extractJson(text) {
  const s = String(text || '').replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  try { return JSON.parse(s); } catch { /* 往下找第一个 {...} */ }
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try { return JSON.parse(s.slice(a, b + 1)); } catch { /* 放弃 */ }
  }
  return null;
}

/** llm.js 拼好的 OpenAI 形请求体 → Messages API 参数。导出给测试用。 */
export function planRequest(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let system = messages.filter((m) => m.role === 'system').map((m) => textOf(m.content)).join('\n\n');
  const rest = messages.filter((m) => m.role !== 'system');
  const model = String(body.model || '').trim();
  const choice = body.tool_choice;
  const tools = (Array.isArray(body.tools) ? body.tools : []).map((t) => {
    const f = t.function || t;
    return { name: f.name, description: String(f.description || ''), input_schema: f.parameters || { type: 'object', properties: {} } };
  }).filter((t) => t.name);

  let mode = tools.length ? 'tools' : 'text';
  // Sonnet 5.5 / Opus 5.5 不收强制 tool_choice：改成 auto + 一句提示
  const forcedName = typeof choice === 'object' ? choice?.function?.name : '';
  if (tools.length && (forcedName || choice === 'required')) {
    system += `\n\n这一轮必须调用工具${forcedName ? ` ${forcedName}` : ''}。`;
  }
  if (!tools.length && (body.response_format?.type === 'json_schema' || body.response_format?.type === 'json_object')) {
    mode = 'json';
    const schema = body.response_format.json_schema?.schema;
    system += `\n\n只输出一个 JSON 对象，不要代码块、不要解释。${schema ? `\nJSON schema：${JSON.stringify(schema)}` : ''}`;
  }

  const params = {
    model,
    max_tokens: Math.max(256, Math.min(32000, Number(body.max_tokens || body.max_completion_tokens) || 16000)),
    system: [{ type: 'text', text: system || 'You are a helpful assistant.', cache_control: { type: 'ephemeral', ttl: '1h' } }],
    messages: buildMessages(rest)
  };
  if (tools.length) params.tools = tools;
  if (tools.length && choice === 'none') params.tool_choice = { type: 'none' };

  // 思考：thinking.js 显式开了就照发（adaptive / budget）；没开就按模型关掉，
  // 和走兼容口时一样不思考（兼容口那 4 天平均每次只出 ~170 token）。
  if (body.thinking && typeof body.thinking === 'object') {
    params.thinking = body.thinking;
  } else {
    const off = thinkingOff(model);
    if (off) params.thinking = off;
  }
  const effort = String(body.reasoning_effort || '');
  if (EFFORTS.has(effort) && params.thinking?.type !== 'between_tools') params.output_config = { effort };

  // 缓存断点：system(1h) + 角色设定(1h) + 记忆/已读(5m) + 最后一块(5m)，合计不超过 4 个
  const used = 1 + splitPromptForCache(params.messages);
  if (used < 4) {
    const lastMsg = params.messages[params.messages.length - 1];
    const lastBlock = lastMsg?.content?.[lastMsg.content.length - 1];
    if (lastBlock && !lastBlock.cache_control) lastBlock.cache_control = { type: 'ephemeral' };
  }
  return { params, mode };
}

function toCompletion(mode, msg) {
  const u = msg.usage || {};
  const cached = Number(u.cache_read_input_tokens) || 0;
  const written = Number(u.cache_creation_input_tokens) || 0;
  const prompt = (Number(u.input_tokens) || 0) + written + cached;
  const content = msg.content || [];
  const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  const calls = content.filter((b) => b.type === 'tool_use');
  const message = { role: 'assistant', content: text || null };
  let finish = msg.stop_reason === 'max_tokens' ? 'length' : 'stop';
  if (mode === 'json') {
    message.content = JSON.stringify(extractJson(text) ?? {});
  } else if (calls.length) {
    message.tool_calls = calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } }));
    finish = 'tool_calls';
  }
  if (msg.stop_reason === 'refusal') finish = 'content_filter';
  return {
    id: msg.id || `chatcmpl-${crypto.randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: msg.model,
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: {
      prompt_tokens: prompt,
      completion_tokens: Number(u.output_tokens) || 0,
      total_tokens: prompt + (Number(u.output_tokens) || 0),
      prompt_tokens_details: { cached_tokens: cached },
      cache_creation_input_tokens: written
    }
  };
}

/**
 * 发一次原生请求，返回和 llm.js 里 fetch 版 post() 一样的 { ok, status, text, contentType }，
 * text 是 OpenAI 形的 chat.completion JSON（或错误 JSON）。网络层错误照样抛，交给外层处理。
 */
export async function postAnthropicNative(body, { apiKey, baseUrl, signal, timeoutMs }) {
  const { params, mode } = planRequest(body);
  const client = clientFor(apiKey, baseUrl, timeoutMs);
  const req = { ...params };
  // between_tools 只有 Sonnet 5.5 认，服务端换模型重跑时会原样带过去 —— 这种请求不挂 fallbacks
  if (FALLBACK_MODELS.has(req.model) && req.thinking?.type !== 'between_tools') {
    req.betas = ['server-side-fallback-2026-07-01'];
    req.fallbacks = 'default';
  }
  try {
    const msg = await client.beta.messages.stream(req, { signal }).finalMessage();
    return { ok: true, status: 200, text: JSON.stringify(toCompletion(mode, msg)), contentType: 'application/json' };
  } catch (error) {
    if (error instanceof Anthropic.APIError && error.status) {
      return { ok: false, status: error.status, text: JSON.stringify(error.error ?? { message: error.message }), contentType: 'application/json' };
    }
    throw error;
  }
}
