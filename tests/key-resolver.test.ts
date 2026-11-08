import { describe, expect, test } from 'vitest';
import { useFunctionMock } from '@chubbyts/chubbyts-function-mock/function-mock';
import { createServerRequestFactory } from '@chubbyts/chubbyts-http/message-factory';
import { createServerRequestHelpers } from '@chubbyts/chubbyts-http/message-helper';
import type { KeyResolver } from '../src/key-resolver.js';
import {
  createAttributeKeyResolver,
  createHeaderKeyResolver,
  createKeyResolver,
  createStaticKeyResolver,
} from '../src/key-resolver.js';

// @chubbyts/chubbyts-http is used as implementation of the types

const serverRequestFactory = createServerRequestFactory();
const serverRequestHelpers = createServerRequestHelpers();

const createRequest = (
  headers: Record<string, string | Array<string>> = {},
  attributes: Record<string, unknown> = {},
) =>
  Object.entries(attributes).reduce(
    (request, [name, value]) => serverRequestHelpers.withAttribute(request, name, value),
    Object.entries(headers).reduce(
      (request, [name, value]) => serverRequestHelpers.withHeader(request, name, value),
      serverRequestFactory('GET', 'https://example.com'),
    ),
  );

describe('key-resolver', () => {
  describe('createHeaderKeyResolver', () => {
    test('without header', () => {
      expect(createHeaderKeyResolver(serverRequestHelpers, 'x-api-key')(createRequest())).toBeUndefined();
    });

    test('with empty header', () => {
      expect(
        createHeaderKeyResolver(serverRequestHelpers, 'x-api-key')(createRequest({ 'x-api-key': '' })),
      ).toBeUndefined();
    });

    test('with blank header', () => {
      expect(
        createHeaderKeyResolver(serverRequestHelpers, 'x-api-key')(createRequest({ 'x-api-key': '   ' })),
      ).toBeUndefined();
    });

    test('with single value', () => {
      expect(
        createHeaderKeyResolver(serverRequestHelpers, 'X-Real-IP')(createRequest({ 'x-real-ip': '203.0.113.1' })),
      ).toBe('203.0.113.1');
    });

    test('with value, the value is the key as is (no list splitting)', () => {
      expect(
        createHeaderKeyResolver(serverRequestHelpers, 'x-api-key')(createRequest({ 'x-api-key': ' key,with,commas ' })),
      ).toBe('key,with,commas');
    });

    test('with multiple values, joined', () => {
      expect(
        createHeaderKeyResolver(serverRequestHelpers, 'x-api-key')(createRequest({ 'x-api-key': ['key-1', 'key-2'] })),
      ).toBe('key-1, key-2');
    });
  });

  describe('createAttributeKeyResolver', () => {
    test('without attribute', () => {
      expect(createAttributeKeyResolver('clientIp')(createRequest())).toBeUndefined();
    });

    test('with empty attribute', () => {
      expect(createAttributeKeyResolver('clientIp')(createRequest({}, { clientIp: '' }))).toBeUndefined();
    });

    test('with non string attribute', () => {
      expect(createAttributeKeyResolver('clientIp')(createRequest({}, { clientIp: 42 }))).toBeUndefined();
    });

    test('with attribute', () => {
      expect(createAttributeKeyResolver('clientIp')(createRequest({}, { clientIp: '203.0.113.1' }))).toBe(
        '203.0.113.1',
      );
    });
  });

  describe('createStaticKeyResolver', () => {
    test('with key', () => {
      expect(createStaticKeyResolver('global')(createRequest())).toBe('global');
    });
  });

  describe('createKeyResolver', () => {
    test('without resolvers', async () => {
      expect(await createKeyResolver([])(createRequest())).toBeUndefined();
    });

    test('without match', async () => {
      const request = createRequest();

      const [keyResolver1, keyResolver1Mocks] = useFunctionMock<KeyResolver>([
        { parameters: [request], return: undefined },
      ]);

      const [keyResolver2, keyResolver2Mocks] = useFunctionMock<KeyResolver>([
        { parameters: [request], return: undefined },
      ]);

      expect(await createKeyResolver([keyResolver1, keyResolver2])(request)).toBeUndefined();

      expect(keyResolver1Mocks).toHaveLength(0);
      expect(keyResolver2Mocks).toHaveLength(0);
    });

    test('with match, the first key wins', async () => {
      const request = createRequest();

      const [keyResolver1, keyResolver1Mocks] = useFunctionMock<KeyResolver>([
        { parameters: [request], return: undefined },
      ]);

      const [keyResolver2, keyResolver2Mocks] = useFunctionMock<KeyResolver>([
        { parameters: [request], return: '203.0.113.1' },
      ]);

      const [keyResolver3, keyResolver3Mocks] = useFunctionMock<KeyResolver>([]);

      expect(await createKeyResolver([keyResolver1, keyResolver2, keyResolver3])(request)).toBe('203.0.113.1');

      expect(keyResolver1Mocks).toHaveLength(0);
      expect(keyResolver2Mocks).toHaveLength(0);
      expect(keyResolver3Mocks).toHaveLength(0);
    });

    test('with async resolvers', async () => {
      const request = createRequest();

      const [keyResolver1, keyResolver1Mocks] = useFunctionMock<KeyResolver>([
        { parameters: [request], return: Promise.resolve(undefined) },
      ]);

      const [keyResolver2, keyResolver2Mocks] = useFunctionMock<KeyResolver>([
        { parameters: [request], return: Promise.resolve('tenant-1') },
      ]);

      expect(await createKeyResolver([keyResolver1, keyResolver2])(request)).toBe('tenant-1');

      expect(keyResolver1Mocks).toHaveLength(0);
      expect(keyResolver2Mocks).toHaveLength(0);
    });
  });
});
