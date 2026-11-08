import type { Container } from '@chubbyts/chubbyts-dic-types/container';
import { createAbstractFactory } from '@chubbyts/chubbyts-dic-config-factory/dic-config-factory';
import type { ResponseHelpers, ServerRequestHelpers } from '@chubbyts/chubbyts-http-types/message-helper';
import type { Middleware } from '@chubbyts/chubbyts-http-types/middleware';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import type { KeyResolver } from './key-resolver.js';
import {
  createAttributeKeyResolver,
  createHeaderKeyResolver,
  createKeyResolver,
  createStaticKeyResolver,
} from './key-resolver.js';
import type { RateLimiter } from './middleware.js';
import { createRateLimitMiddleware } from './middleware.js';

/**
 * One key resolver, see `createHeaderKeyResolver`, `createAttributeKeyResolver` and `createStaticKeyResolver`.
 */
export type KeyResolverConfig =
  /** a header name, e.g. `x-api-key` (not `x-forwarded-for`, see `createHeaderKeyResolver`) */
  | { header: string }
  /** an attribute name, e.g. `clientIp` set by a trusted proxy middleware */
  | { attribute: string }
  /** a fixed key for every request, e.g. `global` as the last entry so that requests without key share one limit */
  | { static: string };

/**
 * The configuration read by the service factories from `config.chubbyts.rateLimit` (or
 * `config.chubbyts.rateLimit.<name>` for named factories), see the options of rate-limiter-flexible's
 * `RateLimiterMemory`.
 */
export type RateLimitConfig = {
  /** the key resolvers in order (first resolved key wins), the last one should resolve for every request */
  keys: Array<KeyResolverConfig>;
  /** maximum of requests per duration, a positive integer */
  points: number;
  /** seconds before the consumed points get reset, 0 never resets (an integer, at most `2147483`, see below) */
  duration: number;
  /**
   * seconds a key gets blocked once it exceeded the points, 0 (default) does not block (an integer, at most `2147483`:
   * `RateLimiterMemory` expires its records through `setTimeout`, which fires immediately above ~24.8 days)
   */
  blockDuration?: number;
  /** prefix of the keys within the store, defaults to `rlflx` (or `rlflx:<name>` for named factories) */
  keyPrefix?: string;
};

// the http-types implementation (e.g. @chubbyts/chubbyts-http) gets shared by all services of the container
const serverRequestHelpersId = 'serverRequestHelpers';
const responseHelpersId = 'responseHelpers';

type Config = {
  chubbyts: {
    rateLimit: RateLimitConfig | Record<string, RateLimitConfig>;
  };
};

// the maximum delay of setTimeout (2^31 - 1 ms) in seconds, RateLimiterMemory expires its records through it and a
// longer delay fires immediately (the limit / block would silently end after a millisecond)
const maxDurationInSeconds = Math.floor(2_147_483_647 / 1000);

const isDuration = (value: unknown): boolean =>
  Number.isInteger(value) && (value as number) >= 0 && (value as number) <= maxDurationInSeconds;

const resolveConfigPath = (name: string): string =>
  name ? `config.chubbyts.rateLimit.${name}` : 'config.chubbyts.rateLimit';

const keyResolverFactories: Record<string, (serverRequestHelpers: ServerRequestHelpers, name: string) => KeyResolver> =
  {
    header: createHeaderKeyResolver,
    attribute: (_, name) => createAttributeKeyResolver(name),
    static: (_, key) => createStaticKeyResolver(key),
  };

const createKeyResolverByConfig = (
  serverRequestHelpers: ServerRequestHelpers,
  keyResolverConfig: KeyResolverConfig,
  path: string,
): KeyResolver => {
  const entries = Object.entries(keyResolverConfig);

  // an unknown key (e.g. a typo, own properties only: `toString` is no resolver) would otherwise silently disable the
  // rate limiting, as would a non string / empty value (fail at build time instead of for every request)
  if (
    entries.length !== 1 ||
    !Object.hasOwn(keyResolverFactories, entries[0][0]) ||
    typeof entries[0][1] !== 'string' ||
    entries[0][1] === ''
  ) {
    throw new Error(
      `Invalid key resolver ${JSON.stringify(keyResolverConfig)} at ${path}, expected one of: ${Object.keys(
        keyResolverFactories,
      )
        .map((type) => `{ "${type}": non empty string }`)
        .join(', ')}`,
    );
  }

  const [type, name] = entries[0];

  return keyResolverFactories[type](serverRequestHelpers, name);
};

export const keyResolverServiceFactory = createAbstractFactory(
  (container: Container, { name, resolveConfig }): KeyResolver => {
    const { keys } = resolveConfig(container.get<Config>('config').chubbyts.rateLimit ?? {});
    const path = `${resolveConfigPath(name)}.keys`;

    // without any key the middleware would fail for every request
    if (!Array.isArray(keys) || keys.length === 0) {
      throw new Error(`Missing key resolvers at ${path}, expected at least one`);
    }

    const serverRequestHelpers = container.get<ServerRequestHelpers>(serverRequestHelpersId);

    return createKeyResolver(
      keys.map((keyResolverConfig, index) =>
        createKeyResolverByConfig(serverRequestHelpers, keyResolverConfig, `${path}[${index}]`),
      ),
    );
  },
);

export const rateLimiterServiceFactory = createAbstractFactory(
  (container: Container, { name, resolveConfig }): RateLimiter => {
    const { points, duration, blockDuration, keyPrefix } = resolveConfig(
      container.get<Config>('config').chubbyts.rateLimit ?? {},
    );
    const path = resolveConfigPath(name);

    // a missing, negative / fractional or too long value would otherwise silently reject everything, produce odd
    // headers or (too long durations) end the limit after a millisecond
    if (!Number.isInteger(points) || points < 1) {
      throw new Error(`Invalid points ${JSON.stringify(points)} at ${path}.points, expected a positive integer`);
    }

    for (const [option, value] of Object.entries({ duration, blockDuration })) {
      if ((option === 'duration' || value !== undefined) && !isDuration(value)) {
        throw new Error(
          `Invalid ${option} ${JSON.stringify(value)} at ${path}.${option}, expected an integer between 0 and ${maxDurationInSeconds} (seconds)`,
        );
      }
    }

    // named limiters sharing one store (e.g. a redis) must not share their counters
    return new RateLimiterMemory({
      points,
      duration,
      blockDuration,
      keyPrefix: keyPrefix ?? (name ? `rlflx:${name}` : undefined),
    });
  },
);

export const rateLimitMiddlewareServiceFactory = createAbstractFactory(
  (container: Container, { resolveDependency }): Middleware => {
    // a registered service wins over the shipped factory, so that any part can be replaced (e.g. a RateLimiterRedis)
    // or shared between services
    return createRateLimitMiddleware(
      container.get<ResponseHelpers>(responseHelpersId),
      resolveDependency(container, 'rateLimitKeyResolver', keyResolverServiceFactory),
      resolveDependency(container, 'rateLimitRateLimiter', rateLimiterServiceFactory),
    );
  },
);
