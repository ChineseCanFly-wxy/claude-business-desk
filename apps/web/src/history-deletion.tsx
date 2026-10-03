import React, { useEffect, useRef, useState } from 'react';
import { LoaderCircle, Trash2 } from 'lucide-react';
import { api } from './api';

export type HistorySelection = { questionIds: string[] } | { conversationIds: string[] } | { all: true };
type Preview = { count: number; skipped: number; before: string; selection: HistorySelection };
export function useHistoryDeletion(onDeleted: () => void | Promise<void>) {
  const [preview, setPreview] = useState<Preview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const working = useRef(false);
  const confirmation = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (preview) { confirmation.current?.focus({ preventScroll: true }); confirmation.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
  }, [preview]);
  const prepare = async (selection: HistorySelection) => {
    if (working.current) return;
    working.current = true; setBusy(true); setError(''); setNotice(''); setPreview(undefined);
    try { setPreview({ ...await api<Omit<Preview, 'selection'>>('/history/delete/preview', selection), selection }); }
    catch (e) { setError(e instanceof Error ? e.message : '无法确认删除范围'); }
    finally { working.current = false; setBusy(false); }
  };
  const remove = async () => {
    if (!preview || working.current) return;
    working.current = true; setBusy(true); setError('');
    try {
      const result = await api<{ deleted: number }>('/history/delete', { selection: preview.selection, before: preview.before, expectedCount: preview.count });
      setPreview(undefined); setNotice(`已从你的记录中删除 ${result.deleted} 轮问答。`);
      await onDeleted();
    } catch (e) { setError(e instanceof Error ? e.message : '删除失败'); setPreview(undefined); }
    finally { working.current = false; setBusy(false); }
  };
  const panel = <div className="history-feedback" aria-live="polite">
    {error && <div className="error" role="alert">{error}</div>}
    {notice && <p className="success" role="status">{notice}</p>}
    {busy && <p className="muted"><LoaderCircle size={16} className="spin"/>正在处理记录…</p>}
    {preview && <div className="history-delete-confirm" ref={confirmation} tabIndex={-1} role="region" aria-label="确认删除记录">
      <p>{'all' in preview.selection ? '清空全部记录：' : '删除所选记录：'}将移除 <strong>{preview.count}</strong> 轮已结束的问答。{preview.skipped > 0 && `保留 ${preview.skipped} 轮正在处理或预览后发生变化的记录。`}</p>
      <p className="muted small">删除仅影响当前账号，其他账号的记录各自保留。继续追问时仍保留这段对话已发布的上下文。</p>
      <div className="form-actions"><button type="button" disabled={busy} onClick={() => setPreview(undefined)}>取消</button><button type="button" className="danger-button" disabled={busy || preview.count === 0} onClick={() => void remove()}><Trash2 size={16}/>确认删除 {preview.count} 轮问答</button></div>
    </div>}
  </div>;
  return { prepare, busy, locked: busy || !!preview, panel };
}
