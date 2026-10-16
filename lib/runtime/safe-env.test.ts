import { describe, expect, it } from "vitest";
import { filterEnv } from "./safe-env";

/**
 * safe-env 是 Host 命令执行的环境变量白名单（防密钥泄露 + 防模块注入）。
 * 这些用例锁定：危险变量（NODE_OPTIONS/NODE_PATH/密钥）必须被剔除。
 */
describe("filterEnv — 白名单放行", () => {
  it("基础执行环境变量放行", () => {
    const out = filterEnv({
      PATH: "/usr/bin",
      HOME: "/home/u",
      SHELL: "/bin/zsh",
      TERM: "xterm",
      TMPDIR: "/tmp",
    });
    expect(out.PATH).toBe("/usr/bin");
    expect(out.HOME).toBe("/home/u");
    expect(out.SHELL).toBe("/bin/zsh");
    expect(out.TMPDIR).toBe("/tmp");
  });

  it("locale / 时区 / 色彩放行", () => {
    const out = filterEnv({
      LANG: "zh_CN.UTF-8",
      LC_ALL: "zh_CN.UTF-8",
      TZ: "Asia/Shanghai",
      NO_COLOR: "1",
    });
    expect(out.LANG).toBe("zh_CN.UTF-8");
    expect(out.LC_ALL).toBe("zh_CN.UTF-8");
    expect(out.TZ).toBe("Asia/Shanghai");
    expect(out.NO_COLOR).toBe("1");
  });

  it("npm/pnpm 安全变量放行", () => {
    const out = filterEnv({
      NPM_CONFIG_REGISTRY: "https://r",
      PNPM_HOME: "/p",
      COREPACK_HOME: "/c",
    });
    expect(out.NPM_CONFIG_REGISTRY).toBe("https://r");
    expect(out.PNPM_HOME).toBe("/p");
  });
});

describe("filterEnv — fail-closed 剔除", () => {
  it("未在白名单的变量一律剔除（默认 fail-closed）", () => {
    const out = filterEnv({ RANDOM_VAR: "x", NEXHARNESS_SECRET: "y", MY_APP_CONFIG: "z" });
    expect(out.RANDOM_VAR).toBeUndefined();
    expect(out.NEXHARNESS_SECRET).toBeUndefined();
    expect(out.MY_APP_CONFIG).toBeUndefined();
  });

  it("NODE_OPTIONS 被剔除（已知代码执行攻击向量）", () => {
    expect(filterEnv({ NODE_OPTIONS: "--require=/tmp/evil.js" }).NODE_OPTIONS).toBeUndefined();
  });

  it("NODE_PATH 被剔除（模块注入攻击向量）", () => {
    expect(filterEnv({ NODE_PATH: "/tmp/evil" }).NODE_PATH).toBeUndefined();
  });

  it("NPM_CONFIG_SCRIPT_SHELL 被剔除（可替换 shell）", () => {
    expect(
      filterEnv({ NPM_CONFIG_SCRIPT_SHELL: "/tmp/evil.sh" }).NPM_CONFIG_SCRIPT_SHELL,
    ).toBeUndefined();
  });
});

describe("filterEnv — 敏感名双保险", () => {
  it("名字含 SECRET/TOKEN/PASSWORD/KEY 等的变量被剔除", () => {
    // 即便这些名字恰好匹配某白名单前缀，也必须被敏感词拦下
    for (const name of [
      "AWS_SECRET_ACCESS_KEY",
      "GITHUB_TOKEN",
      "DB_PASSWORD",
      "MY_PRIVATE_KEY",
      "API_KEY",
      "DATABASE_URL",
      "CONN_STRING",
      "REGISTRY_TOKEN",
    ]) {
      expect(filterEnv({ [name]: "leak" })[name]).toBeUndefined();
    }
  });

  it("大小写不敏感", () => {
    expect(filterEnv({ my_secret_token: "x" }).my_secret_token).toBeUndefined();
    expect(filterEnv({ My_Password: "x" }).My_Password).toBeUndefined();
  });

  it("白名单前缀 + 敏感名同时命中时以敏感名优先（剔除）", () => {
    // CI 在白名单里，但 CI_SECRET_TOKEN 含 TOKEN → 剔除
    expect(filterEnv({ CI: "1" }).CI).toBe("1");
    expect(filterEnv({ CI_TOKEN: "x" }).CI_TOKEN).toBeUndefined();
  });
});

describe("filterEnv — 显式注入", () => {
  it("注入值叠加且优先（调用方明确知情）", () => {
    const out = filterEnv({ PATH: "/usr/bin" }, { PATH: "/custom/bin" });
    expect(out.PATH).toBe("/custom/bin");
  });

  it("注入可带非白名单变量（绕过白名单是有意为之）", () => {
    const out = filterEnv({}, { NODE_OPTIONS: "--max-old-space-size=4096" });
    expect(out.NODE_OPTIONS).toBe("--max-old-space-size=4096");
  });

  it("多个注入依次叠加，后者覆盖前者", () => {
    const out = filterEnv({}, { A: "1" }, { A: "2", B: "3" });
    expect(out.A).toBe("2");
    expect(out.B).toBe("3");
  });

  it("undefined 注入被跳过（不产生 undefined 值）", () => {
    const out = filterEnv({ PATH: "/u" }, undefined, { X: "1" });
    expect(out.X).toBe("1");
    expect("undefined" in out).toBe(false);
  });

  it("source 中 undefined 值被跳过", () => {
    const out = filterEnv({ PATH: undefined, HOME: "/h" } as Record<string, string | undefined>);
    expect(out.PATH).toBeUndefined();
    expect(out.HOME).toBe("/h");
  });
});

describe("filterEnv — 边界", () => {
  it("空 source 返回空对象（除非有注入）", () => {
    expect(filterEnv({})).toEqual({});
  });

  it("不修改入参", () => {
    const source = { PATH: "/u", SECRET_KEY: "s" };
    filterEnv(source);
    expect(source.SECRET_KEY).toBe("s");
  });

  it("返回的是新对象", () => {
    const out = filterEnv({ PATH: "/u" });
    expect(out).not.toBe(undefined);
    expect(Object.keys(out)).toEqual(["PATH"]);
  });
});
