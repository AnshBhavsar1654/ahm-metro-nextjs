// jest-dom's matchers for Vitest 3: its own typings augment `vitest`, but Assertion is declared in @vitest/expect.
import type { TestingLibraryMatchers } from "@testing-library/jest-dom/matchers"

declare module "@vitest/expect" {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- declaration merging
  interface Assertion<T = unknown> extends TestingLibraryMatchers<unknown, T> {}
}
