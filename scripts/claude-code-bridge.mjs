// Claude Code 桥：把 OpenAI 兼容的 /v1/chat/completions 请求转成本机 `claude -p` 调用。
// 目的：不接任何第三方 API —— 模型走本机 Claude Code 的登录（订阅），程序本体一行不用改。
//
// 用法：
//   node scripts/claude-code-bridge.mjs [--port 3456] [--model sonnet] [--effort low] [--parallel 3]
// 然后在设置里：API 地址 http://127.0.0.1:3456/v1，模型 sonnet / opus / haiku / fable（或完整 id），Key 随便填。
//
// 做法：
//   · system 消息 → --system-prompt-file（Windows 命令行上限 32K 字符，人设 + 准则 + 工具说明会超）
//   · 其余消息拼成一份对话记录，作为一条 user 消息从 stdin（stream-json）送进去；data: 图片转成 image 块
//   · 有 tools 时用 --json-schema 让模型交 { content, tool_calls }，再翻成 OpenAI 的 tool_calls
//   · --tools "" + --strict-mcp-config + --safe-mode：不给 Claude Code 任何内置工具 / MCP / CLAUDE.md / hooks，
//     它只当"大脑"，工具一律由本程序执行
//   · --no-session-persistence：每条消息都是一次独立调用，不往 ~/.claude/projects 里堆会话文件
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([\w-]+)(?:=(.*))?$/.exec(argv[i]);
    if (!m) continue;
    out[m[1]] = m[2] ?? argv[++i];
  }
  return out;
}

const ARGS = parseArgs(process.argv.slice(2));
const PORT = Number(ARGS.port || process.env.CLAUDE_BRIDGE_PORT || 3456);
const DEFAULT_MODEL = String(ARGS.model || process.env.CLAUDE_BRIDGE_MODEL || 'sonnet');
const DEFAULT_EFFORT = String(ARGS.effort || process.env.CLAUDE_BRIDGE_EFFORT || '');
const MAX_PARALLEL = Math.max(1, Number(ARGS.parallel || process.env.CLAUDE_BRIDGE_PARALLEL || 3));
// 程序侧默认 180s 超时；这里先一步收掉子进程，免得超时后还在后台烧额度
const TIMEOUT_MS = Math.max(10000, Number(ARGS.timeout || 170000));
// 不写 .cmd：Windows 上 PATHEXT 会让 claude.cmd 之类的包装脚本有机会顶替官方 claude.exe
const CLAUDE_BIN = String(ARGS.bin || process.env.CLAUDE_BIN || (process.platform === 'win32' ? 'claude.exe' : 'claude'));
const WORK_DIR = path.join(os.tmpdir(), 'qq-agent-claude-bridge');

const MODEL_ALIASES = ['sonnet', 'opus', 'haiku', 'fable'];
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const log = (...a) => console.log(new Date().toTimeString().slice(0, 8), ...a);

// ── 并发闸：每个请求一个 claude 进程，群聊高峰时别一口气拉起十几个 ──
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
  const m = String(requested || '').trim().replace(/^claude-code\//i, '');
  if (!m || /^(default|claude-code)$/i.test(m)) return DEFAULT_MODEL;
  return m;
}

function textOf(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((p) => p?.type === 'text').map((p) => p.text).join('\n');
  return String(content);
}

/** OpenAI 内容部件 → Anthropic 内容块（文本 / base64 图片；视频和外链图片降级成文字说明）。 */
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
      } else {
        blocks.push({ type: 'text', text: '[图片：格式不受支持，已省略]' });
      }
    } else if (part?.type === 'video_url') {
      blocks.push({ type: 'text', text: '[视频：Claude 不能直接读视频，已省略]' });
    }
  }
  return blocks;
}

/** 非 system 消息 → 一条 user 消息的内容块：按时间顺序的对话记录，图片原位插入。 */
function buildTranscript(messages) {
  const blocks = [{ type: 'text', text: '以下是到目前为止的对话记录（按时间顺序）。你是其中的 assistant。\n' }];
  const push = (text) => blocks.push({ type: 'text', text });
  for (const m of messages) {
    if (m.role === 'user') {
      push('\n【user】');
      blocks.push(...toBlocks(m.content));
    } else if (m.role === 'assistant') {
      const text = textOf(m.content);
      push(`\n【assistant】${text ? `\n${text}` : ''}`);
      for (const call of m.tool_calls || []) {
        push(`\n【assistant 调用工具 #${call.id}】${call.function?.name}(${call.function?.arguments || '{}'})`);
      }
    } else if (m.role === 'tool') {
      push(`\n【工具结果 #${m.tool_call_id}${m.name ? ` ${m.name}` : ''}】\n${textOf(m.content)}`);
    }
  }
  push('\n\n—— 记录结束。现在轮到你（assistant）给出下一步。');
  return blocks;
}

function toolProtocol(tools, forced) {
  const lines = [
    '',
    '## 输出协议（桥接层）',
    '你在一个程序里充当模型，必须通过 StructuredOutput 交出这一轮的结果：',
    '- content：这一轮的文字（不需要就给空字符串）。',
    '- tool_calls：这一轮要调用的工具，按顺序执行；不调用就给空数组。arguments 必须符合该工具的参数 schema。',
    '工具由程序执行，结果会出现在下一轮对话记录的【工具结果】里。只能用下面列出的工具。',
    forced ? `这一轮必须调用工具${forced === true ? '' : ` ${forced}`}。` : '',
    '',
    '## 可用工具'
  ];
  for (const t of tools) {
    const f = t.function || t;
    lines.push('', `### ${f.name}`, String(f.description || '').trim(), `参数 schema：${JSON.stringify(f.parameters || { type: 'object' })}`);
  }
  return lines.filter((l) => l !== null).join('\n');
}

/** 把一次 OpenAI 请求翻成 claude 的参数 / stdin / 结果解析方式。 */
function plan(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const system = messages.filter((m) => m.role === 'system').map((m) => textOf(m.content)).join('\n\n');
  const rest = messages.filter((m) => m.role !== 'system');
  const choice = body.tool_choice;
  const tools = choice === 'none' ? [] : (Array.isArray(body.tools) ? body.tools : []);

  let schema = null;
  let mode = 'text';
  let systemExtra = '';
  if (tools.length) {
    mode = 'tools';
    const names = tools.map((t) => (t.function || t).name).filter(Boolean);
    const forcedName = typeof choice === 'object' ? choice?.function?.name : '';
    const calls = {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string', enum: forcedName ? [forcedName] : names }, arguments: { type: 'object' } },
        required: ['name', 'arguments']
      }
    };
    if (forcedName || choice === 'required') calls.minItems = 1;
    schema = { type: 'object', properties: { content: { type: 'string' }, tool_calls: calls }, required: ['content', 'tool_calls'] };
    systemExtra = toolProtocol(tools, forcedName || choice === 'required');
  } else if (body.response_format?.type === 'json_schema' || body.response_format?.type === 'json_object') {
    mode = 'json';
    schema = body.response_format.json_schema?.schema || { type: 'object' };
  }

  const effort = EFFORTS.has(String(body.reasoning_effort)) ? String(body.reasoning_effort) : DEFAULT_EFFORT;
  // 可选：让 Claude Code 在这一轮里自己用 WebSearch / WebFetch（只认这两个，其余一律忽略）
  const claudeTools = String(body.claude_tools || '').split(/[\s,]+/).filter((t) => ['WebSearch', 'WebFetch'].includes(t)).join(',');
  return {
    model: resolveModel(body.model),
    effort,
    tools: claudeTools,
    system: (system || 'You are a helpful assistant.') + systemExtra,
    content: buildTranscript(rest),
    schema,
    mode
  };
}

function runClaude(p, signal) {
  const id = crypto.randomUUID();
  fs.mkdirSync(WORK_DIR, { recursive: true });
  const promptFile = path.join(WORK_DIR, `${id}.system.txt`);
  fs.writeFileSync(promptFile, p.system, 'utf8');
  const args = [
    '-p', '--safe-mode', '--tools', p.tools || '', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands',
    '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--model', p.model, '--system-prompt-file', promptFile
  ];
  if (p.tools) args.push('--allowedTools', p.tools);
  if (p.effort) args.push('--effort', p.effort);
  if (p.schema) args.push('--json-schema', JSON.stringify(p.schema));

  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, args, { cwd: WORK_DIR, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let result = null;
    const done = (fn, v) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      fs.rm(promptFile, { force: true }, () => {});
      fn(v);
    };
    const timer = setTimeout(() => { child.kill(); done(reject, Object.assign(new Error(`claude 超过 ${TIMEOUT_MS}ms 未返回`), { status: 504 })); }, TIMEOUT_MS);
    const onAbort = () => { child.kill(); done(reject, Object.assign(new Error('客户端已断开'), { status: 499 })); };
    signal.addEventListener('abort', onAbort, { once: true });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      let nl;
      while ((nl = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, nl).trim();
        stdout = stdout.slice(nl + 1);
        if (!line.startsWith('{')) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.type === 'result') result = ev;
        } catch { /* 非 JSON 行忽略 */ }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => { stderr = (stderr + c).slice(-4000); });
    child.on('error', (error) => done(reject, Object.assign(new Error(`启动 ${CLAUDE_BIN} 失败：${error.message}`), { status: 500 })));
    child.on('close', (code) => {
      if (result) return done(resolve, result);
      done(reject, Object.assign(new Error(`claude 退出（code=${code}）却没给结果：${stderr.trim().slice(-800) || '无输出'}`), { status: 502 }));
    });

    child.stdin.end(JSON.stringify({ type: 'user', message: { role: 'user', content: p.content } }) + '\n');
  });
}

/**
 * 搜索：给程序的「自定义搜索（openai 类型）」用。只开 Claude Code 自带的 WebSearch 一个工具，
 * 搜索走 Claude 订阅本身，不接任何第三方搜索 API。返回 { results: [{ title, url, snippet }] }。
 */
const SEARCH_MODEL = String(ARGS['search-model'] || 'haiku');
const SEARCH_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array', maxItems: 8,
      items: { type: 'object', properties: { title: { type: 'string' }, url: { type: 'string' }, snippet: { type: 'string' } }, required: ['title', 'url', 'snippet'] }
    }
  },
  required: ['results']
};
function searchPlan(body) {
  const query = String(body.query ?? body.q ?? '').trim().slice(0, 300);
  const topK = Math.min(8, Math.max(1, Number(body.top_k ?? body.count) || 6));
  if (body.images === true) {
    // 图片模式（search_images 用）：要的是能直接下载的图片直链，不是网页链接
    return {
      model: SEARCH_MODEL,
      effort: '',
      tools: 'WebSearch,WebFetch',
      system: `找跟用户关键词相关的图片，交出最多 ${topK} 条图片直链。步骤固定：先 WebSearch；`
        + '再用 WebFetch 打开最相关的一两个页面（wiki、百科、新闻页优先），prompt 写"列出页面里所有图片的完整地址（img src）"；'
        + '看完页面再交结果，没打开过页面不要交。url 必须是图片文件本身（.png/.jpg/.jpeg/.gif/.webp 或图床 CDN 地址），'
        + '不要网页链接、不要 logo/头像/备案图标。缩略图可以；能从缩略图路径看出原图地址的（如 MediaWiki 的 /thumb/.../200px-x.png → 去掉 thumb 和尺寸段），原图放前面、缩略图放后面。'
        + 'title 写这张图是什么（中文，十个字以内）。snippet 写来源网站。页面里确实没有相关图片才交空数组。',
      content: [{ type: 'text', text: query }],
      schema: SEARCH_SCHEMA,
      mode: 'search',
      query
    };
  }
  return {
    model: SEARCH_MODEL,
    effort: '',
    tools: 'WebSearch',
    system: `用 WebSearch 搜索用户给的关键词（可以换说法多搜一两次），然后通过 StructuredOutput 交出最相关的 ${topK} 条结果。title、url 照搜索结果原样给；snippet 用页面里跟问题相关的原文要点，不要编，不要加你自己的评论。`,
    content: [{ type: 'text', text: query }],
    schema: SEARCH_SCHEMA,
    mode: 'search',
    query
  };
}

function toCompletion(p, r) {
  const u = r.usage || {};
  const cached = Number(u.cache_read_input_tokens) || 0;
  const prompt = (Number(u.input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0) + cached;
  const model = Object.keys(r.modelUsage || {})[0] || p.model;
  const message = { role: 'assistant', content: null };
  let finish = 'stop';

  if (p.mode === 'tools') {
    const out = r.structured_output || {};
    const calls = (Array.isArray(out.tool_calls) ? out.tool_calls : []).filter((c) => c?.name);
    message.content = String(out.content ?? '').trim() || null;
    if (calls.length) {
      message.tool_calls = calls.map((c) => ({
        id: `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
        type: 'function',
        function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) }
      }));
      finish = 'tool_calls';
    }
  } else if (p.mode === 'json') {
    message.content = JSON.stringify(r.structured_output ?? {});
  } else {
    message.content = String(r.result ?? '');
  }

  return {
    id: `chatcmpl-${r.session_id || crypto.randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: {
      prompt_tokens: prompt,
      completion_tokens: Number(u.output_tokens) || 0,
      total_tokens: prompt + (Number(u.output_tokens) || 0),
      prompt_tokens_details: { cached_tokens: cached }
    }
  };
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

const server = http.createServer(async (req, res) => {
  // 只给本机程序用：浏览器页面（带 Origin）和 DNS rebinding（Host 不是本机）一律拒绝，
  // 否则任何网页都能借这个口子花你的 Claude 额度
  const host = String(req.headers.host || '').replace(/:\d+$/, '');
  if (req.headers.origin || !['127.0.0.1', 'localhost', '[::1]'].includes(host)) {
    return send(res, 403, { error: { message: 'forbidden' } });
  }
  const url = new URL(req.url, 'http://127.0.0.1');
  const route = url.pathname.replace(/^\/v1/, '');

  if (req.method === 'GET' && route === '/models') {
    return send(res, 200, { object: 'list', data: MODEL_ALIASES.map((id) => ({ id, object: 'model', owned_by: 'claude-code' })) });
  }
  if (req.method === 'POST' && route === '/search') {
    let body;
    try { body = await readJson(req); } catch { return send(res, 400, { error: { message: 'invalid JSON body' } }); }
    const sp = searchPlan(body);
    if (!sp.query) return send(res, 400, { error: { message: 'query 不能为空' } });
    const abort = new AbortController();
    res.on('close', () => { if (!res.writableFinished) abort.abort(); });
    const started = Date.now();
    try {
      const r = await withSlot(() => runClaude(sp, abort.signal));
      if (r.is_error) {
        log(`✗ search ${Number(r.api_error_status) || 502} ${String(r.result || r.subtype).slice(0, 200)}`);
        return send(res, Number(r.api_error_status) || 502, { error: { message: String(r.result || r.subtype || 'claude error') } });
      }
      const results = (r.structured_output?.results || []).filter((x) => x?.url);
      log(`✓ search${body.images === true ? '(images)' : ''} "${sp.query.slice(0, 40)}" → ${results.length} results ${Date.now() - started}ms`);
      return send(res, 200, { query: sp.query, results });
    } catch (error) {
      if (abort.signal.aborted) return;
      log(`✗ search ${error.message}`);
      return send(res, error.status || 500, { error: { message: error.message } });
    }
  }
  if (req.method !== 'POST' || route !== '/chat/completions') {
    return send(res, 404, { error: { message: `unknown route ${req.method} ${url.pathname}` } });
  }

  let body;
  try { body = await readJson(req); } catch { return send(res, 400, { error: { message: 'invalid JSON body' } }); }
  if (body.stream) return send(res, 400, { error: { message: 'stream=true 不支持，请用非流式请求' } });

  const abort = new AbortController();
  res.on('close', () => { if (!res.writableFinished) abort.abort(); });
  const started = Date.now();
  let p;
  try {
    p = plan(body);
    const r = await withSlot(() => runClaude(p, abort.signal));
    if (r.is_error) {
      const status = Number(r.api_error_status) || 502;
      log(`✗ ${p.model} ${status} ${String(r.result || r.subtype).slice(0, 200)}`);
      return send(res, status, { error: { message: String(r.result || r.subtype || 'claude error'), type: 'claude_code_error' } });
    }
    const out = toCompletion(p, r);
    const calls = out.choices[0].message.tool_calls?.map((c) => c.function.name).join(',') || '-';
    log(`✓ ${out.model} ${p.mode} msgs=${body.messages?.length ?? 0} tools=${body.tools?.length ?? 0} → calls=${calls} `
      + `in=${out.usage.prompt_tokens} out=${out.usage.completion_tokens} ${Date.now() - started}ms`);
    send(res, 200, out);
  } catch (error) {
    if (abort.signal.aborted) return;
    log(`✗ ${p?.model ?? '?'} ${error.message}`);
    send(res, error.status || 500, { error: { message: error.message, type: 'claude_code_bridge' } });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  log(`Claude Code 桥已就绪：http://127.0.0.1:${PORT}/v1  默认模型=${DEFAULT_MODEL}${DEFAULT_EFFORT ? ` effort=${DEFAULT_EFFORT}` : ''} 并发=${MAX_PARALLEL}`);
});
