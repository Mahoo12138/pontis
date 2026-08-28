import { ApiError } from './errors';

const BASE_URL = '/api/v1';

/** CSRF token source — read from meta tag set by the server, or cookie. */
function getCsrfToken(): string | undefined {
  const meta = document.querySelector('meta[name="csrf-token"]');
  if (meta) return meta.getAttribute('content') ?? undefined;
  return undefined;
}

/** Thin fetch wrapper for the Pontis REST API. */
export async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  options?: { csrf?: boolean },
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (options?.csrf !== false) {
    const csrf = getCsrfToken();
    if (csrf) headers['X-CSRF-Token'] = csrf;
  }

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    credentials: 'include',
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    try {
      const envelope = await res.json();
      const err = envelope?.error;
      throw new ApiError(
        res.status,
        err?.code ?? 'UNKNOWN',
        err?.message ?? res.statusText,
        err?.request_id ?? 'req_unknown',
        err?.details,
      );
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError(res.status, 'UNKNOWN', res.statusText, 'req_unknown');
    }
  }

  if (res.status === 204 || res.headers.get('content-length') === '0') {
    return undefined as T;
  }

  return res.json() as Promise<T>;
}

export const client = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
};
