import React, { useEffect, useRef, useState } from 'react';
import { Maximize2, X } from 'lucide-react';

export function AnswerEditor({ value, onChange, rows }: { value: string; onChange: (value: string) => void; rows: number }) {
  const [expanded, setExpanded] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (expanded) dialog.current?.showModal(); }, [expanded]);
  return <div className="answer-editor">
    <div className="answer-editor-tools"><span className="muted small">双击答案可放大编辑</span><button type="button" className="text-button" onClick={() => setExpanded(true)}><Maximize2 size={15}/>放大查看</button></div>
    <textarea aria-label="Claude 返回答案，可编辑" maxLength={20000} rows={rows} value={value} onChange={e => onChange(e.target.value)} onDoubleClick={() => setExpanded(true)}/>
    <dialog ref={dialog} className="answer-editor-dialog" aria-labelledby="expanded-answer-title" onClose={() => setExpanded(false)} onKeyDown={e => e.stopPropagation()}>
      <div className="answer-editor-heading"><h2 id="expanded-answer-title">Claude 返回答案</h2><button type="button" className="icon-button" aria-label="收起答案" onClick={() => dialog.current?.close()}><X size={20}/></button></div>
      <textarea aria-label="放大的 Claude 返回答案，可编辑" autoFocus maxLength={20000} value={value} onChange={e => onChange(e.target.value)}/>
      <div className="answer-editor-footer"><span className="muted small">修改会同步保留，收起后继续审核。</span><button type="button" className="secondary" onClick={() => dialog.current?.close()}>收起答案</button></div>
    </dialog>
  </div>;
}
