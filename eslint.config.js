import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "src-tauri/**", "coverage/**", ".tmp-*/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      // 引入 eslint 的主要目的就是让 hooks 规则真正生效：此前仓库里那条
      // 「react-hooks/exhaustive-deps 的 disable 注释」因为没有 eslint 配置而一直是失效注释
      "react-hooks/rules-of-hooks": "error",
      // 依赖数组问题按提示处理（本项目有若干刻意省略依赖的地方，见各处注释）
      "react-hooks/exhaustive-deps": "warn",
      // 空 catch 在本项目里是刻意的（localStorage/剪贴板不可用时静默），但需带注释
      "no-empty": ["error", { allowEmptyCatch: true }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  }
);
