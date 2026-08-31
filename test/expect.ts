/**
 * Minimal assertion shim so tests read like Jest/Vitest while running on the
 * dependency-free `node:test` runner. Only the matchers we actually use.
 */
import assert from "node:assert/strict";

export function expect(actual: any) {
  const api = {
    toBe: (expected: unknown) => assert.strictEqual(actual, expected),
    toEqual: (expected: unknown) => assert.deepStrictEqual(actual, expected),
    toBeNull: () => assert.strictEqual(actual, null),
    toBeUndefined: () => assert.strictEqual(actual, undefined),
    toBeGreaterThan: (n: number) => assert.ok(actual > n, `expected ${actual} > ${n}`),
    toHaveLength: (n: number) =>
      assert.strictEqual((actual as { length: number }).length, n),
    toContain: (needle: unknown) => {
      if (typeof actual === "string") {
        assert.ok(actual.includes(needle as string), `expected "${actual}" to contain "${needle}"`);
      } else {
        assert.ok(
          Array.isArray(actual) && actual.includes(needle),
          `expected ${JSON.stringify(actual)} to contain ${JSON.stringify(needle)}`,
        );
      }
    },
    toMatchObject: (expected: Record<string, unknown>) => {
      for (const key of Object.keys(expected)) {
        assert.deepStrictEqual((actual as Record<string, unknown>)?.[key], expected[key], `key "${key}"`);
      }
    },
    toThrow: (expectedError?: unknown) =>
      assert.throws(actual as () => unknown, expectedError as new () => Error | undefined),
    get not() {
      return {
        toBe: (expected: unknown) => assert.notStrictEqual(actual, expected),
        toEqual: (expected: unknown) => assert.notDeepStrictEqual(actual, expected),
        toContain: (needle: unknown) => {
          if (typeof actual === "string") {
            assert.ok(!actual.includes(needle as string));
          } else {
            assert.ok(!(Array.isArray(actual) && actual.includes(needle)));
          }
        },
      };
    },
  };
  return api;
}
