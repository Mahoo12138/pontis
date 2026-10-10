import { ApiError } from './errors';
import type { Checker } from './validate';

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
  options?: { csrf?: boolean; check?: Checker<T> },
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

  const json = (await res.json()) as unknown;
  // A declared checker is the difference between "the compiler was told" and
  // "the server sent it": it throws a ContractViolation naming the field,
  // which surfaces as a failed query instead of a blank list downstream.
  return options?.check ? options.check(json, 'body') : (json as T);
}

export const client = {
  get: <T>(path: string, check?: Checker<T>) => request<T>('GET', path, undefined, { check }),
  post: <T>(path: string, body?: unknown, check?: Checker<T>) =>
    request<T>('POST', path, body, { check }),
  put: <T>(path: string, body?: unknown, check?: Checker<T>) =>
    request<T>('PUT', path, body, { check }),
  patch: <T>(path: string, body?: unknown, check?: Checker<T>) =>
    request<T>('PATCH', path, body, { check }),
  delete: <T>(path: string, check?: Checker<T>) =>
    request<T>('DELETE', path, undefined, { check }),
};
