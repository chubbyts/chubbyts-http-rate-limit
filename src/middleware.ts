import { createTooManyRequests } from '@chubbyts/chubbyts-http-error/http-error';
import type { Response, ServerRequest, Uri } from '@chubbyts/chubbyts-http-types/message';
import type { ResponseHelpers } from '@chubbyts/chubbyts-http-types/message-helper';
import type { Handler } from '@chubbyts/chubbyts-http-types/handler';
import type { Middleware } from '@chubbyts/chubbyts-http-types/middleware';
import type { RateLimiterAbstract, RateLimiterRes } from 'rate-limiter-flexible';
import type { KeyResolver } from './key-resolver.js';

/**
 * The subset of a rate-limiter-flexible limiter (`RateLimiterMemory`, `RateLimiterRedis`, `RateLimiterMongo`, ...)
 * the middleware relies on.
 */
export type RateLimiter = Pick<RateLimiterAbstract, 'points' | 'consume'>;

export type RateLimitInfo = {
  /** the configured maximum of requests (points) per duration */
  limit: number;
  /** requests left within the current duration, 0 when exceeded */
  remaining: number;
  /** seconds until the current duration (or block) ends (rounded up), `undefined` if it never ends (`duration: 0`) */
  reset: number | undefined;
};

// rate-limiter-flexible reports -1 for a key that never expires (duration 0)
const toInfo = (limit: number, { remainingPoints, msBeforeNext }: RateLimiterRes): RateLimitInfo => ({
  limit,
  remaining: remainingPoints,
  reset: msBeforeNext < 0 ? undefined : Math.ceil(msBeforeNext / 1000),
});

const toRateLimitHeaders = ({ limit, remaining, reset }: RateLimitInfo): Record<string, string> => ({
  'ratelimit-limit': String(limit),
  'ratelimit-remaining': String(remaining),
  ...(reset !== undefined ? { 'ratelimit-reset': String(reset) } : {}),
});

// retry-after is only meaningful on a rejected response (rfc 9110) and a client should wait at least a second
const toRetryAfter = ({ reset }: RateLimitInfo): number | undefined =>
  reset === undefined ? undefined : Math.max(1, reset);

// with (not added) replaces existing rate limit headers (e.g. set by the handler), the reset gets removed upfront as
// there is none if the limit never resets, all other headers (e.g. multiple set-cookie) stay untouched
const withRateLimitHeaders = (responseHelpers: ResponseHelpers, response: Response, info: RateLimitInfo): Response =>
  Object.entries(toRateLimitHeaders(info)).reduce(
    (current, [name, value]) => responseHelpers.withHeader(current, name, value),
    responseHelpers.withoutHeader(response, 'ratelimit-reset'),
  );

const resolvePathnameSearch = (uri: Uri): string => (uri.query ? `${uri.path}?${uri.query}` : uri.path);

// duck typed instead of `instanceof RateLimiterRes`, so that a second copy of rate-limiter-flexible (version mismatch)
// still results in a 429 instead of a 500, but never an Error (which carries a stack) so that a real error with
// matching properties does not get swallowed into a 429
const isRateLimiterRes = (e: unknown): e is RateLimiterRes =>
  typeof e === 'object' &&
  e !== null &&
  !(e instanceof Error) &&
  typeof (e as RateLimiterRes).remainingPoints === 'number' &&
  typeof (e as RateLimiterRes).msBeforeNext === 'number' &&
  typeof (e as RateLimiterRes).consumedPoints === 'number';

const consume = async (rateLimiter: RateLimiter, key: string, request: ServerRequest): Promise<RateLimitInfo> => {
  const { points } = rateLimiter;

  try {
    return toInfo(points, await rateLimiter.consume(key));
  } catch (e) {
    // the limiter rejects with a RateLimiterRes when the limit is exceeded, anything else is a real error
    if (!isRateLimiterRes(e)) {
      throw e;
    }

    const info = toInfo(points, e);
    const { limit, remaining, reset } = info;
    const retryAfter = toRetryAfter(info);
    const pathnameSearch = resolvePathnameSearch(request.uri);

    // the error middleware turns it into the 429 response: `headers` are the ratelimit-* (and retry-after) headers
    // of that response (never part of the body), `reset` and `retryAfter` get skipped by the http error if `undefined`
    // (the limit never resets)
    throw createTooManyRequests({
      detail:
        reset === undefined
          ? `Limit of ${limit} requests reached for ${request.method} ${pathnameSearch}`
          : `Limit of ${limit} requests reached for ${request.method} ${pathnameSearch}, retry in ${reset} seconds`,
      instance: pathnameSearch,
      limit,
      remaining,
      reset,
      retryAfter,
      headers: {
        ...toRateLimitHeaders(info),
        ...(retryAfter !== undefined ? { 'retry-after': String(retryAfter) } : {}),
      },
    });
  }
};

/**
 * Consumes one point per request from the `rateLimiter` under the key of the `keyResolver`. Every response of the
 * handler carries the `ratelimit-limit`, `ratelimit-remaining` and `ratelimit-reset` headers (the reset one only if the
 * limit resets at all, see `RateLimitInfo`), set through the injected `responseHelpers`; an error thrown by the handler
 * passes through untouched (without them).
 *
 * Once the limiter rejects, a `TooManyRequests` http error of @chubbyts/chubbyts-http-error gets thrown (with the
 * `limit`, `remaining`, `reset` and `retryAfter` of the `RateLimitInfo` as data, and the `ratelimit-limit`,
 * `ratelimit-remaining`, `ratelimit-reset` and `retry-after` headers of the `429` response as `headers`), the error
 * middleware of the application turns it into the `429` response and should add the `headers` to it.
 *
 * A request without key (the `keyResolver` returned `undefined`) is a misconfiguration and fails with an error, instead
 * of silently passing unlimited: chain a resolver with a key every request has (e.g. the `clientIp` attribute) behind
 * the optional ones, or skip the middleware for such requests. Any other error of the limiter (e.g. an unreachable
 * redis) gets rethrown as well (fail closed), wrap the limiter (or use the `insuranceLimiter` option of
 * rate-limiter-flexible) to fail open instead.
 */
export const createRateLimitMiddleware = (
  responseHelpers: ResponseHelpers,
  keyResolver: KeyResolver,
  rateLimiter: RateLimiter,
): Middleware => {
  return async (request: ServerRequest, handler: Handler): Promise<Response> => {
    const key = await keyResolver(request);

    if (key === undefined) {
      throw new Error(
        `Missing rate limit key for ${request.method} ${resolvePathnameSearch(request.uri)}: the key resolver resolved no key, chain a resolver with a key every request has (e.g. the "clientIp" attribute)`,
      );
    }

    const info = await consume(rateLimiter, key, request);

    return withRateLimitHeaders(responseHelpers, await handler(request), info);
  };
};
