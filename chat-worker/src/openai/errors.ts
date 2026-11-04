export type ErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'rate_limit_error'
  | 'server_error'
  | 'api_error';

export class GatewayError extends Error {
  readonly status: number;
  readonly code: string;
  readonly type: ErrorType;
  readonly param?: string;
  readonly headers?: Record<string, string>;

  constructor(
    status: number,
    code: string,
    message: string,
    type: ErrorType = 'invalid_request_error',
    param?: string,
    headers?: Record<string, string>
  ) {
    super(message);
    this.name = 'GatewayError';
    this.status = status;
    this.code = code;
    this.type = type;
    this.param = param;
    this.headers = headers;
  }
}

export const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
  'access-control-allow-headers': 'authorization,content-type,x-api-key',
  'access-control-max-age': '86400',
};

export function withCors(headers: Record<string, string> = {}): Record<string, string> {
  return { ...CORS_HEADERS, ...headers };
}

export function jsonResponse(
  body: unknown,
  status = 200,
  extra: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: withCors({
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extra,
    }),
  });
}

export function errorResponse(error: GatewayError, requestId?: string): Response {
  return jsonResponse(
    {
      error: {
        message: error.message,
        type: error.type,
        param: error.param ?? null,
        code: error.code,
      },
    },
    error.status,
    {
      ...(requestId ? { 'x-request-id': requestId } : {}),
      ...(error.headers ?? {}),
    }
  );
}

export function asGatewayError(error: unknown): GatewayError {
  if (error instanceof GatewayError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new GatewayError(502, 'upstream_error', message || 'upstream request failed', 'api_error');
}
