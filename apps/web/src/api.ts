export type User = { id: string; username: string; role: string; enabled?: boolean; projectIds?: string[] };
export type Project = { id: string; name: string; description: string; path?: string; enabled: boolean };
export type Status = 'pending_question_review' | 'queued' | 'running' | 'pending_answer_review' | 'answered' | 'rejected' | 'failed' | 'cancelled';
export type Question = { conversationId: string; turnIndex: number; parentQuestionId?: string | null; id: string; projectId: string; projectName: string; username: string; question: string; status: Status; answer?: string; draftAnswer?: string; error?: string; createdAt: string; updatedAt: string; archived: boolean };
export type ContextSnapshot = { formatVersion: 1; sourceIds: string[]; turns: { questionId: string; turnIndex: number; question: string; answer: string }[] };
export type ConversationTurnPreview = Pick<Question, 'id' | 'turnIndex' | 'question' | 'status'>;
export type ConversationSummary = { id: string; projectId: string; projectName: string; username: string; title: string; titleTurnIndex: number; latestQuestion: string; latestVisibleTurnIndex: number; followupCount: number; turnPreviews: ConversationTurnPreview[]; latestTurnId: string; createdAt: string; updatedAt: string; status: Status; turnCount: number; archived: boolean };
export type ConversationPage = { items: ConversationSummary[]; total: number; page: number };
export type Conversation = ConversationSummary & { questions: Question[] };
export type Detail = Question & { contextSnapshot?: ContextSnapshot };
export type Page = { items: Question[]; total: number; page: number };
export type Settings = { claudePath: string; mode: 'hidden' | 'visible'; timeoutSeconds: number; clientHost: string; clientPort: number; adminPort: number; allowInsecureLan: boolean; adminNotificationMode?: 'window' | 'notification'; fixedPrompt: string; extraPrompt: string; clientError?: string };
export type Stats = { pendingQuestions: number; pendingAnswers: number; running: number; total: number; queued: number };
let csrf = '';
export function setCsrf(token?: string) { csrf = token || ''; }
export class ApiError extends Error { constructor(message: string, public status: number) { super(message); } }
export async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, { credentials: 'include', method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'x-csrf-token': csrf }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  let data: unknown;
  try { data = text ? JSON.parse(text) : undefined; } catch { throw new ApiError(response.ok ? '服务器返回了无法解析的数据。' : `请求失败（${response.status}），请检查服务是否运行。`, response.status); }
  if (!response.ok) { if (response.status === 401 && path !== '/me' && path !== '/login') window.dispatchEvent(new Event('session-expired')); const error = data as { message?: string; error?: string } | undefined; throw new ApiError(error?.message || error?.error || `请求失败（${response.status}）`, response.status); }
  return data as T;
}
export const statusLabels: Record<Status, string> = { pending_question_review: '等待问题审核', queued: '排队中', running: '正在处理', pending_answer_review: '等待答案审核', answered: '已答复', rejected: '已拒绝', failed: '处理失败', cancelled: '已取消' };
export const unfinished = (q: Pick<Question, 'status'>) => ['pending_question_review', 'queued', 'running', 'pending_answer_review'].includes(q.status);
