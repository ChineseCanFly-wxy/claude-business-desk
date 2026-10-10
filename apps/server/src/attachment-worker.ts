import { parentPort, workerData } from 'node:worker_threads';
import { extname } from 'node:path';
import { unzipSync, zipSync } from 'fflate';
import mammoth from 'mammoth';
import { imageSize } from 'image-size';
import { PDFDocument } from 'pdf-lib';

export type PreparedAttachment = { mime: string; previewText?: string; html?: string; pageCount?: number; images?: { name: string; mime: string; base64: string }[]; pdfParts?: { name: string; pageCount: number; base64: string }[] };
const imageMimes: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
function checkedImage(data: Buffer, expected?: string) {
  const info = imageSize(data);
  const mime = info.type && imageMimes[info.type];
  if (!mime || (expected && mime !== expected) || !info.width || !info.height) throw new Error('图片格式与文件内容不符，请上传 PNG、JPG 或 WebP');
  if (info.width > 8192 || info.height > 8192 || info.width * info.height > 32_000_000) throw new Error('图片分辨率过大，请缩小图片后上传');
  return mime;
}
export async function prepareFile(name: string, data: Buffer): Promise<PreparedAttachment> {
  const extension = extname(name).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.webp'].includes(extension)) {
    const expected = extension === '.png' ? 'image/png' : extension === '.webp' ? 'image/webp' : 'image/jpeg';
    return { mime: checkedImage(data, expected) };
  }
  if (extension === '.pdf') {
    if (!data.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new Error('PDF 文件内容无效');
    let document: PDFDocument;
    try { document = await PDFDocument.load(data, { updateMetadata: false }); }
    catch { throw new Error('PDF 损坏或已加密，请上传未加密的 PDF'); }
    const pageCount = document.getPageCount();
    if (pageCount < 1 || pageCount > 20) throw new Error('PDF 最多支持 20 页，请拆分后上传');
    const pdfParts: NonNullable<PreparedAttachment['pdfParts']> = [];
    if (pageCount > 10) for (let start = 0; start < pageCount; start += 10) {
      const part = await PDFDocument.create();
      const count = Math.min(10, pageCount - start);
      for (const page of await part.copyPages(document, Array.from({ length: count }, (_, i) => start + i))) part.addPage(page);
      pdfParts.push({ name: `pages-${start + 1}-${start + count}.pdf`, pageCount: count, base64: Buffer.from(await part.save()).toString('base64') });
    }
    return { mime: 'application/pdf', pageCount, ...(pdfParts.length ? { pdfParts } : {}) };
  }
  if (extension !== '.docx') throw new Error('支持 PNG、JPG、WebP、DOCX 和 PDF；旧版 DOC 请另存为 DOCX');
  let expandedSize = 0, entries = 0;
  const names = new Set<string>();
  // Validate every ZIP entry before Mammoth can decompress it. Repack a bounded,
  // validated archive so duplicate/path entries cannot reach the DOCX converter.
  unzipSync(data, { filter: file => {
    expandedSize += file.originalSize; entries++;
    if (entries > 1000 || expandedSize > 32 * 1024 * 1024 || file.originalSize > 16 * 1024 * 1024) throw new Error('Word 文档解压后过大，请简化或导出为 PDF');
    if (file.name.includes('\\') || names.has(file.name) || /(^|[\/])\.\.([\/]|$)|^[\/]|^[A-Za-z]:|\x00/.test(file.name)) throw new Error('Word 文档结构无效');
    if (/vbaProject|word\/embeddings\//i.test(file.name)) throw new Error('Word 含宏或嵌入文件，请导出为 PDF 后上传');
    names.add(file.name); return false;
  } });
  if (!names.has('word/document.xml') || !names.has('[Content_Types].xml')) throw new Error('文件不是有效的 DOCX 文档');
  const files = unzipSync(data);
  if (Object.values(files).reduce((sum, file) => sum + file.length, 0) > 32 * 1024 * 1024) throw new Error('Word 文档解压后过大');
  const canonical = Buffer.from(zipSync(files, { level: 0 }));
  const images: NonNullable<PreparedAttachment['images']> = [];
  const converted = await mammoth.convertToHtml({ buffer: canonical }, {
    externalFileAccess: false,
    convertImage: mammoth.images.imgElement(async image => {
      const imageData = await image.readAsBuffer();
      if (imageData.length > 10 * 1024 * 1024 || images.length >= 10) throw new Error('Word 内嵌图片过多或过大，请导出为 PDF');
      const mime = checkedImage(imageData);
      const name = `image-${images.length + 1}.${mime === 'image/jpeg' ? 'jpg' : mime === 'image/png' ? 'png' : 'webp'}`;
      images.push({ name, mime, base64: imageData.toString('base64') });
      return { src: name };
    }),
  });
  const text = await mammoth.extractRawText({ buffer: canonical });
  if (!text.value.trim() && !images.length) throw new Error('Word 中没有可读取的文字或图片');
  if (converted.value.length > 100_000 || text.value.length > 80_000) throw new Error('Word 内容过长，请拆分后上传');
  return { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', html: converted.value, previewText: text.value, images };
}
if (parentPort) void prepareFile(workerData.name, Buffer.from(workerData.data)).then(
  result => parentPort!.postMessage({ result }),
  error => parentPort!.postMessage({ error: error instanceof Error ? error.message : '文件解析失败' }),
);
