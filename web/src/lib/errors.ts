// Turning a query failure into something an operator can act on.
//
// The UI used to render every failure as 发生错误, which made a broken API
// contract look exactly like a typo'd route or a dead server. The REST layer now
// throws named errors (ApiError carries the server's code, ContractViolation
// names the field that did not match), so discarding them throws away the one
// thing that distinguishes "the app and the server disagree" from "the request
// did not arrive".

import { ApiError, ContractViolation } from '@pontis/api';

export function describeError(error: unknown): string | undefined {
  if (error instanceof ContractViolation) {
    // The message already names the path and what was expected, e.g.
    // `API contract violated at body.nodes[0].position: expected a number,
    // received "0"`. That is the operator-facing fact: this build and this
    // server do not agree.
    return error.message;
  }

  if (error instanceof ApiError) {
    // The server writes its own message; translating it here would invent text
    // the server never said. A 5xx only exists in the server log, so the
    // request id is the useful half.
    if (error.status >= 500) {
      return `[${error.code}] 服务端内部错误（请求号 ${error.requestId}，可在服务端日志中定位）`;
    }
    return `[${error.code}] ${error.message}`;
  }

  if (error instanceof Error && error.message) return error.message;
  return undefined;
}
