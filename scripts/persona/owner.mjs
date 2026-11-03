// 本人 QQ 号从哪来（不写死在代码里）：
//   1. 命令行 --owner <QQ>
//   2. data/config.json 里 persona-learn 插件的设置（「工具与技能」→ 持续学习 → 本人 QQ 号）
//   3. plugins/persona-learn/plugin.json 的默认值（plugins/ 不进 git）
import fs from 'node:fs';
import path from 'node:path';

export function resolveOwner(root, args = process.argv.slice(2)) {
  const i = args.indexOf('--owner');
  const candidates = [i >= 0 ? args[i + 1] : ''];
  try { candidates.push(JSON.parse(fs.readFileSync(path.join(root, 'data', 'config.json'), 'utf8'))?.skills?.['persona-learn']?.owner); } catch { /* 没有配置 */ }
  try { candidates.push(JSON.parse(fs.readFileSync(path.join(root, 'plugins', 'persona-learn', 'plugin.json'), 'utf8'))?.settings?.owner); } catch { /* 没装插件 */ }
  const owner = candidates.map((v) => String(v ?? '').trim()).find((v) => /^\d{5,15}$/.test(v));
  if (!owner) {
    console.error('[persona] 不知道本人 QQ 号：加 --owner <QQ>，或在 persona-learn 插件设置里填「本人 QQ 号」');
    process.exit(1);
  }
  return owner;
}
