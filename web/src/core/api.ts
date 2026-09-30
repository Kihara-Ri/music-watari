// /api/* 统一封装：断网预检、JSON 序列化、错误携带状态码（401 → 登录跳转）。

export class ApiError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

export async function api<T = unknown>(path: string, data?: unknown): Promise<T> {
  if (data !== undefined && !navigator.onLine) {
    throw new ApiError('网络已断开，输入仍保留，请联网后再保存');
  }
  const r = await fetch('/api/' + path, {
    method: data === undefined ? 'GET' : 'POST',
    headers: data === undefined ? {} : {'Content-Type': 'application/json'},
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  let x: { error?: string } | undefined;
  try { x = await r.json(); } catch { /* 非 JSON 响应按通用错误处理 */ }
  if (!r.ok) throw new ApiError(x?.error || '操作失败，请重试', r.status);
  return x as T;
}
