// 持续学习本人（机器人模仿的那个群友，QQ 号见 owner.mjs）的说话方式，刷新角色卡里的自动更新段。
//
// 用法：
//   node scripts/persona/learn-live.mjs [--owner QQ] [--dry]
//
// 做三件事，都只动角色卡里有标记的块，别的段落一个字不碰：
//   live-gap      本人最近 N 条 vs 机器人最近 N 条的逐项对比（第〇节那套指标），偏得多的写成要改的话
//   live-samples  本人最近在群里的原话（去掉指令、引用头、@、链接、纯图片）
//   recent-lines  机器人最近半小时说过的话（去掉插件回执，那些不是"说话"）
//   owner-replies 本人引用机器人的话回它的记录（多是纠正），事实以本人说的为准
// 角色卡以程序里当前生效的为准（内置编辑器改过的不会被冲掉），profile.md 外部改过则用文件的。
// 改完写回 data/persona/profile.md，并通过控制台 API（POST /api/config）热更新
// persona.roleText —— 不直接改 data/config.json，免得被运行中的程序存盘覆盖。
// 程序没开就只写 profile.md，下次跑时再推。
//
// 定时：plugins/persona-learn 在程序里按设定间隔跑（「工具与技能」里开关）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveOwner } from './owner.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MSG_DIR = path.join(ROOT, 'data', 'messages');
const PROFILE = path.join(ROOT, 'data', 'persona', 'profile.md');
const CONFIG = path.join(ROOT, 'data', 'config.json');

const args = process.argv.slice(2);
const OWNER = resolveOwner(ROOT, args);
const DRY = args.includes('--dry');

const WINDOW = 300;          // 对比用最近多少条
const SAMPLE_COUNT = 40;     // 原话段放多少条
const RECENT_MS = 30 * 60 * 1000;
const REPLY_COUNT = 15;     // 本人引用你回你的话放多少条

// 插件回执 / 系统性输出：不是机器人"说的话"，不进对比也不进 recent-lines
const PLUGIN_OUTPUT = /^(🎯|收到，开始|下好了|下载失败|下太快|上一本|PDF |第 \d+ 份|已发 \d+\/|查太快|上一张还在查|引用一张图|用法：|查失败|没查成|图拿不到|这个格式认不出来|两个引擎都关了|没查到，可能)/;

function loadMessages() {
  const all = [];
  for (const f of fs.readdirSync(MSG_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const d = JSON.parse(fs.readFileSync(path.join(MSG_DIR, f), 'utf8'));
      const arr = Array.isArray(d) ? d : (d.messages || Object.values(d).find(Array.isArray) || []);
      for (const m of arr) all.push(m);
    } catch { /* 坏文件跳过 */ }
  }
  return all.sort((a, b) => (a.ts || 0) - (b.ts || 0));
}

/** 本人的一条消息 → 纯说话文本；不算说话的返回空串。 */
function ownerText(m) {
  let t = String(m.text || '');
  t = t.replace(/^\[引用[^\]]*\]/, '');                // 引用头
  t = t.replace(/@\S+(\s*\([^)]*\))?\s?/g, '');         // @某人
  t = t.replace(/\[(图片|动画表情|表情|语音|视频|文件|转发)[^\]]*\]/g, '');
  t = t.trim();
  if (!t) return '';
  if (/https?:\/\/|www\./i.test(t)) return '';
  if (/(^|[^a-z0-9_/／])[/／][一-龥a-z]+/i.test(t)) return ''; // 插件指令
  if (/\d{6,}/.test(t)) return '';                     // 带号码的不收
  if (t.includes('\n') || t.length > 60) return '';
  return t;
}

// 本人直接引用你说的话再回你：多半是在纠正（"老子他妈上次运行都多少年前了" = 你说"我正在玩老滚5"说错了）。
// 成对列出来，让机器人知道自己哪句被他驳了，事实以他说的为准。
function ownerReplies(msgs, limit = REPLY_COUNT) {
  const out = [];
  const seen = new Set();
  for (let i = msgs.length - 1; i >= 0 && out.length < limit; i--) {
    const m = msgs[i];
    if (String(m.senderId) !== OWNER || m.self || m.reply?.self !== true) continue;
    const said = String(m.reply.text || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    const t = String(m.text || '').replace(/^\[引用[^\]]*\]/, '').replace(/@\S+(\s*\([^)]*\))?\s?/g, '')
      .replace(/\[(图片|动画表情|表情)[^\]]*\]/g, '').trim();
    if (!said || !t || t.length > 80 || /(^|[^a-z0-9_/／])[/／][一-龥a-z]+/i.test(t)) continue;
    const key = said + '|' + t;
    if (seen.has(key)) continue;
    seen.add(key);
    const day = new Date(m.ts || 0);
    out.unshift(`- 你说「${said}」→ 他回「${t}」（${day.getMonth() + 1}/${day.getDate()}）`);
  }
  return out;
}

function botText(m) {
  const t = String(m.text || '').trim();
  if (!t || PLUGIN_OUTPUT.test(t) || t.includes('\n')) return '';
  return t;
}

// ── 指标（和第〇节同一套口径）──
const CJK = '\\u4e00-\\u9fa5';
// oneWay：只提醒"太多了"，不劝多用 —— 本人最近吵架多，脏字/问号/躲闪词的近期比例偏高，不能反过来教机器人多骂
const METRICS = [
  { key: 'space', label: '一条里用空格隔开两句', test: (t) => new RegExp(`[${CJK}]\\s+[${CJK}]`).test(t) || t.includes(' / ') },
  { key: 'wo', label: '带"我"', test: (t) => t.includes('我') },
  { key: 'ni', label: '带"你"', oneWay: true, test: (t) => /你|妳/.test(t) },
  { key: 'qonly', label: '光一个问号', oneWay: true, test: (t) => /^[?？]+$/.test(t) },
  { key: 'punct', label: '句尾加。！～', test: (t) => /[。！!～~]$/.test(t) },
  { key: 'particle', label: '带啊/吧/呢/嘛', test: (t) => /[啊吧呢嘛]/.test(t) },
  { key: 'swear', label: '带脏字', oneWay: true, test: (t) => /操|草泥马|妈的|他妈|傻逼|煞笔|sb|几把|鸡巴|你麻痹|尼玛|狗日/i.test(t) },
  { key: 'dodge', label: '躲闪词（不知道/不认识/保密/你猜/何意味）', oneWay: true, test: (t) => /^(不知道|不认识|保密|你猜|何意味)$/.test(t) }
];

function profileOf(lines) {
  const n = lines.length;
  const lens = lines.map((t) => [...t].length).sort((a, b) => a - b);
  const out = { n, median: n ? lens[Math.floor(n / 2)] : 0 };
  for (const m of METRICS) out[m.key] = n ? lines.filter(m.test).length / n : 0;
  return out;
}

const pct = (x) => `${Math.round(x * 100)}%`;

/** 甩图比例：本人 = 只发图/表情、没字的消息；机器人 = 发出去的表情包/图片。 */
function imageShare(msgs, isMine) {
  const pick = msgs.slice(-WINDOW);
  if (!pick.length) return 0;
  const isImage = (m) => isMine
    ? ((m.media || []).some((x) => x.kind === 'image') && !String(m.text || '').replace(/^\[引用[^\]]*\]/, '').replace(/\[(图片|动画表情|表情)[^\]]*\]/g, '').trim())
    : /^\[(表情包|图片)[:：]/.test(String(m.text || ''));
  return pick.filter(isImage).length / pick.length;
}

function gapBlock(me, bot, stamp) {
  const lines = [];
  lines.push(`对比基准：本人最近 ${me.n} 条 vs 你最近 ${bot.n} 条（${stamp} 自动统计）。差得多的先改：`);
  const fixes = [];
  if (bot.median > me.median * 1.4 && bot.median - me.median >= 3) {
    fixes.push(`- 太长了：本人一条中位数 ${me.median} 个字，你是 ${bot.median} 个。砍短，或者拆成几条发`);
  }
  for (const m of METRICS) {
    const a = me[m.key];
    const b = bot[m.key];
    if (b >= a * 1.6 && b - a >= 0.04) fixes.push(`- ${m.label}：本人 ${pct(a)}，你 ${pct(b)}，太多了，少用`);
    else if (!m.oneWay && a >= b * 1.6 && a - b >= 0.04) fixes.push(`- ${m.label}：本人 ${pct(a)}，你 ${pct(b)}，太少了，多用`);
  }
  if (me.img != null) {
    if (me.img >= bot.img * 1.6 && me.img - bot.img >= 0.04) fixes.push(`- 甩表情包：本人 ${pct(me.img)} 的消息是直接甩图，你 ${pct(bot.img)}，太少了，多甩（从【可用表情包】照抄 id 发）`);
    else if (bot.img >= me.img * 1.6 && bot.img - me.img >= 0.04) fixes.push(`- 甩表情包：本人 ${pct(me.img)}，你 ${pct(bot.img)}，太多了，少甩`);
  }
  if (fixes.length) lines.push(...fixes);
  else lines.push('- 目前各项都跟本人接近，保持');
  return lines.join('\n');
}

function replaceBlock(doc, name, body) {
  const start = `<!-- ${name}:start -->`;
  const end = `<!-- ${name}:end -->`;
  const i = doc.indexOf(start);
  const j = doc.indexOf(end);
  if (i < 0 || j < i) return null;
  return doc.slice(0, i + start.length) + '\n' + body + '\n' + doc.slice(j);
}

const LAST_PUSH = path.join(ROOT, 'data', 'persona', '.last-push.txt');

function appTarget() {
  let port = 3300;
  let token = '';
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
    port = Number(c.server?.port) || 3300;
    token = String(c.server?.token || '');
  } catch { /* 用默认 */ }
  return { base: `http://127.0.0.1:${port}`, headers: token ? { 'x-console-token': token } : {} };
}

/** 程序里当前生效的角色卡；程序没开返回 null。 */
async function fetchAppRoleText() {
  const { base, headers } = appTarget();
  try {
    const res = await fetch(`${base}/api/config`, { headers, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const c = await res.json();
    const t = (c.config ?? c)?.persona?.roleText;
    return typeof t === 'string' && t.trim() ? t : null;
  } catch { return null; }
}

/**
 * 角色卡有两处能改：程序里的内置编辑器（存进 config），和 data/persona/profile.md（外部编辑器）。
 * 拿上次推送的版本当基准：哪边跟基准不一样，就是那边改过，以它为准；两边都改了以程序为准，
 * 文件那份另存成 profile.conflict.md，不丢。
 */
function pickSource(appText, fileText) {
  const last = fs.existsSync(LAST_PUSH) ? fs.readFileSync(LAST_PUSH, 'utf8') : null;
  if (appText == null) return { text: fileText, from: 'profile.md（程序没开）' };
  if (last == null) return { text: appText, from: '程序（首次运行）' };
  const appChanged = appText !== last;
  const fileChanged = fileText !== last;
  if (appChanged && fileChanged && appText !== fileText) {
    fs.writeFileSync(path.join(ROOT, 'data', 'persona', 'profile.conflict.md'), fileText);
    return { text: appText, from: '程序（两边都改了，文件那份存到 profile.conflict.md）' };
  }
  if (fileChanged) return { text: fileText, from: 'profile.md（外部改过）' };
  return { text: appText, from: appChanged ? '程序（内置编辑器改过）' : '程序' };
}

async function pushToApp(roleText) {
  const { base, headers } = appTarget();
  const res = await fetch(`${base}/api/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ persona: { roleText } }),
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

async function main() {
  const msgs = loadMessages();
  const mine = msgs.filter((m) => String(m.senderId) === OWNER && !m.self && !m.atMe)
    .map((m) => ({ ts: m.ts, t: ownerText(m) })).filter((x) => x.t);
  const bots = msgs.filter((m) => m.self).map((m) => ({ ts: m.ts, t: botText(m) })).filter((x) => x.t);

  const me = profileOf(mine.slice(-WINDOW).map((x) => x.t));
  const bot = profileOf(bots.slice(-WINDOW).map((x) => x.t));
  // 甩图比例单独算：要连"没字只有图"的消息一起数，上面的文本统计把它们滤掉了
  me.img = imageShare(msgs.filter((m) => String(m.senderId) === OWNER && !m.self && !m.atMe
    && !/(^|[^a-z0-9_/／])[/／][一-龥a-z]+/i.test(String(m.text || ''))), true);
  bot.img = imageShare(msgs.filter((m) => m.self && !PLUGIN_OUTPUT.test(String(m.text || '').trim())), false);
  const stamp = new Date().toLocaleString('zh-CN', { hour12: false });

  // 原话：最新的在后，去重
  const seen = new Set();
  const samples = [];
  for (let i = mine.length - 1; i >= 0 && samples.length < SAMPLE_COUNT; i--) {
    const t = mine[i].t;
    if (seen.has(t)) continue;
    seen.add(t);
    samples.unshift(`- ${t}`);
  }
  const cutoff = Date.now() - RECENT_MS;
  const recent = [...new Set(bots.filter((x) => x.ts >= cutoff).map((x) => x.t))].map((t) => `- ${t}`);

  const appText = await fetchAppRoleText();
  const src = pickSource(appText, fs.readFileSync(PROFILE, 'utf8'));
  let doc = src.text;
  console.log(`[persona] 角色卡来源：${src.from}`);
  // live-gap 块第一次跑时插到原话块前面
  if (!doc.includes('<!-- live-gap:start -->')) {
    doc = doc.replace('<!-- live-samples:start -->', '<!-- live-gap:start -->\n<!-- live-gap:end -->\n\n<!-- live-samples:start -->');
  }
  // owner-replies 块第一次跑时插到 owner-rules 后面（同属第〇·五节）
  if (!doc.includes('<!-- owner-replies:start -->') && doc.includes('<!-- owner-rules:end -->')) {
    doc = doc.replace('<!-- owner-rules:end -->', '<!-- owner-rules:end -->\n\n'
      + '下面是他最近直接引用你的话回你的记录（自动更新）。他驳你的那句就是你说错了：涉及他自己的事（在不在玩某个游戏、去没去过、喜不喜欢）以他说的为准，以后别再那么说；'
      + '他说"运行""开"一个游戏就是启动它玩，"上次运行都多少年了"= 很久没玩了（他说话爱夸张，"多少年""一万年"这类是"很久"的意思，别照字面当成真的几年）。只是骂你、问你的，按上面的规矩处理，不用当成事实。\n'
      + '<!-- owner-replies:start -->\n<!-- owner-replies:end -->');
  }
  const replies = ownerReplies(msgs);
  for (const [name, body] of [
    ...(doc.includes('<!-- owner-replies:start -->') ? [['owner-replies', replies.join('\n') || '- （最近没有）']] : []),
    ['live-gap', gapBlock(me, bot, stamp)],
    ['live-samples', samples.join('\n') || '- （暂无）'],
    ['recent-lines', recent.join('\n') || '- （最近半小时没说话）']
  ]) {
    const next = replaceBlock(doc, name, body);
    if (next == null) throw new Error(`角色卡里缺 ${name} 标记`);
    doc = next;
  }

  console.log(`[persona] 本人 ${mine.length} 条可用（取近 ${me.n}），机器人 ${bots.length} 条（取近 ${bot.n}）`);
  console.log(gapBlock(me, bot, stamp));
  if (DRY) { console.log('[persona] --dry：不写盘'); return; }

  fs.writeFileSync(PROFILE, doc);
  if (appText == null) { console.log('[persona] 已写 profile.md；程序没开，下次再推'); return; }
  try {
    await pushToApp(doc);
    fs.writeFileSync(LAST_PUSH, doc);
    console.log('[persona] 已写 profile.md 并推送到程序');
  } catch (e) {
    console.log(`[persona] 已写 profile.md；推送到程序失败（${e?.message ?? e}），程序开着时下次再推`);
  }
}

main().catch((e) => { console.error('[persona] 失败：', e?.message ?? e); process.exit(1); });
