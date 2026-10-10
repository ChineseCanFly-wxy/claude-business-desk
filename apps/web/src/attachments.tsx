import React, { useEffect, useRef, useState } from 'react';
import { Download, FileText, Image, LoaderCircle, Paperclip, X } from 'lucide-react';
import { api, uploadAttachment, type Attachment } from './api';
const size = (bytes: number) => bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
type Preview = Attachment & { text?: string };
export function AttachmentList({ files = [], title = '本轮附件', remove, disabled = false }: { files?: Attachment[]; title?: string; remove?: (id: string) => void; disabled?: boolean }) {
  const [selected, setSelected] = useState<Attachment>(); const [preview, setPreview] = useState<Preview>(); const [error, setError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (!selected) return;
    let alive = true; setPreview(undefined); setError(''); dialog.current?.showModal();
    api<Preview>(`/attachments/${selected.id}/preview`).then(data => { if (alive) setPreview(data); }).catch(e => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [selected]);
  if (!files.length) return null;
  const close = () => { dialog.current?.close(); setSelected(undefined); };
  return <section className="attachment-section"><h4>{title}</h4><ul className="attachment-list">{files.map(file => <li key={file.id}>
    <button type="button" className="attachment-open" onClick={() => setSelected(file)} aria-label={`预览附件：${file.name}`}>
      {file.mime.startsWith('image/') ? <Image size={19}/> : <FileText size={19}/>}<span><strong>{file.name}</strong><small>{size(file.size)}{file.pageCount ? ` · ${file.pageCount} 页` : ''}{file.imageCount ? ` · ${file.imageCount} 张内嵌图片` : ''} · {file.readByAi ? 'AI 已读取' : '待 AI 读取'}</small></span>
    </button>{remove && <button type="button" className="icon-button" disabled={disabled} aria-label={`移除附件：${file.name}`} onClick={() => remove(file.id)}><X size={17}/></button>}
  </li>)}</ul>{selected && <dialog ref={dialog} className="attachment-preview" onCancel={e => { e.stopPropagation(); setSelected(undefined); }} onKeyDown={e => { if (e.key === 'Escape') e.stopPropagation(); }}>
    <div className="attachment-preview-heading"><h3>{selected.name}</h3><button type="button" className="icon-button" aria-label="关闭附件预览" onClick={close}><X/></button></div>
    <div className="attachment-preview-content">{error ? <div role="alert" className="error">{error}</div> : !preview ? <p role="status"><LoaderCircle className="spin" size={18}/>正在加载附件…</p> : selected.mime.startsWith('image/') ? <img className="attachment-image" src={`/api/attachments/${selected.id}/file`} alt={selected.name}/> : selected.mime === 'application/pdf' ? <p>PDF 共 {preview.pageCount} 页。点击下方“打开或下载原文件”查看全部内容。</p> : <><p className="muted small">以下为 Word 文字与内嵌图片预览；AI 读取的文件同时保留表格结构。完整排版请下载原文件查看。</p><div className="prose">{preview.text}</div>{Array.from({ length: preview.imageCount || 0 }, (_, index) => <img className="attachment-image" key={index} src={`/api/attachments/${selected.id}/images/${index}`} alt={`${selected.name} 内嵌图片 ${index + 1}`}/>)}</>}</div>
    <div className="attachment-preview-footer"><a className="button secondary" href={`/api/attachments/${selected.id}/file`} target="_blank" rel="noreferrer"><Download size={16}/>打开或下载原文件</a><button type="button" className="primary" onClick={close}>关闭</button></div>
  </dialog>}</section>;
}
export function AttachmentUpload({ projectId, files, references = [], onChange, onBusy, disabled }: { projectId: string; files: Attachment[]; references?: Attachment[]; onChange: (files: Attachment[]) => void; onBusy: (busy: boolean) => void; disabled: boolean }) {
  const input = useRef<HTMLInputElement>(null); const uploading = useRef(false); const current = useRef(files); current.current = files;
  const mounted = useRef(true); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const upload = async (selected: FileList | null) => {
    if (!selected?.length || disabled || uploading.current || !projectId) return;
    const batch = [...selected]; if (input.current) input.current.value = '';
    if (current.current.length + batch.length > 5) { setError('每轮最多新增 5 个附件'); return; }
    if (current.current.length + references.length + batch.length > 10 || [...current.current, ...references, ...batch].reduce((total, file) => total + file.size, 0) > 20 * 1024 * 1024) { setError('本轮与此前引用的附件合计最多 10 个、20 MB，请开启新问题'); return; }
    if (batch.some(file => file.size > 10 * 1024 * 1024 || !file.size)) { setError('附件不能为空，单个文件最多 10 MB'); return; }
    if (batch.some(file => !/\.(png|jpe?g|webp|docx|pdf)$/i.test(file.name))) { setError('支持 PNG、JPG、WebP、DOCX 和 PDF；旧版 DOC 请另存为 DOCX'); return; }
    uploading.current = true; setBusy(true); onBusy(true); setError('');
    try {
      for (const file of batch) {
        const uploaded = await uploadAttachment(projectId, file);
        if (!mounted.current) { void api(`/attachments/${uploaded.id}/remove`, {}).catch(() => {}); break; }
        current.current = [...current.current, uploaded]; onChange(current.current);
      }
    } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : '附件上传失败'); }
    finally { uploading.current = false; if (mounted.current) { setBusy(false); onBusy(false); } }
  };
  const remove = async (id: string) => {
    if (disabled || uploading.current) return;
    uploading.current = true; setBusy(true); onBusy(true); setError('');
    try { await api(`/attachments/${id}/remove`, {}); current.current = current.current.filter(file => file.id !== id); onChange(current.current); }
    catch (e) { setError(e instanceof Error ? e.message : '移除失败'); }
    finally { uploading.current = false; if (mounted.current) { setBusy(false); onBusy(false); } }
  };
  return <div className="attachment-upload"><input ref={input} type="file" multiple accept=".png,.jpg,.jpeg,.webp,.docx,.pdf" aria-label="选择附件" hidden onChange={e => void upload(e.target.files)}/>
    <button className="secondary" type="button" disabled={disabled || busy || !projectId || files.length >= 5} onClick={() => input.current?.click()}>{busy ? <LoaderCircle size={16} className="spin"/> : <Paperclip size={16}/>} {busy ? '正在处理附件…' : '上传附件'}</button>
    <p className="muted small">图片、Word（DOCX）、PDF（最多 20 页） · 每轮新增最多 5 个 · 单文件 10 MB · 含历史引用合计 20 MB</p>
    {error && <div className="error" role="alert">{error}</div>}<AttachmentList files={files} title="待提交附件" remove={id => void remove(id)} disabled={disabled || busy}/>
  </div>;
}
