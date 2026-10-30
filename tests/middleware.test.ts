import { describe, expect, test } from 'vitest';
import { useFunctionMock } from '@chubbyts/chubbyts-function-mock/dist/function-mock';
import { useObjectMock } from '@chubbyts/chubbyts-function-mock/dist/object-mock';
import { createResponseFactory, createServerRequestFactory } from '@chubbyts/chubbyts-http/message-factory';
import { createResponseHelpers } from '@chubbyts/chubbyts-http/message-helper';
import type { Handler } from '@chubbyts/chubbyts-http-types/handler';
import type { Method } from '@chubbyts/chubbyts-http-types/message';
import { HttpError } from '@chubbyts/chubbyts-http-error/dist/http-error';
import { RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible';
import type { KeyResolver } from '../src/key-resolver.js';
import type { RateLimiter } from '../src/middleware.js';
import { createRateLimitMiddleware } from '../src/middleware.js';

// @chubbyts/chubbyts-http is used as implementation of the types

const serverRequestFactory = createServerRequestFactory();
const responseFactory = createResponseFactory();
const responseHelpers = createResponseHelpers();

const createRequest = (uri = 'https://example.com', method: Method = 'GET') => serverRequestFactory(method, uri);

describe('middleware', () => {
  describe('createRateLimitMiddleware', () => {
    test('without key', async () => {
      const request = createRequest('https://example.com/resource?page=2', 'POST');

      const [handler, handlerMocks] = useFunctionMock<Handler>([]);

      const [keyResolver, keyResolverMocks] = useFunctionMock<KeyResolver>([
        { parameters: [request], return: undefined },
      ]);

      const [rateLimiter, rateLimiterMocks] = useObjectMock<RateLimiter>([]);

      const middleware = createRateLimitMiddleware(responseHelpers, keyResolver, rateLimiter);

      await expect(middleware(request, handler)).rejects.toThrow(
        'Missing rate limit key for POST /resource?page=2: the key resolver resolved no key, chain a resolver with a key every request has (e.g. the "clientIp" attribute)',
      );

      expect(handlerMocks).toHaveLength(0);
      expect(keyResolverMocks).toHaveLength(0);
      expect(rateLimiterMocks).toHaveLength(0);
    });

    test('with key, within limit', async () => {
      const request = createRequest();
      const response = [
        ['x-custom', 'value'],
        ['set-cookie', 'a=1'],
        ['set-cookie', 'b=2'],
      ].reduce(
        (current, [name, value]) => responseHelpers.withAddedHeader(current, name, value),
        responseFactory(201, 'Created'),
      );

      const [handler, handlerMocks] = useFunctionMock<Handler>([
        { parameters: [request], return: Promise.resolve(response) },
      ]);

      const [keyResolver, keyResolverMocks] = useFunctionMock<KeyResolver>([
        { parameters: [request], return: '203.0.113.1' },
      ]);

      const [rateLimiter, rateLimiterMocks] = useObjectMock<RateLimiter>([
        { name: 'points', value: 10 },
        {
          name: 'consume',
          parameters: ['203.0.113.1'],
          return: Promise.resolve(new RateLimiterRes(7, 12_001, 3, false)),
        },
      ]);

      const middleware = createRateLimitMiddleware(responseHelpers, keyResolver, rateLimiter);

      const rateLimitResponse = await middleware(request, handler);

      // the headers get changed through the helpers, which return a new response with the same body
      expect(rateLimitResponse.status).toBe(201);
      expect(rateLimitResponse.reasonPhrase).toBe('Created');
      expect(rateLimitResponse.body).toBe(response.body);
      expect(rateLimitResponse.headers).toMatchInlineSnapshot(`
        {
          "ratelimit-limit": [
            "10",
          ],
          "ratelimit-remaining": [
            "7",
          ],
          "ratelimit-reset": [
            "13",
          ],
          "set-cookie": [
            "a=1",
            "b=2",
          ],
          "x-custom": [
            "value",
          ],
        }
      `);

      expect(handlerMocks).toHaveLength(0);
      expect(keyResolverMocks).toHaveLength(0);
      expect(rateLimiterMocks).toHaveLength(0);
    });

    test('with key, at limit', async () => {
      const request = createRequest();

      const [handler, handlerMocks] = useFunctionMock<Handler>([
        { parameters: [request], return: Promise.resolve(responseFactory(200)) },
      ]);

      const [keyResolver, keyResolverMocks] = useFunctionMock<KeyResolver>([
        { parameters: [request], return: '203.0.113.1' },
      ]);

      const [rateLimiter, rateLimiterMocks] = useObjectMock<RateLimiter>([
        { name: 'points', value: 10 },
        {
          name: 'consume',
          parameters: ['203.0.113.1'],
          return: Promise.resolve(new RateLimiterRes(0, 1000, 10, false)),
        },
      ]);

      const middleware = createRateLimitMiddleware(responseHelpers, keyResolver, rateLimiter);

      const rateLimitResponse = await middleware(request, handler);

      expect(rateLimitResponse.status).toBe(200);
      expect(rateLimitResponse.headers).toMatchInlineSnapshot(`
        {
          "ratelimit-limit": [
            "10",
          ],
          "ratelimit-remaining": [
            "0",
          ],
          "ratelimit-reset": [
            "1",
          ],
        }
      `);

      expect(handlerMocks).toHaveLength(0);
      expect(keyResolverMocks).toHaveLength(0);
      expect(rateLimiterMocks).toHaveLength(0);
    });

    test('with key, within limit, with rate limit and retry-after headers set by the handler', async () => {
      const request = createRequest();
      const response = responseHelpers.withHeader(
        responseHelpers.withHeader(responseFactory(503), 'retry-after', '120'),
        'ratelimit-limit',
        ['spoofed', 'twice'],
      );

      const [handler, handlerMocks] = useFunctionMock<Handler>([
        { parameters: [request], return: Promise.resolve(response) },
      ]);

      const [keyResolver, keyResolverMocks] = useFunctionMock<KeyResolver>([
        { parameters: [request], return: '203.0.113.1' },
      ]);

      const [rateLimiter, rateLimiterMocks] = useObjectMock<RateLimiter>([
        { name: 'points', value: 10 },
        {
          name: 'consume',
          parameters: ['203.0.113.1'],
          return: Promise.resolve(new RateLimiterRes(7, 12_001, 3, false)),
        },
      ]);

      const middleware = createRateLimitMiddleware(responseHelpers, keyResolver, rateLimiter);

      const rateLimitResponse = await middleware(request, handler);

      // the rate limit headers get replaced, the handler's retry-after is none of the middleware's business within
      // the limit
      expect(rateLimitResponse.status).toBe(503);
      expect(rateLimitResponse.headers).toMatchInlineSnapshot(`
        {
          "ratelimit-limit": [
            "10",
          ],
          "ratelimit-remaining": [
            "7",
          ],
          "ratelimit-reset": [
            "13",
          ],
          "retry-after": [
            "120",
          ],
        }
      `);

      expect(handlerMocks).toHaveLength(0);
      expect(keyResolverMocks).toHaveLength(0);
      expect(rateLimiterMocks).toHaveLength(0);
    });

    test('with key, with never resetting limit (duration 0), a reset of the handler gets removed', async () => {
      const request = createRequest();

      const [handler, handlerMocks] = useFunctionMock<Handler>([
        {
          parameters: [request],
          return: Promise.resolve(responseHelpers.withHeader(responseFactory(200), 'ratelimit-reset', '999')),
        },
      ]);

      const [keyResolver, keyResolverMocks] = useFunctionMock<KeyResolver>([
        { parameters: [request], return: '203.0.113.1' },
      ]);

      const [rateLimiter, rateLimiterMocks] = useObjectMock<RateLimiter>([
        { name: 'points', value: 10 },
        { name: 'consume', parameters: ['203.0.113.1'], return: Promise.resolve(new RateLimiterRes(9, -1, 1, true)) },
      ]);

      const middleware = createRateLimitMiddleware(responseHelpers, keyResolver, rateLimiter);

      const rateLimitResponse = await middleware(request, handler);

      expect(rateLimitResponse.headers).toMatchInlineSnapshot(`
        {
          "ratelimit-limit": [
            "10",
          ],
          "ratelimit-remaining": [
            "9",
          ],
        }
      `);

      expect(handlerMocks).toHaveLength(0);
      expect(keyResolverMocks).toHaveLength(0);
      expect(rateLimiterMocks).toHaveLength(0);
    });

    test('with key, with never resetting limit (duration 0)', async () => {
      const request = createRequest();

      const [handler, handlerMocks] = useFunctionMock<Handler>([
        { parameters: [request], return: Promise.resolve(responseFactory(200)) },
      ]);

      const [keyResolver, keyResolverMocks] = useFunctionMock<KeyResolver>([
        { parameters: [request], return: '203.0.113.1' },
      ]);

      const [rateLimiter, rateLimiterMocks] = useObjectMock<RateLimiter>([
        { name: 'points', value: 10 },
        { name: 'consume', parameters: ['203.0.113.1'], return: Promise.resolve(new RateLimiterRes(9, -1, 1, true)) },
      ]);

      const middleware = createRateLimitMiddleware(responseHelpers, keyResolver, rateLimiter);

      const rateLimitResponse = await middleware(request, handler);

      // no ratelimit-reset, as the limit never resets
      expect(rateLimitResponse.headers).toMatchInlineSnapshot(`
        {
          "ratelimit-limit": [
            "10",
          ],
          "ratelimit-remaining": [
            "9",
          ],
        }
      `);

      expect(handlerMocks).toHaveLength(0);
      expect(keyResolverMocks).toHaveLength(0);
      expect(rateLimiterMocks).toHaveLength(0);
    });

    test('with key, exceeded', async () => {
      const request = createRequest('https://example.com/resource');

      const [handler, handlerMocks] = useFunctionMock<Handler>([]);

      const [keyResolver, keyResolverMocks] = useFunctionMock<KeyResolver>([
        { parameters: [request], return: '203.0.113.1' },
      ]);

      const [rateLimiter, rateLimiterMocks] = useObjectMock<RateLimiter>([
        { name: 'points', value: 10 },
        {
          name: 'consume',
          parameters: ['203.0.113.1'],
          return: Promise.reject(new RateLimiterRes(0, 2500, 11, false)),
        },
      ]);

      const middleware = createRateLimitMiddleware(responseHelpers, keyResolver, rateLimiter);

      const error = await middleware(request, handler).then(
        () => undefined,
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(HttpError);
      expect(error).toMatchObject({
        status: 429,
        title: 'Too Many Requests',
        _httpError: 'TooManyRequests',
        detail: 'Limit of 10 requests reached for GET /resource, retry in 3 seconds',
        instance: '/resource',
        limit: 10,
        remaining: 0,
        reset: 3,
        retryAfter: 3,
        headers: {
          'ratelimit-limit': '10',
          'ratelimit-remaining': '0',
          'ratelimit-reset': '3',
          'retry-after': '3',
        },
      });

      expect(handlerMocks).toHaveLength(0);
      expect(keyResolverMocks).toHaveLength(0);
      expect(rateLimiterMocks).toHaveLength(0);
    });

    test('with key, exceeded, with query', async () => {
      const request = createRequest('https://example.com/resource?page=2', 'POST');

      const [handler, handlerMocks] = useFunctionMock<Handler>([]);

      const [keyResolver, keyResolverMocks] = useFunctionMock<KeyResolver>([
        { parameters: [request], return: '203.0.113.1' },
      ]);

      const [rateLimiter, rateLimiterMocks] = useObjectMock<RateLimiter>([
        { name: 'points', value: 10 },
        {
          name: 'consume',
          parameters: ['203.0.113.1'],
          return: Promise.reject(new RateLimiterRes(0, 2500, 11, false)),
        },
      ]);

      const middleware = createRateLimitMiddleware(responseHelpers, keyResolver, rateLimiter);

      await expect(middleware(request, handler)).rejects.toMatchObject({
        status: 429,
        detail: 'Limit of 10 requests reached for POST /resource?page=2, retry in 3 seconds',
        instance: '/resource?page=2',
      });

      expect(handlerMocks).toHaveLength(0);
      expect(keyResolverMocks).toHaveLength(0);
      expect(rateLimiterMocks).toHaveLength(0);
    });

    test('with key, exceeded, within the last second (retry-after at least a second)', async () => {
      const request = createRequest();

      const [handler, handlerMocks] = useFunctionMock<Handler>([]);

      const [keyResolver, keyResolverMocks] = useFunctionMock<KeyResolver>([
        { parameters: [request], return: '203.0.113.1' },
      ]);

      const [rateLimiter, rateLimiterMocks] = useObjectMock<RateLimiter>([
        { name: 'points', value: 10 },
        { name: 'consume', parameters: ['203.0.113.1'], return: Promise.reject(new RateLimiterRes(0, 0, 11, false)) },
      ]);

      const middleware = createRateLimitMiddleware(responseHelpers, keyResolver, rateLimiter);

      await expect(middleware(request, handler)).rejects.toMatchObject({
        status: 429,
        reset: 0,
        retryAfter: 1,
        headers: { 'ratelimit-limit': '10', 'ratelimit-remaining': '0', 'ratelimit-reset': '0', 'retry-after': '1' },
      });

      expect(handlerMocks).toHaveLength(0);
      expect(keyResolverMocks).toHaveLength(0);
      expect(rateLimiterMocks).toHaveLength(0);
    });

    test('with key, exceeded, with rate limiter res of a foreign rate-limiter-flexible copy', async () => {
      const request = createRequest();

      const [handler, handlerMocks] = useFunctionMock<Handler>([]);

      const [keyResolver, keyResolverMocks] = useFunctionMock<KeyResolver>([
        { parameters: [request], return: '203.0.113.1' },
      ]);

      const [rateLimiter, rateLimiterMocks] = useObjectMock<RateLimiter>([
        { name: 'points', value: 10 },
        {
          name: 'consume',
          parameters: ['203.0.113.1'],
          return: Promise.reject({
            remainingPoints: 0,
            msBeforeNext: 2500,
            consumedPoints: 11,
            isFirstInDuration: false,
          }),
        },
      ]);

      const middleware = createRateLimitMiddleware(responseHelpers, keyResolver, rateLimiter);

      await expect(middleware(request, handler)).rejects.toMatchObject({ status: 429, remaining: 0, retryAfter: 3 });

      expect(handlerMocks).toHaveLength(0);
      expect(keyResolverMocks).toHaveLength(0);
      expect(rateLimiterMocks).toHaveLength(0);
    });

    test('with key, exceeded, with never resetting limit (duration 0)', async () => {
      const request = createRequest('https://example.com/resource');

      const [handler, handlerMocks] = useFunctionMock<Handler>([]);

      const [keyResolver, keyResolverMocks] = useFunctionMock<KeyResolver>([
        { parameters: [request], return: '203.0.113.1' },
      ]);

      const [rateLimiter, rateLimiterMocks] = useObjectMock<RateLimiter>([
        { name: 'points', value: 10 },
        { name: 'consume', parameters: ['203.0.113.1'], return: Promise.reject(new RateLimiterRes(0, -1, 11, false)) },
      ]);

      const middleware = createRateLimitMiddleware(responseHelpers, keyResolver, rateLimiter);

      const error = await middleware(request, handler).then(
        () => undefined,
        (e: unknown) => e,
      );

      // no reset / retryAfter, as there is no point in time the client could retry: not even as undefined properties
      expect(error).toBeInstanceOf(HttpError);
      expect(error).toMatchObject({
        status: 429,
        detail: 'Limit of 10 requests reached for GET /resource',
        limit: 10,
        remaining: 0,
        headers: { 'ratelimit-limit': '10', 'ratelimit-remaining': '0' },
      });
      expect(Object.hasOwn(error as object, 'reset')).toBe(false);
      expect(Object.hasOwn(error as object, 'retryAfter')).toBe(false);
      expect((error as HttpError).headers).toStrictEqual({ 'ratelimit-limit': '10', 'ratelimit-remaining': '0' });

      expect(handlerMocks).toHaveLength(0);
      expect(keyResolverMocks).toHaveLength(0);
      expect(rateLimiterMocks).toHaveLength(0);
    });

    test('with async key resolver', async () => {
      const request = createRequest();

      const [handler, handlerMocks] = useFunctionMock<Handler>([
        { parameters: [request], return: Promise.resolve(responseFactory(200)) },
      ]);

      const [keyResolver, keyResolverMocks] = useFunctionMock<KeyResolver>([
        { parameters: [request], return: Promise.resolve('tenant-1') },
      ]);

      const [rateLimiter, rateLimiterMocks] = useObjectMock<RateLimiter>([
        { name: 'points', value: 10 },
        { name: 'consume', parameters: ['tenant-1'], return: Promise.resolve(new RateLimiterRes(9, 1000, 1, true)) },
      ]);

      const middleware = createRateLimitMiddleware(responseHelpers, keyResolver, rateLimiter);

      const rateLimitResponse = await middleware(request, handler);

      expect(responseHelpers.getHeaderLine(rateLimitResponse, 'ratelimit-remaining')).toBe('9');

      expect(handlerMocks).toHaveLength(0);
      expect(keyResolverMocks).toHaveLength(0);
      expect(rateLimiterMocks).toHaveLength(0);
    });

    test.each([
      null,
      'string',
      { remainingPoints: 0 },
      { msBeforeNext: 0 },
      { remainingPoints: '0', msBeforeNext: 0 },
      { remainingPoints: 0, msBeforeNext: 0 },
      { remainingPoints: 0, msBeforeNext: 0, consumedPoints: '1' },
      { msBeforeNext: 0, consumedPoints: 1 },
      { remainingPoints: 0, consumedPoints: 1 },
      { remainingPoints: 0, msBeforeNext: '0', consumedPoints: 1 },
      // a function (typeof 'function') with matching properties
      // eslint-disable-next-line functional/immutable-data
      Object.assign(() => undefined, { remainingPoints: 0, msBeforeNext: 0, consumedPoints: 1 }),
      // a real error must not be swallowed into a 429, even with matching properties
      new (class extends Error {
        remainingPoints = 0;
        msBeforeNext = 0;
        consumedPoints = 1;
      })('redis connection lost'),
    ])('with key, with non rate limiter res rejection %j', async (error) => {
      const request = createRequest();

      const [handler, handlerMocks] = useFunctionMock<Handler>([]);

      const [keyResolver, keyResolverMocks] = useFunctionMock<KeyResolver>([
        { parameters: [request], return: '203.0.113.1' },
      ]);

      const [rateLimiter, rateLimiterMocks] = useObjectMock<RateLimiter>([
        { name: 'points', value: 10 },
        { name: 'consume', parameters: ['203.0.113.1'], return: Promise.reject(error) },
      ]);

      const middleware = createRateLimitMiddleware(responseHelpers, keyResolver, rateLimiter);

      await expect(middleware(request, handler)).rejects.toBe(error);

      expect(handlerMocks).toHaveLength(0);
      expect(keyResolverMocks).toHaveLength(0);
      expect(rateLimiterMocks).toHaveLength(0);
    });

    test('with key, with limiter error', async () => {
      const request = createRequest();
      const error = new Error('redis connection lost');

      const [handler, handlerMocks] = useFunctionMock<Handler>([]);

      const [keyResolver, keyResolverMocks] = useFunctionMock<KeyResolver>([
        { parameters: [request], return: '203.0.113.1' },
      ]);

      const [rateLimiter, rateLimiterMocks] = useObjectMock<RateLimiter>([
        { name: 'points', value: 10 },
        { name: 'consume', parameters: ['203.0.113.1'], return: Promise.reject(error) },
      ]);

      const middleware = createRateLimitMiddleware(responseHelpers, keyResolver, rateLimiter);

      await expect(middleware(request, handler)).rejects.toBe(error);

      expect(handlerMocks).toHaveLength(0);
      expect(keyResolverMocks).toHaveLength(0);
      expect(rateLimiterMocks).toHaveLength(0);
    });

    test('with key, with handler error', async () => {
      const request = createRequest();
      const error = new Error('handler failed');

      const [handler, handlerMocks] = useFunctionMock<Handler>([
        { parameters: [request], return: Promise.reject(error) },
      ]);

      const [keyResolver, keyResolverMocks] = useFunctionMock<KeyResolver>([
        { parameters: [request], return: '203.0.113.1' },
      ]);

      const [rateLimiter, rateLimiterMocks] = useObjectMock<RateLimiter>([
        { name: 'points', value: 10 },
        { name: 'consume', parameters: ['203.0.113.1'], return: Promise.resolve(new RateLimiterRes(9, 1000, 1, true)) },
      ]);

      const middleware = createRateLimitMiddleware(responseHelpers, keyResolver, rateLimiter);

      await expect(middleware(request, handler)).rejects.toBe(error);

      expect(handlerMocks).toHaveLength(0);
      expect(keyResolverMocks).toHaveLength(0);
      expect(rateLimiterMocks).toHaveLength(0);
    });

    test('with RateLimiterMemory', async () => {
      const request = createRequest();

      const [handler, handlerMocks] = useFunctionMock<Handler>([
        { parameters: [request], return: Promise.resolve(responseFactory(200)) },
        { parameters: [request], return: Promise.resolve(responseFactory(200)) },
      ]);

      const [keyResolver, keyResolverMocks] = useFunctionMock<KeyResolver>([
        { parameters: [request], return: '203.0.113.1' },
        { parameters: [request], return: '203.0.113.1' },
        { parameters: [request], return: '203.0.113.1' },
      ]);

      const middleware = createRateLimitMiddleware(
        responseHelpers,
        keyResolver,
        new RateLimiterMemory({ points: 2, duration: 60 }),
      );

      const response1 = await middleware(request, handler);
      const response2 = await middleware(request, handler);

      expect(response1.status).toBe(200);
      expect(responseHelpers.getHeaderLine(response1, 'ratelimit-limit')).toBe('2');
      expect(responseHelpers.getHeaderLine(response1, 'ratelimit-remaining')).toBe('1');
      expect(Number(responseHelpers.getHeaderLine(response1, 'ratelimit-reset'))).toBeLessThanOrEqual(60);
      expect(Number(responseHelpers.getHeaderLine(response1, 'ratelimit-reset'))).toBeGreaterThan(0);
      expect(response2.status).toBe(200);
      expect(responseHelpers.getHeaderLine(response2, 'ratelimit-remaining')).toBe('0');
      await expect(middleware(request, handler)).rejects.toMatchObject({ status: 429, remaining: 0 });

      expect(handlerMocks).toHaveLength(0);
      expect(keyResolverMocks).toHaveLength(0);
    });
  });
});
