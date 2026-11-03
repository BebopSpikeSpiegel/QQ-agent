// Anthropic API 桥：把 OpenAI 兼容的 /v1/chat/completions 请求转成 Claude Messages API 调用（官方 SDK）。
// 和 claude-code-bridge.mjs 同一个口子、同一套路由，区别只在后端：这里按 API Key 计费，不走 Claude Code 订阅。
//
// 用法：
//   Key：程序设置里这个服务的「API Key」栏填上即可（随请求发过来）；或者 setx ANTHROPIC_API_KEY "sk-ant-..."（环境变量优先）
//   node scripts/anthropic-bridge.mjs [--port 3456] [--model sonnet] [--effort low] [--parallel 4]
// 程序设置：API 地址 http://127.0.0.1:3456/v1，模型 sonnet / opus / haiku / fable（或完整 id）；没设环境变量时 Key 填真的 Anthropic API Key。
//
// 做法：
//   · system 消息 → system（带 cache_control，人设 + 准则每轮都一样，走缓存省钱）
//   · tools / tool_calls / tool 结果 → 原生 tool_use / tool_result 块，工具 id 原样往返
//   · 同一轮工具循环里，上一步的 thinking 块按 tool_use id 暂存，下一步原样送回
//   · tool_choice required / 指定工具：Sonnet 5.5 不收强制调用，改成 auto + 一句提示
//   · claude_tools: "WebSearch" → 服务端 web_search 工具；/v1/search 也走它
//   · 默认带 fallbacks: "default"：被安全分类器拒掉时服务端自动换模型重跑（--no-fallbacks 关掉）
import http from 'node:http';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import Anthropic from '@anthropic-ai/sdk';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([\w-]+)(?:=(.*))?$/.exec(argv[i]);
    if (!m) continue;
    out[m[1]] = m[2] ?? (argv[i + 1]?.startsWith('--') || argv[i + 1] == null ? 'true' : argv[++i]);
  }
  return out;
}

const ARGS = parseArgs(process.argv.slice(2));
const PORT = Number(ARGS.port || process.env.CLAUDE_BRIDGE_PORT || 3456);
const DEFAULT_MODEL = String(ARGS.model || process.env.CLAUDE_BRIDGE_MODEL || 'sonnet');
// 群聊闲聊用 low 就够（Sonnet 5.5 的 effort 档位重新校准过，low 对聊天是推荐起点）
const DEFAULT_EFFORT = String(ARGS.effort || process.env.CLAUDE_BRIDGE_EFFORT || 'low');
const MAX_PARALLEL = Math.max(1, Number(ARGS.parallel || process.env.CLAUDE_BRIDGE_PARALLEL || 4));
const TIMEOUT_MS = Math.max(10000, Number(ARGS.timeout || 170000));
const MAX_TOKENS = Math.max(1024, Number(ARGS['max-tokens'] || 16000));
const USE_FALLBACKS = ARGS['no-fallbacks'] == null;
const SEARCH_MODEL = String(ARGS['search-model'] || 'haiku');

// Key 两个来源：ANTHROPIC_API_KEY 环境变量优先；没设就用请求头里的 Authorization: Bearer
// （程序设置里搜索服务 / 模型 API 的「API Key」那一栏就是这么发过来的），这样不用碰环境变量也能用。
const ENV_KEY = String(process.env.ANTHROPIC_API_KEY || '').trim();
if (!ENV_KEY) console.warn('没有 ANTHROPIC_API_KEY 环境变量：改用每个请求自带的 API Key（在程序设置里填）。');
const requestKey = new AsyncLocalStorage();
const clients = new Map();
function currentClient() {
  const key = ENV_KEY || requestKey.getStore() || '';
  if (!key) throw Object.assign(new Error('没有 API Key：在程序设置里这个服务的「API Key」栏填上，或者设 ANTHROPIC_API_KEY 环境变量'), { status: 401 });
  if (!clients.has(key)) clients.set(key, new Anthropic({ apiKey: key, timeout: TIMEOUT_MS, maxRetries: 2 }));
  return clients.get(key);
}

const MODEL_IDS = { sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5', haiku: 'claude-haiku-5-5', fable: 'claude-fable-5-1' };
// 服务端 fallbacks: "default" 只在这几个模型上可用
const FALLBACK_MODELS = new Set(['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1']);
// 动态过滤版 web_search 只有 Opus / Sonnet 支持，其余用基础版
const DYNAMIC_SEARCH = /^claude-(opus|sonnet)-/;
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const log = (...a) => console.log(new Date().toTimeString().slice(0, 8), ...a);

let running = 0;
const waiting = [];
async function withSlot(fn) {
  if (running >= MAX_PARALLEL) await new Promise((r) => waiting.push(r));
  running++;
  try { return await fn(); } finally {
    running--;
    waiting.shift()?.();
  }
}

function resolveModel(requested) {
  const m = String(requested || '').trim().replace(/^(claude-code|anthropic)\//i, '');
  if (!m || /^(default|claude-code)$/i.test(m)) return MODEL_IDS[DEFAULT_MODEL] || DEFAULT_MODEL;
  return MODEL_IDS[m.toLowerCase()] || m;
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

// ── thinking 暂存：tool_use id → 产出它的那一轮的 thinking 块。只在同一轮工具循环里送回 ──
const thinkingByToolId = new Map();
function rememberThinking(content) {
  const thinking = content.filter((b) => b.type === 'thinking' || b.type === 'redacted_thinking');
  if (!thinking.length) return;
  for (const b of content) if (b.type === 'tool_use') thinkingByToolId.set(b.id, { at: Date.now(), blocks: thinking });
  for (const [id, v] of thinkingByToolId) if (Date.now() - v.at > 30 * 60 * 1000) thinkingByToolId.delete(id);
}

function safeJson(s) {
  try { const v = JSON.parse(s || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}

/** OpenAI 消息 → Messages API 消息：同角色合并，tool 结果并进一条 user，首条必须是 user。 */
function buildMessages(rest, { replayThinking }) {
  // 最后一条真正的 user 消息之后才算"本轮工具循环"
  let loopStart = 0;
  rest.forEach((m, i) => { if (m.role === 'user') loopStart = i; });
  const out = [];
  const push = (role, blocks) => {
    if (!blocks.length) return;
    const last = out[out.length - 1];
    if (last?.role === role) last.content.push(...blocks);
    else out.push({ role, content: [...blocks] });
  };
  rest.forEach((m, i) => {
    if (m.role === 'user') {
      push('user', toBlocks(m.content));
    } else if (m.role === 'assistant') {
      const blocks = [];
      const calls = m.tool_calls || [];
      const saved = replayThinking && i > loopStart && calls.length ? thinkingByToolId.get(calls[0].id) : null;
      if (saved) blocks.push(...saved.blocks);
      const text = textOf(m.content);
      if (text) blocks.push({ type: 'text', text });
      for (const call of calls) {
        blocks.push({ type: 'tool_use', id: call.id, name: call.function?.name, input: safeJson(call.function?.arguments) });
      }
      push('assistant', blocks);
    } else if (m.role === 'tool') {
      push('user', [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: textOf(m.content) || '(空)' }]);
    }
  });
  if (out[0]?.role !== 'user') out.unshift({ role: 'user', content: [{ type: 'text', text: '(对话开始)' }] });
  if (out[out.length - 1]?.role !== 'user') out.push({ role: 'user', content: [{ type: 'text', text: '继续。' }] });
  return out;
}

/** 把一次 OpenAI 请求翻成 Messages API 参数。 */
function plan(body, { replayThinking = true } = {}) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let system = messages.filter((m) => m.role === 'system').map((m) => textOf(m.content)).join('\n\n');
  const rest = messages.filter((m) => m.role !== 'system');
  const model = resolveModel(body.model);
  const choice = body.tool_choice;
  const tools = (Array.isArray(body.tools) ? body.tools : []).map((t) => {
    const f = t.function || t;
    return { name: f.name, description: String(f.description || ''), input_schema: f.parameters || { type: 'object', properties: {} } };
  }).filter((t) => t.name);

  let mode = tools.length ? 'tools' : 'text';
  const forcedName = typeof choice === 'object' ? choice?.function?.name : '';
  if (tools.length && (forcedName || choice === 'required')) {
    system += `\n\n这一轮必须调用工具${forcedName ? ` ${forcedName}` : ''}。`;
  }
  if (!tools.length && (body.response_format?.type === 'json_schema' || body.response_format?.type === 'json_object')) {
    mode = 'json';
    const schema = body.response_format.json_schema?.schema;
    system += `\n\n只输出一个 JSON 对象，不要代码块、不要解释。${schema ? `\nJSON schema：${JSON.stringify(schema)}` : ''}`;
  }

  const serverTools = [];
  if (String(body.claude_tools || '').split(/[\s,]+/).includes('WebSearch')) {
    serverTools.push({ type: DYNAMIC_SEARCH.test(model) ? 'web_search_20260209' : 'web_search_20250305', name: 'web_search', max_uses: 3 });
  }

  const effort = EFFORTS.has(String(body.reasoning_effort)) ? String(body.reasoning_effort) : DEFAULT_EFFORT;
  const params = {
    model,
    max_tokens: Math.min(MAX_TOKENS, Number(body.max_tokens || body.max_completion_tokens) || MAX_TOKENS),
    system: [{ type: 'text', text: system || 'You are a helpful assistant.', cache_control: { type: 'ephemeral' } }],
    messages: buildMessages(rest, { replayThinking }),
    output_config: { effort }
  };
  if (tools.length || serverTools.length) params.tools = [...tools, ...serverTools];
  if (tools.length && choice === 'none') params.tool_choice = { type: 'none' };
  return { params, mode };
}

async function callClaude(params, signal) {
  const client = currentClient();
  const req = { ...params };
  const betas = [];
  if (USE_FALLBACKS && FALLBACK_MODELS.has(req.model)) {
    betas.push('server-side-fallback-2026-07-01');
    req.fallbacks = 'default';
  }
  if (betas.length) req.betas = betas;
  let message = await client.beta.messages.stream(req, { signal }).finalMessage();
  // 服务端工具（web_search）跑太久会 pause_turn：把这一段接回去继续
  for (let i = 0; i < 3 && message.stop_reason === 'pause_turn'; i++) {
    req.messages = [...req.messages, { role: 'assistant', content: message.content }];
    message = await client.beta.messages.stream(req, { signal }).finalMessage();
  }
  return message;
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

function toCompletion(mode, msg) {
  const u = msg.usage || {};
  const cached = Number(u.cache_read_input_tokens) || 0;
  const prompt = (Number(u.input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0) + cached;
  const content = msg.content || [];
  const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  const calls = content.filter((b) => b.type === 'tool_use');
  const message = { role: 'assistant', content: text || null };
  let finish = msg.stop_reason === 'max_tokens' ? 'length' : 'stop';

  if (mode === 'json') {
    message.content = JSON.stringify(extractJson(text) ?? {});
  } else if (calls.length) {
    rememberThinking(content);
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
      prompt_tokens_details: { cached_tokens: cached }
    }
  };
}

/** 搜索：服务端 web_search，返回 { results: [{ title, url, snippet }] }。 */
async function search(body, signal) {
  const query = String(body.query ?? body.q ?? '').trim().slice(0, 300);
  const topK = Math.min(8, Math.max(1, Number(body.top_k ?? body.count) || 6));
  const model = resolveModel(SEARCH_MODEL);
  const msg = await callClaude({
    model,
    max_tokens: 4000,
    system: `用 web_search 搜索用户给的关键词（可以换说法多搜一两次），然后只输出一个 JSON：{"results":[{"title","url","snippet"}]}，最多 ${topK} 条最相关的。title、url 照搜索结果原样给；snippet 用页面里跟问题相关的原文要点，不要编，不要加你自己的评论。`,
    messages: [{ role: 'user', content: query }],
    tools: [{ type: DYNAMIC_SEARCH.test(model) ? 'web_search_20260209' : 'web_search_20250305', name: 'web_search', max_uses: 3 }]
  }, signal);
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  let results = (extractJson(text)?.results || []).filter((x) => x?.url);
  if (!results.length) {
    // 模型没按格式交：退回原始搜索结果（只有标题和链接）
    results = msg.content
      .filter((b) => b.type === 'web_search_tool_result' && Array.isArray(b.content))
      .flatMap((b) => b.content)
      .filter((r) => r.type === 'web_search_result')
      .slice(0, topK)
      .map((r) => ({ title: r.title, url: r.url, snippet: '' }));
  }
  return { query, results: results.slice(0, topK) };
}

function send(res, status, data) {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function apiError(error) {
  const status = error instanceof Anthropic.APIError ? (error.status || 502) : (error.status || 500);
  return { status, message: error.message };
}

const server = http.createServer((req, res) => {
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  requestKey.run(bearer, () => handle(req, res));
});

async function handle(req, res) {
  // 只给本机程序用：浏览器页面（带 Origin）和 DNS rebinding（Host 不是本机）一律拒绝，
  // 否则任何网页都能借这个口子花你的 API 额度
  const host = String(req.headers.host || '').replace(/:\d+$/, '');
  if (req.headers.origin || !['127.0.0.1', 'localhost', '[::1]'].includes(host)) {
    return send(res, 403, { error: { message: 'forbidden' } });
  }
  const url = new URL(req.url, 'http://127.0.0.1');
  const route = url.pathname.replace(/^\/v1/, '');

  if (req.method === 'GET' && route === '/models') {
    return send(res, 200, { object: 'list', data: Object.keys(MODEL_IDS).map((id) => ({ id, object: 'model', owned_by: 'anthropic' })) });
  }

  let body;
  if (req.method === 'POST') {
    try { body = await readJson(req); } catch { return send(res, 400, { error: { message: 'invalid JSON body' } }); }
  }
  const abort = new AbortController();
  res.on('close', () => { if (!res.writableFinished) abort.abort(); });
  const started = Date.now();

  if (req.method === 'POST' && route === '/search') {
    if (!String(body.query ?? body.q ?? '').trim()) return send(res, 400, { error: { message: 'query 不能为空' } });
    try {
      const out = await withSlot(() => search(body, abort.signal));
      log(`✓ search "${out.query.slice(0, 40)}" → ${out.results.length} results ${Date.now() - started}ms`);
      return send(res, 200, out);
    } catch (error) {
      if (abort.signal.aborted) return;
      const e = apiError(error);
      log(`✗ search ${e.status} ${e.message.slice(0, 200)}`);
      return send(res, e.status, { error: { message: e.message } });
    }
  }
  if (req.method !== 'POST' || route !== '/chat/completions') {
    return send(res, 404, { error: { message: `unknown route ${req.method} ${url.pathname}` } });
  }
  if (body.stream) return send(res, 400, { error: { message: 'stream=true 不支持，请用非流式请求' } });

  let p;
  try {
    p = plan(body);
    let msg;
    try {
      msg = await withSlot(() => callClaude(p.params, abort.signal));
    } catch (error) {
      // 送回的 thinking 块对不上（历史被程序改写过）：不带 thinking 再试一次
      if (!(error instanceof Anthropic.BadRequestError) || !/thinking/i.test(error.message)) throw error;
      log(`… thinking 块被拒，去掉重试：${error.message.slice(0, 120)}`);
      p = plan(body, { replayThinking: false });
      msg = await withSlot(() => callClaude(p.params, abort.signal));
    }
    const out = toCompletion(p.mode, msg);
    const calls = out.choices[0].message.tool_calls?.map((c) => c.function.name).join(',') || '-';
    const fell = (msg.content || []).some((b) => b.type === 'fallback') ? ' [fallback]' : '';
    const refused = msg.stop_reason === 'refusal' ? ` [refusal ${msg.stop_details?.category ?? ''}]` : '';
    log(`✓ ${out.model}${fell}${refused} ${p.mode} msgs=${body.messages?.length ?? 0} tools=${body.tools?.length ?? 0} → calls=${calls} `
      + `in=${out.usage.prompt_tokens} (cached ${out.usage.prompt_tokens_details.cached_tokens}) out=${out.usage.completion_tokens} ${Date.now() - started}ms`);
    send(res, 200, out);
  } catch (error) {
    if (abort.signal.aborted) return;
    const e = apiError(error);
    log(`✗ ${p?.params.model ?? '?'} ${e.status} ${e.message.slice(0, 300)}`);
    send(res, e.status, { error: { message: e.message, type: 'anthropic_bridge' } });
  }
}

server.listen(PORT, '127.0.0.1', () => {
  log(`Anthropic API 桥已就绪：http://127.0.0.1:${PORT}/v1  默认模型=${resolveModel('')} effort=${DEFAULT_EFFORT} 并发=${MAX_PARALLEL}`
    + `${USE_FALLBACKS ? ' fallbacks=default' : ''} 搜索=${resolveModel(SEARCH_MODEL)}`);
});
