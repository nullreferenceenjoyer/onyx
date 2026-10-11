// crypto.randomUUID есть только в защищённом контексте, а приложение может открываться по http в локальной сети
export const clientId = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');

export class ApiError extends Error {
  constructor(public status: number, message: string, public data: any = null) { super(message); }
}

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn: () => void) => { onUnauthorized = fn; };

export async function api<T = any>(method: string, path: string, body?: unknown, opts: { keepalive?: boolean } = {}): Promise<T> {
  const form = body instanceof FormData;
  let res: Response;
  try {
    res = await fetch('/api' + path, {
      method,
      credentials: 'same-origin',
      keepalive: opts.keepalive,
      headers: { 'x-onyx': '1', 'x-client-id': clientId, 'x-tz-offset': String(-new Date().getTimezoneOffset()), ...(body !== undefined && !form ? { 'content-type': 'application/json' } : {}) },
      body: form ? (body as FormData) : body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'Нет связи с сервером');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/')) onUnauthorized();
    throw new ApiError(res.status, data?.error ?? `Ошибка ${res.status}`, data);
  }
  return data as T;
}

// на публичной странице файлы отдаются по токену ссылки, а не по сессии
let rawBase = (id: string) => `/api/nodes/${id}/raw`;
export const setRawBase = (fn: (id: string) => string) => { rawBase = fn; };
export const rawUrl = (id: string, version?: number) => `${rawBase(id)}${version ? `?v=${version}` : ''}`;
