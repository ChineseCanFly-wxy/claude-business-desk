import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, LoaderCircle, MessageSquare, Plus, Send, LockKeyhole, Trash2 } from 'lucide-react';
import { api, ApiError, statusLabels, unfinished, type Conversation, type ConversationPage, type Page, type Project, type Question } from './api';
import { AnswerNotifications, answeredSnapshot } from './answer-notifications';
import { persistConversation, restoreConversation, validConversationId } from './conversation-selection';
import { useHistoryDeletion } from './history-deletion';
import { ConversationPreview, ConversationTimeline } from './conversation-presentation';

function storage() { try { return window.localStorage; } catch { return undefined; } }
const message = (e: unknown) => e instanceof Error ? e.message : '操作失败，请稍后重试。';
export function ConversationClient({ userId, projects, revision, refresh, Popup }: { userId: string; projects: Project[]; revision: number; refresh: () => void; Popup: React.ComponentType<{ title: string; close: () => void; children: React.ReactNode }> }) {
  const [selected, setSelected] = useState(() => restoreConversation(userId, window.location.search, storage()));
  const [conversation, setConversation] = useState<Conversation>();
  const [history, setHistory] = useState<ConversationPage>(); const [page, setPage] = useState(1);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [checkedTurns, setCheckedTurns] = useState<Set<string>>(new Set());
  const [projectId, setProjectId] = useState(''); const [question, setQuestion] = useState(''); const [following, setFollowing] = useState(false);
  const [active, setActive] = useState<Question[]>([]); const [checking, setChecking] = useState(true); const [loading, setLoading] = useState(true); const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState(''); const [historySyncError, setHistorySyncError] = useState(''); const [detailSyncError, setDetailSyncError] = useState(''); const [busy, setBusy] = useState(false); const submitting = useRef(false); const pageSize = useRef(0);
  const selectedId = useRef(selected); const loadedId = useRef<string | undefined>(undefined);
  const [announcements, setAnnouncements] = useState<Question[]>([]); const notifications = useRef<AnswerNotifications | null>(null);
  const choose = useCallback((id?: string) => {
    if (submitting.current) return;
    if (!id || id !== selectedId.current) { selectedId.current = id; loadedId.current = undefined; setSelected(id); setCheckedTurns(new Set()); setDetailLoading(!!id); setConversation(undefined); setFollowing(false); setQuestion(''); setError(''); setDetailSyncError(''); }
    persistConversation(userId, id, storage());
    const url = new URL(window.location.href); url.searchParams.delete('question');
    if (id) { url.searchParams.set('conversation', id); url.searchParams.delete('new'); } else { url.searchParams.delete('conversation'); url.searchParams.set('new', '1'); }
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  }, [userId]);
  const deletion = useHistoryDeletion(async () => {
    setChecked(new Set()); setCheckedTurns(new Set()); setPage(1); setHistory(undefined);
    const id = selectedId.current;
    try {
      if (id) {
        try {
          const data = await api<Conversation>(`/conversations/${encodeURIComponent(id)}`);
          if (selectedId.current === id) setConversation(data);
        } catch (e) {
          if (e instanceof ApiError && e.status === 404 && selectedId.current === id) choose();
          else throw e;
        }
      }
    } finally { refresh(); }
  });
  const toggle = (id: string) => setChecked(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  useEffect(() => { const pop = () => choose(restoreConversation(userId, window.location.search, storage())); window.addEventListener('popstate', pop); return () => window.removeEventListener('popstate', pop); }, [choose, userId]);
  useEffect(() => { if (!projects.some(p => p.id === projectId)) setProjectId(projects[0]?.id || ''); }, [projects, projectId]);
  useEffect(() => {
    let alive = true; setLoading(true);
    Promise.all([api<ConversationPage>(`/conversations?page=${page}`), ...['pending_question_review', 'queued', 'running', 'pending_answer_review'].map(s => api<Page>(`/questions?status=${s}&page=1`))]).then(([data, ...pending]) => {
      if (!alive) return; if (page === 1) pageSize.current = data.items.length; if (!data.items.length && page > 1) { setPage(Math.max(1, Math.ceil(data.total / 30))); return; }
      setHistory(data); setChecked(current => new Set([...current].filter(id => data.items.some(c => c.id === id && !unfinished(c))))); setActive(pending.flatMap(p => p.items)); setChecking(false); setHistorySyncError('');
    }).catch(e => { if (alive) { setChecking(true); setHistorySyncError(message(e)); } }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [page, revision]);
  useEffect(() => {
    if (!selected) { setDetailLoading(false); return; } let alive = true; const initial = loadedId.current !== selected; if (initial) setDetailLoading(true);
    api<Conversation>(`/conversations/${encodeURIComponent(selected)}`).then(data => { if (alive) { loadedId.current = data.id; setConversation(data); persistConversation(userId, data.id, storage()); setDetailSyncError(''); } }).catch(e => { if (alive) { if (e instanceof ApiError && e.status === 404) { choose(); return; } if (initial) setConversation(undefined); setDetailSyncError(message(e)); } }).finally(() => { if (alive) setDetailLoading(false); });
    return () => { alive = false; };
  }, [selected, revision, userId, choose]);
  useEffect(() => { const id = new URLSearchParams(window.location.search).get('question'); if (!validConversationId(id)) return; let alive = true; api<Question>(`/questions/${id}`).then(q => { if (alive && validConversationId(q.conversationId)) choose(q.conversationId); }).catch(e => { if (alive) setError(message(e)); }); return () => { alive = false; }; }, [choose]);
  useEffect(() => {
    if (!notifications.current) notifications.current = new AnswerNotifications(userId, storage()); let alive = true;
    answeredSnapshot(path => api<Page>(path)).then(items => { if (alive) { const fresh = notifications.current!.consume(items); setAnnouncements(queue => [...queue.filter(q => items.some(item => item.id === q.id)), ...fresh]); } }).catch(() => {});
    return () => { alive = false; };
  }, [revision, userId]);
  useEffect(() => { setCheckedTurns(current => new Set([...current].filter(id => conversation?.questions.some(q => q.id === id && !unfinished(q))))); }, [conversation]);
  const toggleTurn = (id: string) => setCheckedTurns(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const eligibleTurns = (conversation?.questions ?? []).filter(q => !unfinished(q));
  const announcement = announcements[0];
  const dismiss = useCallback(() => { if (announcement) notifications.current?.acknowledge(announcement); setAnnouncements(q => q.slice(1)); }, [announcement]);
  const locked = checking || active.length > 0 || busy || deletion.locked;
  const eligible = (history?.items ?? []).filter(c => !unfinished(c));
  const chosenProject = selected ? conversation?.projectId : projectId;
  const available = projects.some(p => p.id === chosenProject);
  const canFollow = !!conversation && !unfinished(conversation) && available && !detailLoading;
  return <div className="client-content">
    {announcement && !busy && <Popup title="你的问题已回复" close={dismiss}><section className="detail-section"><h3>你的问题</h3><div className="prose question-text">{announcement.question}</div></section><div className="form-actions"><button className="primary" onClick={() => { choose(announcement.conversationId); dismiss(); refresh(); }}>查看回复</button></div></Popup>}
    <div className="client-intro"><span className="eyebrow">A LITTLE CLARITY, A BIG DIFFERENCE</span><h1>让每一次追问，都接得上。</h1><p>在同一业务对话中继续追问，或开启不携带旧上下文的新问题。每轮均经过人工审核。</p></div>
    {error && <div className="error" role="alert">{error}</div>}
    {(historySyncError || detailSyncError) && <div className="error" role="alert"><div>{historySyncError && <p>{historySyncError}</p>}{detailSyncError && <p>{detailSyncError}</p>}</div><button type="button" onClick={refresh}>重试同步</button></div>}
    <div className="conversation-layout"><aside className="panel conversation-sidebar"><div className="panel-heading"><h2>我的问答记录</h2><button className="secondary" disabled={busy || deletion.locked} onClick={() => choose()}><Plus size={16}/>开启新问题</button></div><p className="muted conversation-note">共 {history?.total ?? '—'} 段对话 · 追问归在原问题下</p>
      <div className="history-toolbar"><label className="checkbox"><input type="checkbox" aria-label="全选本页可删除对话" checked={eligible.length > 0 && eligible.every(c => checked.has(c.id))} disabled={loading || busy || deletion.locked || !eligible.length} onChange={e => setChecked(e.target.checked ? new Set(eligible.map(c => c.id)) : new Set())}/>全选本页</label><span className="muted">已选 {checked.size}</span><button disabled={loading || busy || deletion.locked || !checked.size} onClick={() => void deletion.prepare({ conversationIds: [...checked] })}>删除所选</button><button className="danger-button" disabled={loading || busy || deletion.locked || !history?.total} onClick={() => void deletion.prepare({ all: true })}>清空记录</button></div>
      <p className="muted small history-note">仅删除自己的记录；处理中问题会保留。</p>{deletion.panel}
      {loading && !history ? <p role="status">正在读取对话…</p> : history?.items.length ? <div className="conversation-list">{history.items.map(c => <div className="conversation-record" key={c.id}>
        <input type="checkbox" aria-label={`选择对话：${c.title}`} checked={checked.has(c.id)} disabled={busy || deletion.locked || unfinished(c)} onChange={() => toggle(c.id)}/>
        <button disabled={busy || deletion.locked} className={`conversation-row ${selected === c.id ? 'selected' : ''}`} onClick={() => choose(c.id)}><ConversationPreview conversation={c} compact/></button>
        <button className="icon-button danger-text" aria-label={`删除对话：${c.title}`} title={unfinished(c) ? '处理结束后可删除对话' : '删除这段对话的记录'} disabled={busy || deletion.locked || unfinished(c)} onClick={() => void deletion.prepare({ conversationIds: [c.id] })}><Trash2 size={16}/></button>
      </div>)}</div> : <div className="empty"><MessageSquare/><h3>尚无对话</h3><p>发送第一个问题后，对话才会创建。</p></div>}
      <div className="pagination"><span>第 {page} 页</span><button className="icon-button" aria-label="上一页对话" disabled={page === 1 || loading || busy || deletion.locked} onClick={() => { setHistory(undefined); setPage(p => p - 1); }}><ChevronLeft size={18}/></button><button className="icon-button" aria-label="下一页对话" disabled={loading || busy || deletion.locked || !history?.items.length || 30 * page >= history.total} onClick={() => { setHistory(undefined); setPage(p => p + 1); }}><ChevronRight size={18}/></button></div>
    </aside><section className="panel conversation-main"><div className="panel-heading"><div><h2>{selected ? conversation?.title || '读取对话' : '开启新问题'}</h2><p>{selected ? `${conversation?.projectName || '专属项目'} · ${conversation?.turnCount ?? '—'} 轮对话 · ${conversation?.followupCount ?? '—'} 次追问` : '新问题不带入其他对话的历史；发送前不会创建对话。'}</p></div></div>
      {conversation && <div className="history-toolbar"><label className="checkbox"><input type="checkbox" aria-label="全选此对话可删除轮次" checked={eligibleTurns.length > 0 && eligibleTurns.every(q => checkedTurns.has(q.id))} disabled={busy || deletion.locked || !eligibleTurns.length} onChange={e => setCheckedTurns(e.target.checked ? new Set(eligibleTurns.map(q => q.id)) : new Set())}/>全选已结束问答</label><span className="muted">已选 {checkedTurns.size} 轮</span><button disabled={busy || deletion.locked || !checkedTurns.size} onClick={() => void deletion.prepare({ questionIds: [...checkedTurns] })}><Trash2 size={16}/>删除所选问答</button></div>}
      {selected && !conversation && <div className="empty">{detailLoading ? <><LoaderCircle className="spin"/>正在读取对话…</> : <p>无法读取此对话，请重试或开启新问题。</p>}</div>}
      {conversation && <ConversationTimeline questions={conversation.questions} controls={q => <><label className="checkbox turn-checkbox"><input type="checkbox" aria-label={`选择第 ${q.turnIndex} 轮问答`} checked={checkedTurns.has(q.id)} disabled={busy || deletion.locked || unfinished(q)} onChange={() => toggleTurn(q.id)}/><span>选择</span></label><button className="icon-button danger-text" aria-label={`删除第 ${q.turnIndex} 轮问答`} title={unfinished(q) ? '处理结束后可删除' : '删除这轮问答'} disabled={busy || deletion.locked || unfinished(q)} onClick={() => void deletion.prepare({ questionIds: [q.id] })}><Trash2 size={16}/></button></>}/>}
      {selected && conversation && !following && <div className="followup-actions"><button className="primary" disabled={!canFollow || locked} onClick={() => setFollowing(true)}><MessageSquare size={17}/>继续追问</button><p className="muted">拒绝、失败或取消的最新轮结束后也可追问；这些轮次不会作为已发布答案带入上下文。</p></div>}
      {(!selected || following) && <form className="conversation-compose" onSubmit={async e => {
        e.preventDefault(); if (locked || submitting.current || !chosenProject || !available || (selected && (!canFollow || !following))) return;
        const text = question.trim(); if (text.length < 2 || text.length > 4000) { setError('问题须为 2–4,000 字符（不计首尾空白）。'); return; }
        submitting.current = true; setBusy(true); setError('');
        try { const result = await api<Question>('/questions', { projectId: chosenProject, question: text, ...(selected ? { conversationId: selected, latestTurnId: conversation!.latestTurnId } : {}) }); submitting.current = false; setChecking(true); setFollowing(false); setQuestion(''); choose(result.conversationId); refresh(); }
        catch (e) { setError(message(e)); refresh(); } finally { submitting.current = false; setBusy(false); }
      }}><label>{selected ? '固定业务项目' : '选择业务项目'}<select required value={chosenProject || ''} disabled={!!selected || locked} onChange={e => setProjectId(e.target.value)}><option value="" disabled>请选择项目</option>{projects.map(p => <option value={p.id} key={p.id}>{p.name}</option>)}</select></label><label>{selected ? '你的追问' : '你的问题'}<textarea aria-label={selected ? '你的追问' : '你的问题'} rows={5} required minLength={2} maxLength={4000} value={question} disabled={locked || detailLoading} onChange={e => setQuestion(e.target.value)} placeholder="描述具体业务场景、目标和希望解决的问题。请勿提交密码或敏感凭据。"/></label><div className="compose-bottom"><span>{question.length} / 4,000 · 至少 2 字符</span><button className="primary" disabled={locked || detailLoading || !available || question.trim().length < 2 || (!!selected && !canFollow)}>{busy ? <LoaderCircle className="spin" size={17}/> : <Send size={17}/>} {selected ? '提交追问' : '提交新问题'}</button></div><p className="muted small">上下文过长时请开启新问题；系统不会静默截断历史。附加业务指令以执行时已保存配置为准。</p></form>}
      {locked && <div className="info-note"><LockKeyhole size={17}/>{checking ? '正在确认所有对话的处理状态，暂时无法提交。' : '你仍有未完成的问题，所有对话暂时禁提交。开启新问题仅切换空白视图，不取消处理。'}</div>}
      {active.map(q => <button key={q.id} className="text-button active-conversation" disabled={busy} onClick={() => choose(q.conversationId)}>查看正在处理的第 {q.turnIndex} 轮 · {statusLabels[q.status]}</button>)}
      {!projects.length && <p className="info-note">尚未分配可用项目，请联系管理员。</p>}
    </section></div>
  </div>;
}
