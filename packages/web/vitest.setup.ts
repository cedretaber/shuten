import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// このリポジトリは globals: true を使わないので、自動 cleanup が登録されない（決定 19）。
afterEach(() => {
  cleanup();
});
