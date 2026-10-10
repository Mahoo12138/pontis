import { ApiError } from './errors';
import type { Checker } from './validate';

const BASE_URL = '/api/v1';

/** Thin fetch wrapper for the Pontis REST API. */
export async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  options?: { check?: Checker<T> },
): Promise<T> {
  // No CSRF token is sent or needed here: the session cookie is SameSite=Lax
  // and the server rejects a state-changing cookie request whose Origin is not
  // the instance's own (docs/09 §8). Nothing on the server ever read an
  // X-CSRF-Token, and no page emitted the meta tag this code used to look for.
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

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
