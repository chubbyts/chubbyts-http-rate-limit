import type { ServerRequest } from '@chubbyts/chubbyts-http-types/message';
import type { MessageHelpers } from '@chubbyts/chubbyts-http-types/message-helper';

/**
 * Resolves the key a request gets counted under (usually the client ip), `undefined` means "not resolved" (the next
 * resolver of a `createKeyResolver` chain gets asked, the middleware fails if none resolves). May be async, e.g. to
 * map an api key to a tenant.
 */
export type KeyResolver = (request: ServerRequest) => string | undefined | Promise<string | undefined>;

/**
 * Resolves the key from the given (case insensitive) header, e.g. `x-api-key`. The header value is the key as is
 * (multiple values joined with `, `, surrounding whitespace removed), empty headers get ignored.
 *
 * Do not use it for forwarded headers like `x-forwarded-for`: every proxy *appends* the address it saw, so the first
 * entry is whatever the client sent (freely spoofable). Use a trusted proxy middleware in front, which sets the client
 * ip as attribute, and `createAttributeKeyResolver('clientIp')` instead.
 */
export const createHeaderKeyResolver = (messageHelpers: MessageHelpers, name: string): KeyResolver => {
  return (request: ServerRequest): string | undefined => {
    return messageHelpers.getHeaderLine(request, name).trim() || undefined;
  };
};

/**
 * Resolves the key from the given request attribute, e.g. a `clientIp` set by a trusted proxy middleware or a `userId`
 * set by an authentication middleware. Non string / empty attributes get ignored.
 */
export const createAttributeKeyResolver = (name: string): KeyResolver => {
  return (request: ServerRequest): string | undefined => {
    const value = request.attributes[name];

    return typeof value === 'string' && value !== '' ? value : undefined;
  };
};

/**
 * Resolves the given key for every request, e.g. `global` as the last resolver of a chain: requests without any
 * other key then share one (global) limit instead of passing unlimited.
 */
export const createStaticKeyResolver = (key: string): KeyResolver => {
  return (): string => key;
};

/**
 * Chains the given resolvers, the first resolved key wins.
 */
export const createKeyResolver = (keyResolvers: Array<KeyResolver>): KeyResolver => {
  return async (request: ServerRequest): Promise<string | undefined> => {
    for (const keyResolver of keyResolvers) {
      const key = await keyResolver(request);

      if (key !== undefined) {
        return key;
      }
    }

    return undefined;
  };
};
