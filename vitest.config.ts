import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 纯逻辑测试：不依赖 DOM（个别涉及 DOM 的用例用最小桩对象）
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
