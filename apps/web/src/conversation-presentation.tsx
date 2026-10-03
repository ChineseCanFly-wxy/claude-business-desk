import React from 'react';
import { ChevronRight, CornerDownRight, MessageSquare, MessagesSquare, Sparkles, Trash2 } from 'lucide-react';
import { statusLabels, unfinished, type ConversationSummary, type Question, type Status } from './api';

export const conversationDate = (value: string) => new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
export function ConversationStatus({ status }: { status: Status }) {
  return <span className={`badge ${status}`}><span className="status-dot"/>{statusLabels[status]}</span>;
}
export function ConversationPreview({ conversation: c, compact = false }: { conversation: ConversationSummary; compact?: boolean }) {
  const original = c.turnPreviews.find(q => q.turnIndex === c.titleTurnIndex);
  const followups = c.turnPreviews.filter(q => q.turnIndex > c.titleTurnIndex);
  return <div className={`conversation-preview ${compact ? 'compact' : ''}`}>
    <div className="conversation-preview-meta"><span><MessageSquare size={14}/>{c.projectName}{!compact && <> · {c.username}</>}</span><div className="conversation-summary-status"><span>最新状态</span><ConversationStatus status={c.status}/></div></div>
    <div className="conversation-preview-title"><div className="conversation-original-heading"><span className="conversation-origin">{c.titleTurnIndex === 1 ? '原问题' : `第 ${c.titleTurnIndex - 1} 次追问`}</span>{original && <ConversationStatus status={original.status}/>}</div><strong>{c.title}</strong></div>
    {followups.length > 0 && <div className="conversation-followups" aria-label="追问及各轮状态">{followups.map(q => <div className="conversation-latest" key={q.id}><CornerDownRight size={16}/><div className="conversation-followup-body"><div className="conversation-followup-heading"><span>第 {q.turnIndex - 1} 次追问{q.turnIndex === c.latestVisibleTurnIndex ? ' · 最近' : ''}</span><ConversationStatus status={q.status}/></div><p>{q.question}</p></div></div>)}</div>}
    <div className="conversation-preview-footer"><span className={`conversation-count ${c.followupCount ? 'has-followups' : ''}`}><MessagesSquare size={14}/>{c.turnCount} 轮对话{c.followupCount > 0 && <> · {c.followupCount} 次追问</>}</span><time dateTime={c.updatedAt}>{conversationDate(c.updatedAt)}</time></div>
  </div>;
}
type ConversationCardControls = { selected: Set<string>; toggle: (id: string) => void; remove: (id: string) => void; disabled: boolean };
export function ConversationCards({ conversations, select, controls }: { conversations: ConversationSummary[]; select: (id: string) => void; controls?: ConversationCardControls }) {
  return <div className="conversation-history-list">{conversations.map(c => <div className={`conversation-history-card ${controls?.selected.has(c.id) ? 'checked' : ''}`} key={c.id}>
    {controls && <input type="checkbox" aria-label={`选择对话：${c.title}`} checked={controls.selected.has(c.id)} disabled={controls.disabled || unfinished(c)} onChange={() => controls.toggle(c.id)}/>}
    <button className="conversation-history-open" aria-label={`打开对话：${c.title}`} disabled={controls?.disabled} onClick={() => select(c.id)}><ConversationPreview conversation={c}/><ChevronRight className="conversation-open-arrow" size={19}/></button>
    {controls && <button className="icon-button danger-text" aria-label={`删除对话：${c.title}`} title={unfinished(c) ? '处理结束后可删除' : '删除这段对话的记录'} disabled={controls.disabled || unfinished(c)} onClick={() => controls.remove(c.id)}><Trash2 size={17}/></button>}
  </div>)}</div>;
}
export function ConversationTimeline({ questions, admin = false, controls }: { questions: Question[]; admin?: boolean; controls?: (question: Question) => React.ReactNode }) {
  return <div className="conversation-timeline" aria-label="完整对话历史">{questions.map((q, index) => {
    const previousIndex = index ? questions[index - 1].turnIndex : 0;
    const missing = q.turnIndex - previousIndex - 1;
    return <React.Fragment key={q.id}>
      {missing > 0 && <p className="conversation-gap">{index ? '中间' : '此前'} {missing} 轮已从你的记录中删除</p>}
      <article className={`dialogue-turn ${q.turnIndex === 1 ? 'original-turn' : 'followup-turn'}`}>
        <div className="dialogue-marker" aria-hidden="true">{q.turnIndex === 1 ? <MessageSquare size={17}/> : <CornerDownRight size={17}/>}</div>
        <div className="dialogue-content"><div className="dialogue-heading"><div><div className="dialogue-title"><h3>{q.turnIndex === 1 ? '首次提问' : `第 ${q.turnIndex - 1} 次追问`}</h3><ConversationStatus status={q.status}/></div><span>第 {q.turnIndex} 轮 · {conversationDate(q.createdAt)}{q.archived && ' · 已归档'}</span></div><div className="dialogue-controls">{controls?.(q)}</div></div>
          {q.turnIndex > 1 && <p className="dialogue-connection"><CornerDownRight size={13}/>接着这段对话继续提问</p>}
          <div className="dialogue-question"><span className="dialogue-label">{admin ? q.username : '你'}的{q.turnIndex === 1 ? '问题' : '追问'}</span><div className="prose">{q.question}</div></div>
          {q.status === 'answered' && q.answer ? <div className="dialogue-answer"><span className="dialogue-label"><Sparkles size={14}/>正式答复</span><div className="prose answer-text">{q.answer}</div></div> : admin && q.status === 'pending_answer_review' && q.draftAnswer ? <div className="dialogue-draft"><span className="dialogue-label">待审核草稿 · 尚未发布</span><div className="prose">{q.draftAnswer}</div></div> : <p className="dialogue-pending">{q.status === 'rejected' ? '此轮未通过审核。' : q.status === 'failed' ? '此轮处理失败。' : q.status === 'cancelled' ? '此轮已取消。' : '本轮尚无已发布答案，处理进度将自动更新。'}{q.error && <span> {q.error}</span>}</p>}
        </div>
      </article>
    </React.Fragment>;
  })}<div className="dialogue-end"><span/>以上为这段对话的全部可见记录</div></div>;
}
