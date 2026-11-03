// A successful side effect is not necessarily a delivered answer. Only the
// built-in send_message tool can grant normal completion to this run context.
const delivered = new WeakSet();
// 自己插话（随机命中/活跃期/主动机会）的运行：看完不说话也算正常结束。
// 硬性交付只对"有人在跟你说话"的运行（@、引用、拍一拍、私聊、关键词、关联监听）生效——
// 否则插话时模型决定沉默会被逼着憋一句"经典""我看看""图没加载出来"（11/01 统计两天 155/279 次插话是被逼的）。
const optional = new WeakSet();
export function beginReplyCompletion(ctx, {required = true} = {}) {
  delivered.delete(ctx);
  if (required) optional.delete(ctx); else optional.add(ctx);
  ctx.session.completion = {requiredTool: 'send_message', required, delivered: false, recoveryUsed: false};
}
export function recordSendMessageDelivery(ctx, receipts) {
  if (!Array.isArray(receipts) || !receipts.some(r => r && !r.deduped && String(r.text || '').trim())) return false;
  delivered.add(ctx);
  ctx.session.completion = {...ctx.session.completion, requiredTool: 'send_message', delivered: true};
  return true;
}
// 单发一张表情、一个字不说，也算回了 —— 本人七条里就有一条是这样（角色卡第〇节第8条）。
// 只放行 send_sticker：它是"发到当前聊天的一条回复"，贴表情/拍一拍/发图/跨会话仍不算。
export function recordStickerDelivery(ctx) {
  delivered.add(ctx);
  ctx.session.completion = {...ctx.session.completion, requiredTool: 'send_message', delivered: true};
}
export const hasSendMessageDelivery = ctx => delivered.has(ctx);
// 能否正常完结：已实际发出，或本次是插话（允许不说话）
export const deliverySatisfied = ctx => delivered.has(ctx) || optional.has(ctx);
export const DELIVERY_REQUIRED = '本次会话尚未通过 send_message（或 send_sticker 单发一张表情）向当前聊天实际发送成功，不能完结。贴表情、拍一拍、发图、跨会话发送和普通输出均不能替代。请用 send_message 回复当前请求；依据不足时如实说明，不编造结论。';
