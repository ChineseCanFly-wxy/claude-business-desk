import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, LoaderCircle, MessageSquare, Plus, Send, LockKeyhole } from 'lucide-react';
import { api, statusLabels, unfinished, type Conversation, type ConversationPage, type Page, type Project, type Question } from './api';
import { AnswerNotifications, answeredSnapshot } from './answer-notifications';
import { persistConversation, restoreConversation, validConversationId } from './conversation-selection';

function storage() { try { return window.localStorage; } catch { return undefined; } }
const message = (e: unknown) => e instanceof Error ? e.message : '操作失败，请稍后重试。';
const date = (s?: string) => s ? new Date(s).toLocaleString('zh-CN') : '';
export function ConversationClient({ userId, projects, revision, refresh, Popup }: { userId: string; projects: Project[]; revision: number; refresh: () => void; Popup: React.ComponentType<{ title: string; close: () => void; children: React.ReactNode }> }) {
  const [selected, setSelected] = useState(() => restoreConversation(userId, window.location.search, storage()));
  const [conversation, setConversation] = useState<Conversation>();
  const [history, setHistory] = useState<ConversationPage>(); const [page, setPage] = useState(1);
  const [projectId, setProjectId] = useState(''); const [question, setQuestion] = useState(''); const [following, setFollowing] = useState(false);
  const [active, setActive] = useState<Question[]>([]); const [checking, setChecking] = useState(true); const [loading, setLoading] = useState(true); const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState(''); const [historySyncError, setHistorySyncError] = useState(''); const [detailSyncError, setDetailSyncError] = useState(''); const [busy, setBusy] = useState(false); const submitting = useRef(false); const pageSize = useRef(0);
  const selectedId = useRef(selected); const loadedId = useRef<string | undefined>(undefined);
  const [announcements, setAnnouncements] = useState<Question[]>([]); const notifications = useRef<AnswerNotifications | null>(null);
  const choose = useCallback((id?: string) => {
    if (submitting.current) return;
    if (!id || id !== selectedId.current) { selectedId.current = id; loadedId.current = undefined; setSelected(id); setDetailLoading(!!id); setConversation(undefined); setFollowing(false); setQuestion(''); setError(''); setDetailSyncError(''); }
    persistConversation(userId, id, storage());
    const url = new URL(window.location.href); url.searchParams.delete('question');
    if (id) { url.searchParams.set('conversation', id); url.searchParams.delete('new'); } else { url.searchParams.delete('conversation'); url.searchParams.set('new', '1'); }
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  }, [userId]);
  useEffect(() => { const pop = () => choose(restoreConversation(userId, window.location.search, storage())); window.addEventListener('popstate', pop); return () => window.removeEventListener('popstate', pop); }, [choose, userId]);
  useEffect(() => { if (!projects.some(p => p.id === projectId)) setProjectId(projects[0]?.id || ''); }, [projects, projectId]);
  useEffect(() => {
    let alive = true; setLoading(true);
    Promise.all([api<ConversationPage>(`/conversations?page=${page}`), ...['pending_question_review', 'queued', 'running', 'pending_answer_review'].map(s => api<Page>(`/questions?status=${s}&page=1`))]).then(([data, ...pending]) => {
      if (!alive) return; if (page === 1) pageSize.current = data.items.length; setHistory(data); setActive(pending.flatMap(p => p.items)); setChecking(false); setHistorySyncError('');
    }).catch(e => { if (alive) { setChecking(true); setHistorySyncError(message(e)); } }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [page, revision]);
  useEffect(() => {
    if (!selected) { setDetailLoading(false); return; } let alive = true; const initial = loadedId.current !== selected; if (initial) setDetailLoading(true);
    api<Conversation>(`/conversations/${encodeURIComponent(selected)}`).then(data => { if (alive) { loadedId.current = data.id; setConversation(data); persistConversation(userId, data.id, storage()); setDetailSyncError(''); } }).catch(e => { if (alive) { if (initial) setConversation(undefined); setDetailSyncError(message(e)); } }).finally(() => { if (alive) setDetailLoading(false); });
    return () => { alive = false; };
  }, [selected, revision, userId]);
  useEffect(() => { const id = new URLSearchParams(window.location.search).get('question'); if (!validConversationId(id)) return; let alive = true; api<Question>(`/questions/${id}`).then(q => { if (alive && validConversationId(q.conversationId)) choose(q.conversationId); }).catch(e => { if (alive) setError(message(e)); }); return () => { alive = false; }; }, [choose]);
  useEffect(() => {
    if (!notifications.current) notifications.current = new AnswerNotifications(userId, storage()); let alive = true;
    answeredSnapshot(path => api<Page>(path)).then(items => { if (alive) { const fresh = notifications.current!.consume(items); if (fresh.length) setAnnouncements(queue => [...queue, ...fresh]); } }).catch(() => {});
    return () => { alive = false; };
  }, [revision, userId]);
  const announcement = announcements[0];
  const dismiss = useCallback(() => { if (announcement) notifications.current?.acknowledge(announcement); setAnnouncements(q => q.slice(1)); }, [announcement]);
  const latest = conversation?.questions.find(q => q.id === conversation.latestTurnId);
  const locked = checking || active.length > 0 || busy;
  const chosenProject = selected ? conversation?.projectId : projectId;
  const available = projects.some(p => p.id === chosenProject);
  const canFollow = !!latest && !unfinished(latest) && available && !detailLoading;
  return <div className="client-content">
    {announcement && !busy && <Popup title="你的问题已回复" close={dismiss}><section className="detail-section"><h3>你的问题</h3><div className="prose question-text">{announcement.question}</div></section><div className="form-actions"><button className="primary" onClick={() => { choose(announcement.conversationId); dismiss(); refresh(); }}>查看回复</button></div></Popup>}
    <div className="client-intro"><span className="eyebrow">A LITTLE CLARITY, A BIG DIFFERENCE</span><h1>让每一次追问，都接得上。</h1><p>在同一业务对话中继续追问，或开启不携带旧上下文的新问题。每轮均经过人工审核。</p></div>
    {error && <div className="error" role="alert">{error}</div>}
    {(historySyncError || detailSyncError) && <div className="error" role="alert"><div>{historySyncError && <p>{historySyncError}</p>}{detailSyncError && <p>{detailSyncError}</p>}</div><button type="button" onClick={refresh}>重试同步</button></div>}
    <div className="conversation-layout"><aside className="panel conversation-sidebar"><div className="panel-heading"><h2>我的对话</h2><button className="secondary" disabled={busy} onClick={() => choose()}><Plus size={16}/>开启新问题</button></div><p className="muted conversation-note">共 {history?.total ?? '—'} 个对话</p>
      {loading && !history ? <p role="status">正在读取对话…</p> : history?.items.length ? <div className="conversation-list">{history.items.map(c => <button key={c.id} disabled={busy} className={`conversation-row ${selected === c.id ? 'selected' : ''}`} onClick={() => choose(c.id)}><strong>{c.title}</strong><span>{c.projectName} · {c.turnCount ?? '—'} 轮</span>{c.status && <span className={`badge ${c.status}`}>{statusLabels[c.status]}</span>}<small>{date(c.updatedAt)}</small></button>)}</div> : <div className="empty"><MessageSquare/><h3>尚无对话</h3><p>发送第一个问题后，对话才会创建。</p></div>}
      <div className="pagination"><span>第 {page} 页</span><button className="icon-button" aria-label="上一页对话" disabled={page === 1 || loading || busy} onClick={() => { setHistory(undefined); setPage(p => p - 1); }}><ChevronLeft size={18}/></button><button className="icon-button" aria-label="下一页对话" disabled={loading || busy || !history?.items.length || (pageSize.current || history.items.length) * page >= history.total} onClick={() => { setHistory(undefined); setPage(p => p + 1); }}><ChevronRight size={18}/></button></div>
    </aside><section className="panel conversation-main"><div className="panel-heading"><div><h2>{selected ? conversation?.title || '读取对话' : '开启新问题'}</h2><p>{selected ? `${conversation?.projectName || '专属项目'} · 项目固定，追问使用此前已发布问答` : '新问题不带入其他对话的历史；发送前不会创建对话。'}</p></div></div>
      {selected && !conversation && <div className="empty">{detailLoading ? <><LoaderCircle className="spin"/>正在读取对话…</> : <p>无法读取此对话，请重试或开启新问题。</p>}</div>}
      {conversation && <div className="chat-history" aria-label="完整对话历史">{conversation.questions.map(q => <article className="chat-round" key={q.id}><div className="chat-round-heading"><span>第 {q.turnIndex} 轮 · {date(q.createdAt)}{q.archived ? ' · 已归档' : ''}</span><span className={`badge ${q.status}`}>{statusLabels[q.status]}</span></div><h3>你的问题</h3><div className="prose chat-question">{q.question}</div>{q.status === 'answered' && q.answer ? <><h3>正式答案</h3><div className="prose answer-text">{q.answer}</div></> : <p className="info-note">{q.status === 'rejected' ? '此轮未通过审核。' : q.status === 'failed' ? '此轮处理失败。' : q.status === 'cancelled' ? '此轮已取消。' : '本轮尚无已发布答案，处理进度将自动更新。'}{q.error && <span> {q.error}</span>}</p>}</article>)}</div>}
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
