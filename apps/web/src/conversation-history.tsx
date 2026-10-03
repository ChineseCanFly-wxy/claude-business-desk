import React, { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, LoaderCircle, MessagesSquare, Trash2 } from 'lucide-react';
import { api, ApiError, statusLabels, unfinished, type Conversation, type ConversationPage, type Question } from './api';
import { ConversationCards, ConversationStatus, ConversationTimeline } from './conversation-presentation';
import { useHistoryDeletion } from './history-deletion';

const message = (error: unknown) => error instanceof Error ? error.message : '无法读取记录，请稍后重试。';
export function ConversationHistory({ revision, refresh, renderQuestionDetail, initialConversationId }: { initialConversationId?: string; revision: number; refresh: () => void; renderQuestionDetail: (id: string, close: () => void) => React.ReactNode }) {
  const [status, setStatus] = useState(''); const [page, setPage] = useState(1);
  const [data, setData] = useState<ConversationPage>(); const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | undefined>(initialConversationId); const [conversation, setConversation] = useState<Conversation>();
  const [turnDetail, setTurnDetail] = useState<string>(); const [detailLoading, setDetailLoading] = useState(!!initialConversationId);
  const [checked, setChecked] = useState<Set<string>>(new Set()); const [checkedTurns, setCheckedTurns] = useState<Set<string>>(new Set());
  const [listError, setListError] = useState(''); const [detailError, setDetailError] = useState('');
  const closeTurn = useCallback(() => setTurnDetail(undefined), []);
  const choose = (id?: string) => { setSelected(id); setConversation(undefined); setTurnDetail(undefined); setCheckedTurns(new Set()); setDetailError(''); setDetailLoading(!!id); };
  const deletion = useHistoryDeletion(async () => {
    setChecked(new Set()); setCheckedTurns(new Set()); setTurnDetail(undefined);
    try {
      if (selected) {
        try { setConversation(await api<Conversation>(`/conversations/${selected}`)); }
        catch (e) { if (e instanceof ApiError && e.status === 404) choose(); else throw e; }
      }
    } finally { refresh(); }
  });
  useEffect(() => {
    let alive = true; setLoading(true);
    api<ConversationPage>(`/conversations?page=${page}&status=${encodeURIComponent(status)}`).then(result => {
      if (!alive) return;
      if (!result.items.length && page > 1) { setPage(Math.max(1, Math.ceil(result.total / 30))); return; }
      setData(result); setListError(''); setChecked(current => new Set([...current].filter(id => result.items.some(c => c.id === id && !unfinished(c)))));
    }).catch(e => { if (alive) setListError(message(e)); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [page, status, revision]);
  useEffect(() => {
    if (!selected) return; let alive = true;
    api<Conversation>(`/conversations/${selected}`).then(result => { if (alive) { setConversation(result); setDetailError(''); } }).catch(e => {
      if (!alive) return;
      if (e instanceof ApiError && e.status === 404) { choose(); return; }
      setDetailError(message(e));
    }).finally(() => { if (alive) setDetailLoading(false); });
    return () => { alive = false; };
  }, [selected, revision]);
  useEffect(() => { setCheckedTurns(current => new Set([...current].filter(id => conversation?.questions.some(q => q.id === id && !unfinished(q))))); }, [conversation]);
  const toggle = (id: string, turns = false) => (turns ? setCheckedTurns : setChecked)(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const eligible = (data?.items ?? []).filter(c => !unfinished(c));
  const eligibleTurns = (conversation?.questions ?? []).filter(q => !unfinished(q));
  const turnControls = (q: Question) => <>
    <label className="checkbox turn-checkbox"><input type="checkbox" aria-label={`选择第 ${q.turnIndex} 轮问答`} checked={checkedTurns.has(q.id)} disabled={deletion.locked || unfinished(q)} onChange={() => toggle(q.id, true)}/><span>选择</span></label>
    <button className="text-button" onClick={() => setTurnDetail(q.id)} disabled={deletion.locked}>查看与处理</button>
    <button className="icon-button danger-text" aria-label={`删除第 ${q.turnIndex} 轮问答`} title={unfinished(q) ? '处理结束后可删除' : '删除这轮问答'} disabled={deletion.locked || unfinished(q)} onClick={() => void deletion.prepare({ questionIds: [q.id] })}><Trash2 size={16}/></button>
  </>;
  return <section className={`panel conversation-history-panel ${selected ? 'conversation-open' : ''}`}>
    {selected ? <>
      <div className="conversation-back"><button className="text-button" disabled={deletion.locked} onClick={() => choose()}><ChevronLeft size={17}/>返回对话记录</button><span className="muted">一个问题，一段完整对话</span></div>
      {conversation && <div className="conversation-detail-heading"><div><span className="eyebrow">{conversation.projectName} · {conversation.username}</span><h2>{conversation.title}</h2><p><MessagesSquare size={16}/>{conversation.turnCount} 轮对话 · {conversation.followupCount} 次追问 · 按提问顺序展示</p></div><ConversationStatus status={conversation.status}/></div>}
      <div className="history-toolbar"><label className="checkbox"><input type="checkbox" aria-label="全选此对话可删除轮次" checked={eligibleTurns.length > 0 && eligibleTurns.every(q => checkedTurns.has(q.id))} disabled={detailLoading || deletion.locked || !eligibleTurns.length} onChange={e => setCheckedTurns(e.target.checked ? new Set(eligibleTurns.map(q => q.id)) : new Set())}/>全选已结束问答</label><span className="muted">已选 {checkedTurns.size} 轮</span><button disabled={deletion.locked || !checkedTurns.size} onClick={() => void deletion.prepare({ questionIds: [...checkedTurns] })}><Trash2 size={16}/>删除所选问答</button><button className="danger-button" disabled={!conversation || deletion.locked || unfinished(conversation)} onClick={() => void deletion.prepare({ conversationIds: [selected] })}>删除整段对话</button></div>
    </> : <>
      <div className="filterbar conversation-history-filter"><div><h2>全部对话</h2><p>原问题和后续追问合并在同一条记录中</p></div><label className="inline-label">最新状态<select value={status} disabled={deletion.locked} onChange={e => { setStatus(e.target.value); setPage(1); setData(undefined); setChecked(new Set()); }}><option value="">全部状态</option>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
      <div className="history-toolbar"><label className="checkbox"><input type="checkbox" aria-label="全选本页可删除对话" disabled={loading || deletion.locked || !eligible.length} checked={eligible.length > 0 && eligible.every(c => checked.has(c.id))} onChange={e => setChecked(e.target.checked ? new Set(eligible.map(c => c.id)) : new Set())}/>全选本页</label><span className="muted">已选 {checked.size} 段 · 共 {data?.total ?? '—'} 段对话</span><button disabled={loading || deletion.locked || !checked.size} onClick={() => void deletion.prepare({ conversationIds: [...checked] })}><Trash2 size={16}/>删除所选</button><button className="danger-button" disabled={loading || deletion.locked || !data?.total} onClick={() => void deletion.prepare({ all: true })}>清空记录</button></div>
      <p className="muted small history-note">仅影响当前账号的记录；正在处理的问答会保留。</p>
    </>}
    {deletion.panel}
    {(selected ? detailError : listError) && <div className="history-load-error error" role="alert">{selected ? detailError : listError}<button onClick={refresh}>重试</button></div>}
    {selected ? <>
      {detailLoading && !conversation && <div className="empty" role="status"><LoaderCircle className="spin"/>正在读取完整对话…</div>}
      {turnDetail && <div className="conversation-turn-detail">{renderQuestionDetail(turnDetail, closeTurn)}</div>}
      {conversation && <ConversationTimeline questions={conversation.questions} admin controls={turnControls}/>}
    </> : <>
      {loading && !data ? <div className="empty" role="status"><LoaderCircle className="spin"/>正在读取对话记录…</div> : data?.items.length ? <ConversationCards conversations={data.items} select={choose} controls={{ selected: checked, toggle, disabled: deletion.locked, remove: id => void deletion.prepare({ conversationIds: [id] }) }}/> : <div className="empty"><MessagesSquare size={34}/><h3>{status ? '没有符合状态的对话' : '还没有对话记录'}</h3><p>一个原问题及其追问，会一起显示在这里。</p></div>}
      <div className="pagination"><span>第 {page} 页 · 共 {data?.total ?? '—'} 段对话{loading && <LoaderCircle className="spin" size={14}/>}</span><button className="icon-button" aria-label="上一页对话" disabled={page === 1 || loading || deletion.locked} onClick={() => { setData(undefined); setPage(p => p - 1); }}><ChevronLeft size={18}/></button><button className="icon-button" aria-label="下一页对话" disabled={loading || deletion.locked || !data?.items.length || page * 30 >= data.total} onClick={() => { setData(undefined); setPage(p => p + 1); }}><ChevronRight size={18}/></button></div>
    </>}
  </section>;
}
