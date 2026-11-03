// 从 nt_msg_db_util 的导出库（nt_msg_export.db）抽取"我"的发言语料，供人设分析。
//
// 用法：
//   node scripts/persona/extract-corpus.mjs --me <QQ号> [--db <nt_msg_export.db>]
//        [--out data/persona] [--names names.txt] [--sample 400]
//
// 产物（data/ 整个不进版本库）：
//   corpus.jsonl  每条"我"的发言 + 之前最多 2 条上下文（他人一律化名 A/B/…）
//   stats.json    风格统计：长度分布、分条习惯、标点、高频短句/片段、表情、活跃时段
//   sample.jsonl  按月份×会话×长度分层抽样，供人工/模型阅读写人设卡
//
// 隐私：QQ 号、手机号、证件/银行卡号、邮箱、链接、@昵称、文件名、地址片段、
//       --names 里列出的人名地名，全部在写盘前替换成占位符；群名/群号不落盘，
//       会话只保留编号（g01、p01…）。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function parseArgs(argv) {
  const args = { db: 'D:\\Claude\\qq-export\\db\\nt_msg_export.db', out: 'data/persona', names: '', sample: 400, me: '' };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    if (key in args) args[key] = argv[++i];
  }
  if (!/^\d{5,12}$/.test(String(args.me))) throw new Error('需要 --me <QQ号>');
  args.sample = Number(args.sample) || 400;
  return args;
}

const SEGMENT_MARKERS = { 2: '[图片]', 3: '[语音]', 4: '[文件]', 5: '[视频]', 10: '[转发]', 16: '[转发]' };

const SCRUB_RULES = [
  [/https?:\/\/\S+|www\.\S+/gi, '[链接]'],
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[邮箱]'],
  [/(?<![\dA-Za-z])\d{17}[\dXx](?![\dA-Za-z])/g, '[证件号]'],
  [/(?<!\d)1[3-9]\d{9}(?!\d)/g, '[手机号]'],
  [/(?<!\d)\d{6,}(?!\d)/g, '[数字]'],
  [/^@[^\n]{1,40}\n ?/gm, '@某人 '],
  [/@[^\s@，。,.!?！？]{1,30}/g, '@某人'],
  [/[\w\u4e00-\u9fa5-]+\.(pdf|docx?|xlsx?|pptx?|zip|rar|7z|apk|exe|png|jpe?g|gif|mp4|mov|mp3|txt)\b/gi, '[文件]'],
  [/[\u4e00-\u9fa5]{2,6}(省|自治区|特别行政区)[\u4e00-\u9fa5]{0,10}/g, '[地点]'],
  [/[\u4e00-\u9fa5]{2,4}(市|县|区)(?=[\u4e00-\u9fa5]{0,8}(路|街|道|镇|乡|村|小区))/g, '[地点]'],
  [/[\u4e00-\u9fa5]{1,10}(路|街|大道|巷|弄)\d+号?/g, '[地点]'],
  [/[\u4e00-\u9fa5]{2,8}(小区|花园|公寓|大厦|学院|大学|中学|小学)/g, '[地点]'],
  [/\d+(栋|幢|单元|号楼|室)/g, '[地点]']
];

function makeScrubber(namesFile) {
  const names = namesFile && fs.existsSync(namesFile)
    ? fs.readFileSync(namesFile, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    : [];
  // 长名字先替换，避免"张三丰"被"张三"切成半截
  names.sort((a, b) => b.length - a.length);
  return (text) => {
    let t = String(text ?? '');
    for (const n of names) t = t.split(n).join('[名字]');
    for (const [re, rep] of SCRUB_RULES) t = t.replace(re, rep);
    return t.replace(/\n{2,}/g, '\n').trim();
  };
}

/** 文本 + 非文本段落的占位符（图片/QQ 表情/语音…），回复标记单独返回。 */
function renderMessage(row) {
  let text = String(row.text ?? '');
  const extras = [];
  let reply = false;
  const faces = [];
  if (row.content) {
    let segs = [];
    try { segs = JSON.parse(row.content).segments || []; } catch { /* 坏 JSON 当纯文本 */ }
    for (const s of segs) {
      const type = Number(s.content_type);
      if (type === 7) reply = true;
      else if (type === 6 && s.video_text) faces.push(String(s.video_text));
      else if (SEGMENT_MARKERS[type]) extras.push(SEGMENT_MARKERS[type]);
    }
  }
  for (const f of faces) extras.push(`[表情${f}]`);
  if (extras.length) text = `${text}${text ? ' ' : ''}${extras.join('')}`;
  return { text: text.trim(), reply, faces, hasText: Boolean(String(row.text ?? '').trim()) };
}

function chatRows(db, table, chatCol, me) {
  const chats = db.prepare(`SELECT ${chatCol} AS chat, count(*) AS n FROM ${table} WHERE sender_qq = ? GROUP BY 1 ORDER BY n DESC`).all(me);
  // msg_id 是 19 位数，超出 JS 安全整数会直接抛错：只用来排序，不取出
  const stmt = db.prepare(`SELECT timestamp, sender_qq, text, content FROM ${table} WHERE ${chatCol} = ? ORDER BY timestamp, msg_id`);
  // 同一条语句同时只能有一个迭代器：按需创建，逐个会话消费
  return chats.map(({ chat }) => ({ chat, rows: () => stmt.iterate(chat) }));
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

function topNgrams(texts, { min = 2, max = 4, keep = 80, minCount = 15 } = {}) {
  const counts = new Map();
  for (const t of texts) {
    for (const run of t.match(/[\u4e00-\u9fa5]+|[A-Za-z]+/g) || []) {
      if (/^[A-Za-z]+$/.test(run)) {
        if (run.length >= 2) counts.set(run.toLowerCase(), (counts.get(run.toLowerCase()) || 0) + 1);
        continue;
      }
      const seen = new Set();
      for (let n = min; n <= max; n++) {
        for (let i = 0; i + n <= run.length; i++) seen.add(run.slice(i, i + n));
      }
      for (const g of seen) counts.set(g, (counts.get(g) || 0) + 1);
    }
  }
  const ranked = [...counts].filter(([, c]) => c >= minCount).sort((a, b) => b[1] - a[1] || b[0].length - a[0].length);
  // 被更长片段几乎完全覆盖的短片段去掉（"哈哈" vs "哈哈哈"这类只留信息量大的）
  const out = [];
  for (const [g, c] of ranked) {
    if (out.some(([o, oc]) => o.length > g.length && o.includes(g) && oc >= c * 0.9)) continue;
    out.push([g, c]);
    if (out.length >= keep) break;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const me = Number(args.me);
  const scrub = makeScrubber(args.names);
  const db = new DatabaseSync(args.db, { readOnly: true });
  fs.mkdirSync(args.out, { recursive: true });

  const records = [];
  const myTexts = [];
  const lengths = [];
  const hours = new Array(24).fill(0);
  const byMonth = {};
  const shortExact = new Map();
  const faceCounts = new Map();
  const emojiCounts = new Map();
  const endings = { none: 0, '。': 0, '？': 0, '！': 0, '…': 0, '~': 0, other: 0 };
  let replies = 0, mentions = 0, imageOnly = 0, multiLine = 0, bursts = 0, burstMsgs = 0;

  for (const [kind, table, chatCol] of [['g', 'group_messages', 'group_qq'], ['p', 'c2c_messages', 'peer_qq']]) {
    chatRows(db, table, chatCol, me).forEach(({ rows }, idx) => {
      const chatLabel = `${kind}${String(idx + 1).padStart(2, '0')}`;
      const prev = [];
      let lastMineTs = -Infinity;
      for (const row of rows()) {
        const msg = renderMessage(row);
        const mine = Number(row.sender_qq) === me;
        if (mine && msg.text) {
          const letters = new Map();
          const ctx = prev.map((p) => {
            if (p.mine) return `我: ${p.text}`;
            if (!letters.has(p.sender)) letters.set(p.sender, String.fromCharCode(65 + letters.size));
            return `${letters.get(p.sender)}: ${p.text}`;
          });
          const text = scrub(msg.text);
          const date = new Date(Number(row.timestamp) * 1000);
          const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
          records.push({ d: month, chat: chatLabel, ctx, me: text, reply: msg.reply });

          byMonth[month] = (byMonth[month] || 0) + 1;
          hours[date.getHours()] += 1;
          if (msg.reply) replies += 1;
          if (/^@/.test(String(row.text ?? ''))) mentions += 1;
          for (const f of msg.faces) faceCounts.set(f, (faceCounts.get(f) || 0) + 1);
          if (!msg.hasText) imageOnly += 1;
          if (Number(row.timestamp) - lastMineTs <= 60) { burstMsgs += 1; } else { bursts += 1; burstMsgs += 1; }
          lastMineTs = Number(row.timestamp);
          if (msg.hasText) {
            const plain = scrub(String(row.text)).replace(/^@某人\s*/, '').trim();
            if (plain) {
              myTexts.push(plain);
              lengths.push([...plain].length);
              if (plain.includes('\n')) multiLine += 1;
              if ([...plain].length <= 6) shortExact.set(plain, (shortExact.get(plain) || 0) + 1);
              for (const e of plain.match(/\p{Extended_Pictographic}/gu) || []) emojiCounts.set(e, (emojiCounts.get(e) || 0) + 1);
              const last = plain.slice(-1);
              if ('。.'.includes(last)) endings['。'] += 1;
              else if ('？?'.includes(last)) endings['？'] += 1;
              else if ('！!'.includes(last)) endings['！'] += 1;
              else if (plain.endsWith('…') || plain.endsWith('...')) endings['…'] += 1;
              else if ('~～'.includes(last)) endings['~'] += 1;
              else if (/[\p{L}\p{N}]/u.test(last)) endings.none += 1;
              else endings.other += 1;
            }
          }
        }
        if (msg.text) {
          prev.push({ mine, sender: row.sender_qq, text: scrub(msg.text).slice(0, 200) });
          if (prev.length > 2) prev.shift();
        }
      }
    });
  }
  db.close();

  lengths.sort((a, b) => a - b);
  const share = (pred) => Number((lengths.filter(pred).length / (lengths.length || 1)).toFixed(3));
  const stats = {
    messages: records.length,
    withText: myTexts.length,
    imageOnly,
    byKind: { group: records.filter((r) => r.chat.startsWith('g')).length, private: records.filter((r) => r.chat.startsWith('p')).length },
    byMonth,
    length: {
      p25: percentile(lengths, 0.25), median: percentile(lengths, 0.5), p75: percentile(lengths, 0.75), p95: percentile(lengths, 0.95),
      le5: share((n) => n <= 5), le10: share((n) => n <= 10), le20: share((n) => n <= 20), gt50: share((n) => n > 50)
    },
    multiLineShare: Number((multiLine / (myTexts.length || 1)).toFixed(3)),
    avgMessagesPerBurst: Number((burstMsgs / (bursts || 1)).toFixed(2)),
    replyShare: Number((replies / (records.length || 1)).toFixed(3)),
    mentionShare: Number((mentions / (records.length || 1)).toFixed(3)),
    endings,
    latinShare: Number((myTexts.filter((t) => /[A-Za-z]{2,}/.test(t)).length / (myTexts.length || 1)).toFixed(3)),
    hourHistogram: hours,
    topShortMessages: [...shortExact].sort((a, b) => b[1] - a[1]).slice(0, 50),
    topFragments: topNgrams(myTexts),
    topQQFaces: [...faceCounts].sort((a, b) => b[1] - a[1]).slice(0, 20),
    topEmoji: [...emojiCounts].sort((a, b) => b[1] - a[1]).slice(0, 20)
  };

  // 分层抽样：月份 × 会话 × 长度档，每层轮流取，保证覆盖面而不是只抽到最活跃的群
  const bucketOf = (r) => {
    const n = [...r.me].length;
    return `${r.d}|${r.chat}|${n <= 5 ? 's' : n <= 20 ? 'm' : 'l'}`;
  };
  const buckets = new Map();
  for (const r of records) {
    if (!r.me || /^\[(图片|视频|语音|文件|转发)\]$/.test(r.me)) continue;
    const k = bucketOf(r);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(r);
  }
  let seed = 20261029;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (const list of buckets.values()) list.sort(() => rand() - 0.5);
  const sample = [];
  const lists = [...buckets.values()];
  for (let round = 0; sample.length < args.sample && lists.some((l) => l.length > round); round++) {
    for (const l of lists) {
      if (l[round]) sample.push(l[round]);
      if (sample.length >= args.sample) break;
    }
  }

  const write = (name, data) => fs.writeFileSync(path.join(args.out, name), data, 'utf8');
  write('corpus.jsonl', records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  write('sample.jsonl', sample.map((r) => JSON.stringify(r)).join('\n') + '\n');
  write('stats.json', JSON.stringify(stats, null, 2));
  console.log(`corpus ${records.length} 条 · sample ${sample.length} 条 · 输出 ${path.resolve(args.out)}`);
}

main();
