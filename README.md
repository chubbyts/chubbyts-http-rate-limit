# chubbyts-http-rate-limit

[![CI](https://github.com/chubbyts/chubbyts-http-rate-limit/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/chubbyts/chubbyts-http-rate-limit/actions/workflows/ci.yml)
[![Coverage Status](https://coveralls.io/repos/github/chubbyts/chubbyts-http-rate-limit/badge.svg?branch=master)](https://coveralls.io/github/chubbyts/chubbyts-http-rate-limit?branch=master)
[![Mutation testing badge](https://img.shields.io/endpoint?style=flat&url=https%3A%2F%2Fbadge-api.stryker-mutator.io%2Fgithub.com%2Fchubbyts%2Fchubbyts-http-rate-limit%2Fmaster)](https://dashboard.stryker-mutator.io/reports/github.com/chubbyts/chubbyts-http-rate-limit/master)
[![npm-version](https://img.shields.io/npm/v/@chubbyts/chubbyts-http-rate-limit.svg)](https://www.npmjs.com/package/@chubbyts/chubbyts-http-rate-limit)

[![bugs](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-http-rate-limit&metric=bugs)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-http-rate-limit)
[![code_smells](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-http-rate-limit&metric=code_smells)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-http-rate-limit)
[![coverage](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-http-rate-limit&metric=coverage)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-http-rate-limit)
[![duplicated_lines_density](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-http-rate-limit&metric=duplicated_lines_density)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-http-rate-limit)
[![ncloc](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-http-rate-limit&metric=ncloc)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-http-rate-limit)
[![sqale_rating](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-http-rate-limit&metric=sqale_rating)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-http-rate-limit)
[![alert_status](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-http-rate-limit&metric=alert_status)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-http-rate-limit)
[![reliability_rating](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-http-rate-limit&metric=reliability_rating)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-http-rate-limit)
[![security_rating](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-http-rate-limit&metric=security_rating)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-http-rate-limit)
[![sqale_index](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-http-rate-limit&metric=sqale_index)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-http-rate-limit)
[![vulnerabilities](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-http-rate-limit&metric=vulnerabilities)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-http-rate-limit)

## Description

A minimal rate limiting middleware for [@chubbyts/chubbyts-http-types][2].

It works with any implementation of the types (e.g. [@chubbyts/chubbyts-http][6]): the request headers get read
through the injected helpers, the responses get changed through the injected response helpers only.

## Requirements

 * node: >=22
 * [@chubbyts/chubbyts-dic-config-factory][5]: ^1.0.1
 * [@chubbyts/chubbyts-dic-types][3]: ^2.3.1
 * [@chubbyts/chubbyts-http-error][9]: ^3.5.1
 * [@chubbyts/chubbyts-http-types][2]: ^4.0.0
 * [rate-limiter-flexible][7]: ^11.2.3

## Installation

Through [NPM](https://www.npmjs.com) as [@chubbyts/chubbyts-http-rate-limit][1].

```ts
npm i @chubbyts/chubbyts-http-rate-limit@^1.0.0
```

## Usage

The middleware is a thin layer on top of [rate-limiter-flexible][7]: it resolves the key of a request (usually the
client ip), consumes one point from a `RateLimiter*` and translates the result into the `ratelimit-limit`,
`ratelimit-remaining` and `ratelimit-reset` (seconds) headers, or throws a `TooManyRequests` http error of
[chubbyts-http-error][9] once the limiter rejects. With `duration: 0` (the limit never resets) `ratelimit-reset` is
omitted.

The header names follow the widely supported earlier drafts of [draft-ietf-httpapi-ratelimit-headers][8] (separate
`ratelimit-*` headers); the current drafts fold them into a single structured `ratelimit` header, which is not
supported by most clients yet.

```ts
import { createResponseFactory, createServerRequestFactory } from '@chubbyts/chubbyts-http/message-factory';
import { createResponseHelpers, createServerRequestHelpers } from '@chubbyts/chubbyts-http/message-helper';
import type { Handler } from '@chubbyts/chubbyts-http-types/handler';
import {
  createAttributeKeyResolver,
  createHeaderKeyResolver,
  createKeyResolver,
} from '@chubbyts/chubbyts-http-rate-limit/key-resolver';
import { createRateLimitMiddleware } from '@chubbyts/chubbyts-http-rate-limit/middleware';
import { RateLimiterMemory } from 'rate-limiter-flexible';

const serverRequestFactory = createServerRequestFactory();
const serverRequestHelpers = createServerRequestHelpers();
const responseFactory = createResponseFactory();
const responseHelpers = createResponseHelpers();

const rateLimitMiddleware = createRateLimitMiddleware(
  responseHelpers,
  // the first resolved key wins, the last resolver should resolve a key for every request
  createKeyResolver([
    createHeaderKeyResolver(serverRequestHelpers, 'x-api-key'),
    createAttributeKeyResolver('clientIp'),
  ]),
  // 100 requests per 60 seconds, see rate-limiter-flexible for blockDuration, RateLimiterRedis, RateLimiterMongo, ...
  new RateLimiterMemory({ points: 100, duration: 60 }),
);

const handler: Handler = async () => responseFactory(200);

(async () => {
  const serverRequest = serverRequestFactory('GET', 'https://example.com/');
  const response = await rateLimitMiddleware(serverRequest, handler);
})();
```

### Client ip behind a proxy

The middleware does **not** parse `x-forwarded-for` (or any other forwarded header) itself: every proxy *appends* the
address it saw, so the first entry is whatever the client sent, and any client could pick its own key (and thereby its
own limit). Use a trusted proxy middleware in front of this middleware instead: it decides which entries of the
forwarded headers to trust and sets a `clientIp` attribute, which `createAttributeKeyResolver('clientIp')` reads.

`createHeaderKeyResolver` is meant for headers the client legitimately owns, like an `x-api-key` (the header value is
the key as is, multiple values joined with `, `), not for forwarded headers. Keep in mind that a client who simply
omits such a header gets no key: either chain a resolver with a key every request has (e.g.
`createAttributeKeyResolver('clientIp')`, or as a last resort `createStaticKeyResolver('global')`, which puts all
remaining requests into one shared limit) behind it, or reject requests without the header before this middleware.

The key space should not be under the control of the client: every distinct key allocates its own counter in the
limiter (for `RateLimiterMemory` a record plus a timer per key until the duration ends). A resolver which lets a
client pick arbitrary keys (like a freely spoofable header) lets it grow the memory of the limiter without bound.

A `KeyResolver` may be async (e.g. to map an api key to a tenant). The middleware fails closed: a request without a
resolved key (no matching header / attribute) is treated as a misconfiguration and fails with an error instead of
passing unlimited, as do errors of the limiter (e.g. an unreachable redis; use the `insuranceLimiter` option of
[rate-limiter-flexible][7] to fall back to another limiter). To exempt requests from the rate limit, do not run the
middleware for them (e.g. register it per route or route group).

### Shared limits between processes

`RateLimiterMemory` counts within a single process. Pass any other limiter of [rate-limiter-flexible][7]
(`RateLimiterRedis`, `RateLimiterMongo`, `RateLimiterPostgres`, ...) to share the limits:

```ts
import { RateLimiterMongo } from 'rate-limiter-flexible';

const rateLimiter = new RateLimiterMongo({ storeClient: mongoClient, points: 100, duration: 60 });
```

### Limit exceeded

Once the limit is exceeded the middleware does not return a response, it throws a `429 Too Many Requests` `HttpError`
(`createTooManyRequests` of [chubbyts-http-error][9]), so that the error middleware of the application (e.g. the one
of [chubbyts-http-api][10]) turns it into the response and rate limit errors look like every other error (problem
json, logging, ...). The `detail` and `instance` contain the path and query of the request. The error carries as data:

 * `limit`, `remaining`, `reset` (seconds) and `retryAfter` (seconds, at least `1`) as additional problem details,
   `reset` and `retryAfter` are absent if the limit never resets (`duration: 0`)
 * `headers`: the `ratelimit-limit`, `ratelimit-remaining`, `ratelimit-reset` and `retry-after` headers of the `429`
   response, ready to be set by the error middleware (the reset and retry-after ones only if the limit resets at all),
   never part of the body

```ts
import { createResponseFactory, createStreamFactory } from '@chubbyts/chubbyts-http/message-factory';
import { createResponseHelpers } from '@chubbyts/chubbyts-http/message-helper';
import { isHttpError } from '@chubbyts/chubbyts-http-error/dist/http-error';
import type { Middleware } from '@chubbyts/chubbyts-http-types/middleware';

const responseFactory = createResponseFactory();
const responseHelpers = createResponseHelpers();
const streamFactory = createStreamFactory();

const errorMiddleware: Middleware = async (request, handler) => {
  try {
    return await handler(request);
  } catch (e) {
    if (isHttpError(e)) {
      const { headers = {}, _httpError, ...body } = e;

      return Object.entries({ 'content-type': 'application/problem+json', ...headers }).reduce(
        (response, [name, value]) => responseHelpers.withHeader(response, name, value),
        responseHelpers.withBody(responseFactory(e.status), streamFactory(JSON.stringify(body))),
      );
    }

    throw e;
  }
};
```

### Service factories (chubbyts-dic-config)

The package ships service factories (abstract factories built on [chubbyts-dic-config-factory][5]) for a [chubbyts-dic-config][4] (or any [chubbyts-dic-types][3] compatible) container within `@chubbyts/chubbyts-http-rate-limit/service-factory`, configured through `config.chubbyts.rateLimit`. The implementation of the types gets read from the services `serverRequestHelpers` and `responseHelpers`, which have to be registered:

```ts
import type { ConfigFactory } from '@chubbyts/chubbyts-dic-config/dist/dic-config';
import { createContainerByConfigFactory } from '@chubbyts/chubbyts-dic-config/dist/dic-config';
import { createResponseHelpers, createServerRequestHelpers } from '@chubbyts/chubbyts-http/message-helper';
import type { RateLimitConfig } from '@chubbyts/chubbyts-http-rate-limit/service-factory';
import { rateLimitMiddlewareServiceFactory } from '@chubbyts/chubbyts-http-rate-limit/service-factory';
import type { Middleware } from '@chubbyts/chubbyts-http-types/middleware';

const container = createContainerByConfigFactory({
  chubbyts: {
    rateLimit: {
      // the key resolvers in order, the first resolved key wins
      keys: [
        // the clientIp attribute set by a trusted proxy middleware (registered before this middleware)
        { attribute: 'clientIp' },
        // a header name, e.g. an api key (not x-forwarded-for, see "Client ip behind a proxy")
        { header: 'x-api-key' },
        // a fixed key for all remaining requests (one shared limit instead of no limit), optional
        { static: 'global' },
      ],
      points: 100,
      duration: 60,
      // blockDuration: 0,
      // keyPrefix: 'rlflx', ('rlflx:<name>' for named factories, see below)
    } satisfies RateLimitConfig,
  },
  dependencies: {
    factories: new Map<string, ConfigFactory>([
      ['serverRequestHelpers', () => createServerRequestHelpers()],
      ['responseHelpers', () => createResponseHelpers()],
      ['rateLimitMiddleware', rateLimitMiddlewareServiceFactory()],
    ]),
  },
})();

const rateLimitMiddleware = container.get<Middleware>('rateLimitMiddleware');
```

The config gets validated when the services get created (fail at startup instead of for every request): each key
resolver needs exactly one known type with a non empty string, `points` a positive integer, `duration` and
`blockDuration` an integer between `0` and `2147483` seconds (`RateLimiterMemory` expires its records through
`setTimeout`, which fires immediately for longer delays; register another limiter for longer windows).

The `rateLimitMiddlewareServiceFactory` uses the services `rateLimitKeyResolver` and `rateLimitRateLimiter` of the container if registered, and creates them through the shipped `keyResolverServiceFactory` and `rateLimiterServiceFactory` (a `RateLimiterMemory`) otherwise. Register any of them under its name to replace it (e.g. a `RateLimiterMongo` as `rateLimitRateLimiter`) or to share it with other services.

#### With names

To serve different parts of an api with different limits, the same factories can be registered multiple times with a name: the config is then read from `config.chubbyts.rateLimit.<name>` and the name gets appended to each service id (`rateLimitMiddlewareapi`, `rateLimitRateLimiterapi`, ...).

```ts
const container = createContainerByConfigFactory({
  chubbyts: {
    rateLimit: {
      api: { keys: [{ attribute: 'clientIp' }], points: 1000, duration: 60 },
      login: { keys: [{ attribute: 'clientIp' }], points: 5, duration: 300, blockDuration: 900 },
    } satisfies Record<string, RateLimitConfig>,
  },
  dependencies: {
    factories: new Map<string, ConfigFactory>([
      // serverRequestHelpers and responseHelpers like above
      ['rateLimitMiddlewareapi', rateLimitMiddlewareServiceFactory('api')],
      ['rateLimitMiddlewarelogin', rateLimitMiddlewareServiceFactory('login')],
    ]),
  },
})();

const apiRateLimitMiddleware = container.get<Middleware>('rateLimitMiddlewareapi');
const loginRateLimitMiddleware = container.get<Middleware>('rateLimitMiddlewarelogin');
```

Without an explicit `keyPrefix` a named limiter uses `rlflx:<name>`, so that named limiters sharing one store (e.g. a
redis) do not share their counters.

## Copyright

2026 Dominik Zogg

[1]: https://www.npmjs.com/package/@chubbyts/chubbyts-http-rate-limit
[2]: https://www.npmjs.com/package/@chubbyts/chubbyts-http-types
[3]: https://www.npmjs.com/package/@chubbyts/chubbyts-dic-types
[4]: https://www.npmjs.com/package/@chubbyts/chubbyts-dic-config
[5]: https://www.npmjs.com/package/@chubbyts/chubbyts-dic-config-factory
[6]: https://www.npmjs.com/package/@chubbyts/chubbyts-http
[7]: https://www.npmjs.com/package/rate-limiter-flexible
[8]: https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/
[9]: https://www.npmjs.com/package/@chubbyts/chubbyts-http-error
[10]: https://www.npmjs.com/package/@chubbyts/chubbyts-http-api
