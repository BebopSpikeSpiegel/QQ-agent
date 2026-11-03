// 机器人实际发表情包的情况（只读，不花钱）：从 data/sessions 里的运行记录统计。
//
// 用法：
//   node scripts/persona/sticker-stats.mjs [--since "2026-10-31 21:10"] [--hours 24] [--owner QQ] [--list]
//
// 默认看最近 24 小时。--since 优先（本地时间），比如从某次重启开始算。--list 逐条列出发了表情的回复。
//
// 口径：
//   回复      = 这次运行往聊天里实际发出了东西（文字或表情）；插件回执不经过模型，不在 sessions 里
//   带表情    = 这次回复里有 send_sticker 发出的表情
//   只发表情  = 这次回复只有表情、一个字没说
//   本人基准  = 同一时间段里本人（--owner）不带插件指令的消息中，只发图/表情没字的占比
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveOwner } from './owner.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const arg = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : '');
const OWNER = resolveOwner(ROOT);
const LIST = args.includes('--list');
const since = arg('--since')
  ? new Date(arg('--since').replace(' ', 'T')).getTime()
  : Date.now() - (Number(arg('--hours')) || 24) * 3600 * 1000;
if (!Number.isFinite(since)) { console.error('--since 看不懂，写成 "2026-10-31 21:10" 这样'); process.exit(1); }

const readJson = (p, fallback) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } };

// ── 表情库：id → 备注 ──
const store = readJson(path.join(ROOT, 'data', 'stickers.json'), []);
const library = (Array.isArray(store) ? store : store.stickers || []);
const labelOf = new Map(library.map((e) => [e.id, e.desc || e.localNote || e.id]));

// ── 机器人的回复 ──
const runs = [];
for (const f of fs.readdirSync(path.join(ROOT, 'data', 'sessions'))) {
  if (!f.endsWith('.json')) continue;
  const s = readJson(path.join(ROOT, 'data', 'sessions', f), null);
  if (!s || (s.startedAt || 0) < since) continue;
  const sent = Array.isArray(s.sent) ? s.sent : [];
  if (!sent.length) continue;
  // 发了哪几张：sent 里只有备注文字，id 从 send_sticker 调用里取（按顺序对上）
  const ids = [];
  for (const m of s.messages || []) {
    for (const t of m.tool_calls || []) {
      if (t.function?.name !== 'send_sticker') continue;
      try { ids.push(String(JSON.parse(t.function.arguments || '{}').stickerId || '')); } catch { ids.push(''); }
    }
  }
  const stickers = sent.filter((x) => x.type === 'sticker');
  const texts = sent.filter((x) => x.type !== 'sticker');
  runs.push({
    at: s.startedAt,
    chat: s.chatKey,
    trigger: String(s.triggerText || '').replace(/\s+/g, ' ').slice(0, 60),
    stickers: stickers.map((x, i) => ({ id: ids[i] || '', label: String(x.text || '').replace(/^\[表情包:|\]$/g, '') })),
    textOnly: texts.map((x) => String(x.text || '')).join(' / ').slice(0, 60)
  });
}
runs.sort((a, b) => a.at - b.at);

// ── 本人基准 ──
const CMD = /(^|[^a-z0-9_/／])[/／][一-龥a-z]+/i;
let ownerTotal = 0;
let ownerImg = 0;
for (const f of fs.readdirSync(path.join(ROOT, 'data', 'messages'))) {
  if (!f.endsWith('.json')) continue;
  const d = readJson(path.join(ROOT, 'data', 'messages', f), []);
  const arr = Array.isArray(d) ? d : (d.messages || Object.values(d).find(Array.isArray) || []);
  for (const m of arr) {
    if (String(m.senderId) !== OWNER || m.self || m.atMe || (m.ts || 0) < since) continue;
    const text = String(m.text || '');
    if (CMD.test(text)) continue;
    ownerTotal++;
    const words = text.replace(/^\[引用[^\]]*\]/, '').replace(/\[(图片|动画表情|表情)[^\]]*\]/g, '').trim();
    if ((m.media || []).some((x) => x.kind === 'image') && !words) ownerImg++;
  }
}

// ── 输出 ──
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');
const withSticker = runs.filter((r) => r.stickers.length);
const stickerOnly = withSticker.filter((r) => !r.textOnly);
const fmt = (t) => new Date(t).toLocaleString('zh-CN', { hour12: false });

console.log(`时间段：${fmt(since)} 起\n`);
console.log(`机器人回复 ${runs.length} 次：带表情 ${withSticker.length} 次（${pct(withSticker.length, runs.length)}），其中只发表情 ${stickerOnly.length} 次`);
console.log(`本人消息 ${ownerTotal} 条：只甩图 ${ownerImg} 条（${pct(ownerImg, ownerTotal)}）\n`);

const used = new Map();
for (const r of withSticker) for (const s of r.stickers) used.set(s.id || s.label, (used.get(s.id || s.label) || 0) + 1);
console.log('每张发了几次：');
for (const e of library) console.log(`  ${String(used.get(e.id) || 0).padStart(3)}  ${labelOf.get(e.id)}${(e.tags || []).length ? ` [${e.tags.join('/')}]` : ''}`);
for (const [k, n] of used) if (!labelOf.has(k)) console.log(`  ${String(n).padStart(3)}  ${k}（已不在库里）`);

if (LIST && withSticker.length) {
  console.log('\n发了表情的回复：');
  for (const r of withSticker) {
    console.log(`  ${fmt(r.at)} ${r.chat}`);
    console.log(`    触发：${r.trigger}`);
    console.log(`    表情：${r.stickers.map((s) => s.label).join('、')}${r.textOnly ? `   文字：${r.textOnly}` : '   （只发表情）'}`);
  }
}
