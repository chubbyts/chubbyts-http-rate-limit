import { describe, expect, test } from 'vitest';
import { useFunctionMock } from '@chubbyts/chubbyts-function-mock/function-mock';
import { useObjectMock } from '@chubbyts/chubbyts-function-mock/object-mock';
import type { Container } from '@chubbyts/chubbyts-dic-types/container';
import type { ConfigFactory } from '@chubbyts/chubbyts-dic-config/dic-config';
import { createContainerByConfigFactory } from '@chubbyts/chubbyts-dic-config/dic-config';
import { createResponseFactory, createServerRequestFactory } from '@chubbyts/chubbyts-http/message-factory';
import { createResponseHelpers, createServerRequestHelpers } from '@chubbyts/chubbyts-http/message-helper';
import type { Handler } from '@chubbyts/chubbyts-http-types/handler';
import type { Middleware } from '@chubbyts/chubbyts-http-types/middleware';
import { RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible';
import type { KeyResolver } from '../src/key-resolver.js';
import type { RateLimiter } from '../src/middleware.js';
import type { RateLimitConfig } from '../src/service-factory.js';
import {
  keyResolverServiceFactory,
  rateLimiterServiceFactory,
  rateLimitMiddlewareServiceFactory,
} from '../src/service-factory.js';

// the create functions return opaque closures, so the wiring gets proven by exercising the created services against
// requests and mocked collaborators (key resolver, rate limiter, handler), @chubbyts/chubbyts-http is used as
// implementation

const serverRequestFactory = createServerRequestFactory();
const serverRequestHelpers = createServerRequestHelpers();
const responseFactory = createResponseFactory();
const responseHelpers = createResponseHelpers();

const createRequest = (headers: Record<string, string> = {}, attributes: Record<string, unknown> = {}) =>
  Object.entries(attributes).reduce(
    (request, [name, value]) => serverRequestHelpers.withAttribute(request, name, value),
    Object.entries(headers).reduce(
      (request, [name, value]) => serverRequestHelpers.withHeader(request, name, value),
      serverRequestFactory('GET', 'https://api.example.com/resource'),
    ),
  );

describe('service-factory', () => {
  describe('keyResolverServiceFactory', () => {
    test('without name, with header and attribute', async () => {
      const rateLimitConfig: RateLimitConfig = {
        keys: [{ header: 'x-api-key' }, { attribute: 'clientIp' }],
        points: 10,
        duration: 60,
      };

      const [container, containerMocks] = useObjectMock<Container>([
        { name: 'get', parameters: ['config'], return: { chubbyts: { rateLimit: rateLimitConfig } } },
        { name: 'get', parameters: ['serverRequestHelpers'], return: serverRequestHelpers },
      ]);

      const service = keyResolverServiceFactory()(container);

      expect(await service(createRequest({ 'x-api-key': 'key-1' }, { clientIp: '10.0.0.1' }))).toBe('key-1');
      expect(await service(createRequest({}, { clientIp: '10.0.0.1' }))).toBe('10.0.0.1');
      expect(await service(createRequest())).toBeUndefined();

      expect(containerMocks).toHaveLength(0);
    });

    test('without keys', () => {
      const [container, containerMocks] = useObjectMock<Container>([
        {
          name: 'get',
          parameters: ['config'],
          return: { chubbyts: { rateLimit: { keys: [], points: 10, duration: 60 } } },
        },
      ]);

      expect(() => keyResolverServiceFactory()(container)).toThrow(
        'Missing key resolvers at config.chubbyts.rateLimit.keys, expected at least one',
      );

      expect(containerMocks).toHaveLength(0);
    });

    test.each([
      [{ heder: 'x-api-key' }, '{"heder":"x-api-key"}'],
      [{}, '{}'],
      [{ header: 'x-api-key', attribute: 'clientIp' }, '{"header":"x-api-key","attribute":"clientIp"}'],
      // inherited (Object.prototype) names are no resolvers
      [{ toString: 'x' }, '{"toString":"x"}'],
      [{ constructor: 'x' }, '{"constructor":"x"}'],
      [{ header: 123 }, '{"header":123}'],
      [{ attribute: null }, '{"attribute":null}'],
      [{ static: '' }, '{"static":""}'],
    ])('with invalid key %j', (key, json) => {
      const [container, containerMocks] = useObjectMock<Container>([
        {
          name: 'get',
          parameters: ['config'],
          return: { chubbyts: { rateLimit: { keys: [{ attribute: 'clientIp' }, key], points: 10, duration: 60 } } },
        },
        { name: 'get', parameters: ['serverRequestHelpers'], return: serverRequestHelpers },
      ]);

      expect(() => keyResolverServiceFactory()(container)).toThrow(
        `Invalid key resolver ${json} at config.chubbyts.rateLimit.keys[1], expected one of: { "header": non empty string }, { "attribute": non empty string }, { "static": non empty string }`,
      );

      expect(containerMocks).toHaveLength(0);
    });

    test('with keys, the configured order wins', async () => {
      const [container, containerMocks] = useObjectMock<Container>([
        {
          name: 'get',
          parameters: ['config'],
          return: {
            chubbyts: {
              rateLimit: { keys: [{ attribute: 'clientIp' }, { header: 'x-api-key' }], points: 10, duration: 60 },
            },
          },
        },
        { name: 'get', parameters: ['serverRequestHelpers'], return: serverRequestHelpers },
      ]);

      const service = keyResolverServiceFactory()(container);

      expect(await service(createRequest({ 'x-api-key': 'key-1' }, { clientIp: '10.0.0.1' }))).toBe('10.0.0.1');

      expect(containerMocks).toHaveLength(0);
    });

    test('with keys, static as fallback', async () => {
      const [container, containerMocks] = useObjectMock<Container>([
        {
          name: 'get',
          parameters: ['config'],
          return: {
            chubbyts: {
              rateLimit: { keys: [{ attribute: 'clientIp' }, { static: 'global' }], points: 10, duration: 60 },
            },
          },
        },
        { name: 'get', parameters: ['serverRequestHelpers'], return: serverRequestHelpers },
      ]);

      const service = keyResolverServiceFactory()(container);

      expect(await service(createRequest({}, { clientIp: '10.0.0.1' }))).toBe('10.0.0.1');
      expect(await service(createRequest())).toBe('global');

      expect(containerMocks).toHaveLength(0);
    });

    test('with keys, only attribute', async () => {
      const [container, containerMocks] = useObjectMock<Container>([
        {
          name: 'get',
          parameters: ['config'],
          return: {
            chubbyts: { rateLimit: { keys: [{ attribute: 'clientIp' }], points: 10, duration: 60 } },
          },
        },
        { name: 'get', parameters: ['serverRequestHelpers'], return: serverRequestHelpers },
      ]);

      const service = keyResolverServiceFactory()(container);

      expect(await service(createRequest({ 'x-api-key': 'key-1' }, { clientIp: '10.0.0.1' }))).toBe('10.0.0.1');

      expect(containerMocks).toHaveLength(0);
    });

    test('with name', async () => {
      const [container, containerMocks] = useObjectMock<Container>([
        {
          name: 'get',
          parameters: ['config'],
          return: {
            chubbyts: {
              rateLimit: {
                api: { keys: [{ header: 'x-api-key' }], points: 10, duration: 60 },
                login: { keys: [{ attribute: 'userId' }], points: 5, duration: 300 },
              },
            },
          },
        },
        { name: 'get', parameters: ['serverRequestHelpers'], return: serverRequestHelpers },
      ]);

      const service = keyResolverServiceFactory('login')(container);

      expect(await service(createRequest({ 'x-api-key': 'key-1' }, { userId: 'user-1' }))).toBe('user-1');

      expect(containerMocks).toHaveLength(0);
    });

    test.each([
      ['without config', {}, ''],
      ['with keys not being an array', { rateLimit: { keys: 'nope', points: 10, duration: 60 } }, ''],
      ['with name, without named config', { rateLimit: { api: { keys: [{ attribute: 'clientIp' }] } } }, 'login'],
    ])('%s', (_, chubbyts, name) => {
      const [container, containerMocks] = useObjectMock<Container>([
        { name: 'get', parameters: ['config'], return: { chubbyts } },
      ]);

      const path = name ? `config.chubbyts.rateLimit.${name}.keys` : 'config.chubbyts.rateLimit.keys';

      expect(() => keyResolverServiceFactory(name)(container)).toThrow(
        `Missing key resolvers at ${path}, expected at least one`,
      );

      expect(containerMocks).toHaveLength(0);
    });

    test('with name, with invalid key, the named path gets reported', () => {
      const [container, containerMocks] = useObjectMock<Container>([
        {
          name: 'get',
          parameters: ['config'],
          return: { chubbyts: { rateLimit: { login: { keys: [{ heder: 'x' }], points: 5, duration: 300 } } } },
        },
        { name: 'get', parameters: ['serverRequestHelpers'], return: serverRequestHelpers },
      ]);

      expect(() => keyResolverServiceFactory('login')(container)).toThrow(
        'Invalid key resolver {"heder":"x"} at config.chubbyts.rateLimit.login.keys[0]',
      );

      expect(containerMocks).toHaveLength(0);
    });
  });

  describe('rateLimiterServiceFactory', () => {
    test.each([
      ['points', { points: undefined, duration: 60 }, 'undefined', 'a positive integer'],
      ['points', { points: 0, duration: 60 }, '0', 'a positive integer'],
      ['points', { points: -5, duration: 60 }, '-5', 'a positive integer'],
      ['points', { points: 7.5, duration: 60 }, '7.5', 'a positive integer'],
      ['points', { points: '10', duration: 60 }, '"10"', 'a positive integer'],
      ['duration', { points: 10 }, 'undefined', 'an integer between 0 and 2147483 (seconds)'],
      ['duration', { points: 10, duration: -1 }, '-1', 'an integer between 0 and 2147483 (seconds)'],
      ['duration', { points: 10, duration: 1.5 }, '1.5', 'an integer between 0 and 2147483 (seconds)'],
      // RateLimiterMemory would end the limit after a millisecond (setTimeout overflow)
      ['duration', { points: 10, duration: 2_592_000 }, '2592000', 'an integer between 0 and 2147483 (seconds)'],
      [
        'blockDuration',
        { points: 10, duration: 60, blockDuration: 2_592_000 },
        '2592000',
        'an integer between 0 and 2147483 (seconds)',
      ],
      [
        'blockDuration',
        { points: 10, duration: 60, blockDuration: -1 },
        '-1',
        'an integer between 0 and 2147483 (seconds)',
      ],
    ])('with invalid %s %j', (option, rateLimitConfig, json, expected) => {
      const [container, containerMocks] = useObjectMock<Container>([
        { name: 'get', parameters: ['config'], return: { chubbyts: { rateLimit: { login: rateLimitConfig } } } },
      ]);

      expect(() => rateLimiterServiceFactory('login')(container)).toThrow(
        `Invalid ${option} ${json} at config.chubbyts.rateLimit.login.${option}, expected ${expected}`,
      );

      expect(containerMocks).toHaveLength(0);
    });

    test('without config', () => {
      const [container, containerMocks] = useObjectMock<Container>([
        { name: 'get', parameters: ['config'], return: { chubbyts: {} } },
      ]);

      expect(() => rateLimiterServiceFactory()(container)).toThrow(
        'Invalid points undefined at config.chubbyts.rateLimit.points, expected a positive integer',
      );

      expect(containerMocks).toHaveLength(0);
    });

    test('with minimum durations', () => {
      const [container, containerMocks] = useObjectMock<Container>([
        {
          name: 'get',
          parameters: ['config'],
          return: { chubbyts: { rateLimit: { points: 1, duration: 0, blockDuration: 0 } } },
        },
      ]);

      const service = rateLimiterServiceFactory()(container) as RateLimiterMemory;

      expect(service.duration).toBe(0);
      expect(service.blockDuration).toBe(0);

      expect(containerMocks).toHaveLength(0);
    });

    test('with maximum durations', () => {
      const [container, containerMocks] = useObjectMock<Container>([
        {
          name: 'get',
          parameters: ['config'],
          return: { chubbyts: { rateLimit: { points: 1, duration: 2_147_483, blockDuration: 2_147_483 } } },
        },
      ]);

      const service = rateLimiterServiceFactory()(container) as RateLimiterMemory;

      expect(service.duration).toBe(2_147_483);
      expect(service.blockDuration).toBe(2_147_483);

      expect(containerMocks).toHaveLength(0);
    });

    test('without name', async () => {
      const rateLimitConfig: RateLimitConfig = { keys: [{ static: 'global' }], points: 2, duration: 60 };

      const [container, containerMocks] = useObjectMock<Container>([
        { name: 'get', parameters: ['config'], return: { chubbyts: { rateLimit: rateLimitConfig } } },
      ]);

      const service = rateLimiterServiceFactory()(container);

      expect(service).toBeInstanceOf(RateLimiterMemory);
      expect(service.points).toBe(2);
      expect((service as RateLimiterMemory).duration).toBe(60);
      expect((service as RateLimiterMemory).blockDuration).toBe(0);
      expect((service as RateLimiterMemory).keyPrefix).toBe('rlflx');

      expect((await service.consume('key')).remainingPoints).toBe(1);
      expect((await service.consume('key')).remainingPoints).toBe(0);
      await expect(service.consume('key')).rejects.toBeInstanceOf(RateLimiterRes);

      expect(containerMocks).toHaveLength(0);
    });

    test('with name, with options', () => {
      const [container, containerMocks] = useObjectMock<Container>([
        {
          name: 'get',
          parameters: ['config'],
          return: {
            chubbyts: { rateLimit: { login: { points: 5, duration: 300, blockDuration: 900, keyPrefix: 'login' } } },
          },
        },
      ]);

      const service = rateLimiterServiceFactory('login')(container) as RateLimiterMemory;

      expect(service.points).toBe(5);
      expect(service.duration).toBe(300);
      expect(service.blockDuration).toBe(900);
      expect(service.keyPrefix).toBe('login');

      expect(containerMocks).toHaveLength(0);
    });

    test('with name, without keyPrefix, the name is the prefix', () => {
      const [container, containerMocks] = useObjectMock<Container>([
        {
          name: 'get',
          parameters: ['config'],
          return: { chubbyts: { rateLimit: { login: { points: 5, duration: 300 } } } },
        },
      ]);

      const service = rateLimiterServiceFactory('login')(container) as RateLimiterMemory;

      expect(service.keyPrefix).toBe('rlflx:login');

      expect(containerMocks).toHaveLength(0);
    });
  });

  describe('rateLimitMiddlewareServiceFactory', () => {
    test('with defaults, without registered services', async () => {
      const config = {
        chubbyts: { rateLimit: { keys: [{ header: 'x-real-ip' }], points: 1, duration: 60 } },
      };

      const [container, containerMocks] = useObjectMock<Container>([
        { name: 'get', parameters: ['responseHelpers'], return: responseHelpers },
        { name: 'has', parameters: ['rateLimitKeyResolver'], return: false },
        { name: 'get', parameters: ['config'], return: config },
        { name: 'get', parameters: ['serverRequestHelpers'], return: serverRequestHelpers },
        { name: 'has', parameters: ['rateLimitRateLimiter'], return: false },
        { name: 'get', parameters: ['config'], return: config },
      ]);

      const service = rateLimitMiddlewareServiceFactory()(container);

      const request = createRequest({ 'x-real-ip': '203.0.113.1' });

      const [handler, handlerMocks] = useFunctionMock<Handler>([
        { parameters: [request], return: Promise.resolve(responseFactory(200)) },
      ]);

      // the shipped factories get used: the configured header gets counted in memory, the 429 error gets thrown
      const response1 = await service(request, handler);

      expect(response1.status).toBe(200);
      expect(responseHelpers.getHeaderLine(response1, 'ratelimit-limit')).toBe('1');
      expect(responseHelpers.getHeaderLine(response1, 'ratelimit-remaining')).toBe('0');

      await expect(service(request, handler)).rejects.toMatchObject({ status: 429 });

      expect(handlerMocks).toHaveLength(0);
      expect(containerMocks).toHaveLength(0);
    });

    test('with registered services', async () => {
      const request = createRequest();

      const [keyResolver, keyResolverMocks] = useFunctionMock<KeyResolver>([{ parameters: [request], return: 'key' }]);
      const [rateLimiter, rateLimiterMocks] = useObjectMock<RateLimiter>([
        { name: 'points', value: 5 },
        { name: 'consume', parameters: ['key'], return: Promise.resolve(new RateLimiterRes(2, 5000, 3, false)) },
      ]);

      const [handler, handlerMocks] = useFunctionMock<Handler>([
        { parameters: [request], return: Promise.resolve(responseFactory(200)) },
      ]);

      const [container, containerMocks] = useObjectMock<Container>([
        { name: 'get', parameters: ['responseHelpers'], return: responseHelpers },
        { name: 'has', parameters: ['rateLimitKeyResolver'], return: true },
        { name: 'get', parameters: ['rateLimitKeyResolver'], return: keyResolver },
        { name: 'has', parameters: ['rateLimitRateLimiter'], return: true },
        { name: 'get', parameters: ['rateLimitRateLimiter'], return: rateLimiter },
      ]);

      const service = rateLimitMiddlewareServiceFactory()(container);

      // the registered services win over the shipped factories
      const rateLimitResponse = await service(request, handler);

      expect(rateLimitResponse.status).toBe(200);
      expect(responseHelpers.getHeaderLine(rateLimitResponse, 'ratelimit-limit')).toBe('5');
      expect(responseHelpers.getHeaderLine(rateLimitResponse, 'ratelimit-remaining')).toBe('2');
      expect(responseHelpers.getHeaderLine(rateLimitResponse, 'ratelimit-reset')).toBe('5');

      expect(keyResolverMocks).toHaveLength(0);
      expect(rateLimiterMocks).toHaveLength(0);
      expect(handlerMocks).toHaveLength(0);
      expect(containerMocks).toHaveLength(0);
    });

    test('with name, with registered named services', async () => {
      const request = createRequest();

      const [keyResolver, keyResolverMocks] = useFunctionMock<KeyResolver>([{ parameters: [request], return: 'key' }]);
      const [rateLimiter, rateLimiterMocks] = useObjectMock<RateLimiter>([
        { name: 'points', value: 2 },
        { name: 'consume', parameters: ['key'], return: Promise.reject(new RateLimiterRes(0, 5000, 3, false)) },
      ]);

      const [handler, handlerMocks] = useFunctionMock<Handler>([]);

      const [container, containerMocks] = useObjectMock<Container>([
        { name: 'get', parameters: ['responseHelpers'], return: responseHelpers },
        { name: 'has', parameters: ['rateLimitKeyResolverlogin'], return: true },
        { name: 'get', parameters: ['rateLimitKeyResolverlogin'], return: keyResolver },
        { name: 'has', parameters: ['rateLimitRateLimiterlogin'], return: true },
        { name: 'get', parameters: ['rateLimitRateLimiterlogin'], return: rateLimiter },
      ]);

      const service = rateLimitMiddlewareServiceFactory('login')(container);

      await expect(service(request, handler)).rejects.toMatchObject({
        status: 429,
        limit: 2,
        remaining: 0,
        reset: 5,
        retryAfter: 5,
      });

      expect(keyResolverMocks).toHaveLength(0);
      expect(rateLimiterMocks).toHaveLength(0);
      expect(handlerMocks).toHaveLength(0);
      expect(containerMocks).toHaveLength(0);
    });
  });

  describe('with container by config', () => {
    test('the services are wired together', async () => {
      const container = createContainerByConfigFactory({
        chubbyts: {
          rateLimit: {
            keys: [{ header: 'x-api-key' }, { attribute: 'clientIp' }],
            points: 2,
            duration: 60,
          } satisfies RateLimitConfig,
        },
        dependencies: {
          factories: new Map<string, ConfigFactory>([
            ['serverRequestHelpers', () => serverRequestHelpers],
            ['responseHelpers', () => responseHelpers],
            ['rateLimitMiddleware', rateLimitMiddlewareServiceFactory()],
            ['rateLimitKeyResolver', keyResolverServiceFactory()],
            ['rateLimitRateLimiter', rateLimiterServiceFactory()],
          ]),
        },
      })();

      const rateLimitMiddleware = container.get<Middleware>('rateLimitMiddleware');

      const [handler, handlerMocks] = useFunctionMock<Handler>([
        { callback: async () => responseFactory(200) },
        { callback: async () => responseFactory(200) },
        { callback: async () => responseFactory(200) },
      ]);

      const response1 = await rateLimitMiddleware(createRequest({ 'x-api-key': 'key-1' }), handler);
      const response2 = await rateLimitMiddleware(createRequest({}, { clientIp: 'key-1' }), handler);
      const response4 = await rateLimitMiddleware(createRequest({ 'x-api-key': 'key-2' }), handler);

      expect(responseHelpers.getHeaderLine(response1, 'ratelimit-remaining')).toBe('1');
      expect(responseHelpers.getHeaderLine(response2, 'ratelimit-remaining')).toBe('0');
      await expect(rateLimitMiddleware(createRequest({ 'x-api-key': 'key-1' }), handler)).rejects.toMatchObject({
        status: 429,
      });
      expect(response4.status).toBe(200);

      expect(handlerMocks).toHaveLength(0);
    });

    test('the named services are wired together', async () => {
      const container = createContainerByConfigFactory({
        chubbyts: {
          rateLimit: {
            api: { keys: [{ header: 'x-api-key' }], points: 100, duration: 60 },
            login: { keys: [{ header: 'x-api-key' }], points: 1, duration: 300 },
          } satisfies Record<string, RateLimitConfig>,
        },
        dependencies: {
          factories: new Map<string, ConfigFactory>([
            ['serverRequestHelpers', () => serverRequestHelpers],
            ['responseHelpers', () => responseHelpers],
            ['rateLimitMiddlewareapi', rateLimitMiddlewareServiceFactory('api')],
            ['rateLimitMiddlewarelogin', rateLimitMiddlewareServiceFactory('login')],
            ['rateLimitKeyResolverapi', keyResolverServiceFactory('api')],
            ['rateLimitKeyResolverlogin', keyResolverServiceFactory('login')],
          ]),
        },
      })();

      const apiMiddleware = container.get<Middleware>('rateLimitMiddlewareapi');
      const loginMiddleware = container.get<Middleware>('rateLimitMiddlewarelogin');

      const [handler, handlerMocks] = useFunctionMock<Handler>([
        { callback: async () => responseFactory(200) },
        { callback: async () => responseFactory(200) },
        { callback: async () => responseFactory(200) },
      ]);

      // each named middleware counts with its own limiter
      const apiResponse1 = await apiMiddleware(createRequest({ 'x-api-key': 'key-1' }), handler);
      const loginResponse1 = await loginMiddleware(createRequest({ 'x-api-key': 'key-1' }), handler);
      await expect(loginMiddleware(createRequest({ 'x-api-key': 'key-1' }), handler)).rejects.toMatchObject({
        status: 429,
      });
      const apiResponse2 = await apiMiddleware(createRequest({ 'x-api-key': 'key-1' }), handler);

      expect(responseHelpers.getHeaderLine(apiResponse1, 'ratelimit-limit')).toBe('100');
      expect(responseHelpers.getHeaderLine(apiResponse1, 'ratelimit-remaining')).toBe('99');
      expect(responseHelpers.getHeaderLine(loginResponse1, 'ratelimit-limit')).toBe('1');
      expect(responseHelpers.getHeaderLine(loginResponse1, 'ratelimit-remaining')).toBe('0');
      expect(responseHelpers.getHeaderLine(apiResponse2, 'ratelimit-remaining')).toBe('98');

      expect(handlerMocks).toHaveLength(0);
    });
  });
});
