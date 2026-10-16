import { describe, expect, it } from "vitest";
import type { KeychainAdapter } from "../storage/keychain";
import {
  DEVICE_IDENTITY_KEY,
  DEVICE_ID_KEY,
  clearDeviceIdentity,
  createDeviceIdentity,
  deserializeIdentity,
  loadDeviceIdentity,
  saveDeviceIdentity,
  serializeIdentity,
} from "./device-identity";

/**
 * 设备身份持久化是「私钥不落盘明文 + 跨重启稳定 + 反序列化防篡改」的安全边界。
 * 这些用例锁定：严格字段校验、tenantId 必须显式、提交顺序（镜像先于权威）。
 */
function makeKeychain(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  const writes: string[] = [];
  const kc: KeychainAdapter = {
    async set(key, value) {
      writes.push(key);
      store.set(key, value);
    },
    async get(key) {
      return store.get(key) ?? null;
    },
    async delete(key) {
      store.delete(key);
    },
    isAvailable() {
      return true;
    },
  };
  return { kc, store, writes };
}

describe("createDeviceIdentity", () => {
  it("生成 UUID deviceId + ed25519 密钥对，tenantId 初始 null", () => {
    const id = createDeviceIdentity();
    expect(id.deviceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(id.keyPair.publicKeyBase64.length).toBeGreaterThan(0);
    expect(id.keyPair.privateKeyBase64.length).toBeGreaterThan(0);
    expect(id.tenantId).toBeNull();
  });

  it("每次生成不同 deviceId", () => {
    expect(createDeviceIdentity().deviceId).not.toBe(createDeviceIdentity().deviceId);
  });
});

describe("serialize / deserialize round-trip", () => {
  it("序列化后反序列化保持一致", () => {
    const id = createDeviceIdentity();
    const back = deserializeIdentity(serializeIdentity(id));
    expect(back).toEqual(id);
  });

  it("含 tenantId 的身份也往返一致", () => {
    const id = { ...createDeviceIdentity(), tenantId: "t1" };
    expect(deserializeIdentity(serializeIdentity(id))?.tenantId).toBe("t1");
  });

  it("非法 JSON 返回 null", () => {
    expect(deserializeIdentity("{not json")).toBeNull();
    expect(deserializeIdentity("")).toBeNull();
  });

  it("非对象 JSON 返回 null", () => {
    expect(deserializeIdentity("null")).toBeNull();
    expect(deserializeIdentity('"str"')).toBeNull();
    expect(deserializeIdentity("[1,2]")).toBeNull();
  });

  it("缺 deviceId / 空 deviceId 返回 null", () => {
    const base = JSON.parse(serializeIdentity(createDeviceIdentity()));
    expect(deserializeIdentity(JSON.stringify({ ...base, deviceId: undefined }))).toBeNull();
    expect(deserializeIdentity(JSON.stringify({ ...base, deviceId: "" }))).toBeNull();
    expect(deserializeIdentity(JSON.stringify({ ...base, deviceId: 123 }))).toBeNull();
  });

  it("keyPair 缺失 / 字段不全返回 null（防密钥注入）", () => {
    const base = JSON.parse(serializeIdentity(createDeviceIdentity()));
    expect(deserializeIdentity(JSON.stringify({ ...base, keyPair: null }))).toBeNull();
    expect(deserializeIdentity(JSON.stringify({ ...base, keyPair: {} }))).toBeNull();
    expect(
      deserializeIdentity(
        JSON.stringify({ ...base, keyPair: { publicKeyBase64: "x", privateKeyBase64: "" } }),
      ),
    ).toBeNull();
  });

  it("tenantId 缺失（undefined）返回 null（强制重新注册，无降级）", () => {
    const base = JSON.parse(serializeIdentity(createDeviceIdentity()));
    const { tenantId: _t, ...withoutTenant } = base;
    void _t;
    expect(deserializeIdentity(JSON.stringify(withoutTenant))).toBeNull();
  });

  it("tenantId 允许 null 或非空字符串，空串/其它类型拒绝", () => {
    const base = JSON.parse(serializeIdentity(createDeviceIdentity()));
    expect(deserializeIdentity(JSON.stringify({ ...base, tenantId: null }))).not.toBeNull();
    expect(deserializeIdentity(JSON.stringify({ ...base, tenantId: "t" }))).not.toBeNull();
    expect(deserializeIdentity(JSON.stringify({ ...base, tenantId: "" }))).toBeNull();
    expect(deserializeIdentity(JSON.stringify({ ...base, tenantId: 123 }))).toBeNull();
  });
});

describe("loadDeviceIdentity", () => {
  it("Keychain 无记录返回 null", async () => {
    const { kc } = makeKeychain();
    expect(await loadDeviceIdentity(kc)).toBeNull();
  });

  it("有记录时加载成功", async () => {
    const id = createDeviceIdentity();
    const { kc } = makeKeychain({ [DEVICE_IDENTITY_KEY]: serializeIdentity(id) });
    expect(await loadDeviceIdentity(kc)).toEqual(id);
  });

  it("存储内容被篡改（非法 JSON）返回 null", async () => {
    const { kc } = makeKeychain({ [DEVICE_IDENTITY_KEY]: "corrupt" });
    expect(await loadDeviceIdentity(kc)).toBeNull();
  });
});

describe("saveDeviceIdentity — 原子提交顺序", () => {
  it("先写 device-id 镜像，最后写完整身份（提交标记）", async () => {
    const { kc, writes } = makeKeychain();
    await saveDeviceIdentity(kc, createDeviceIdentity());
    expect(writes).toEqual([DEVICE_ID_KEY, DEVICE_IDENTITY_KEY]);
  });

  it("保存后可被 load 读回（round-trip）", async () => {
    const { kc } = makeKeychain();
    const id = { ...createDeviceIdentity(), tenantId: "t9" };
    await saveDeviceIdentity(kc, id);
    expect(await loadDeviceIdentity(kc)).toEqual(id);
  });

  it("完整身份写入失败时，旧身份仍可加载（不被半提交污染）", async () => {
    const oldId = { ...createDeviceIdentity(), tenantId: "old-tenant" };
    const { kc, store } = makeKeychain({ [DEVICE_IDENTITY_KEY]: serializeIdentity(oldId) });
    // 让第二次 set（完整身份）失败
    let call = 0;
    const failing: KeychainAdapter = {
      ...kc,
      async set(key, value) {
        call++;
        if (call === 2) throw new Error("keychain write failed");
        store.set(key, value);
      },
    };
    const newId = { ...createDeviceIdentity(), tenantId: "new-tenant" };
    await expect(saveDeviceIdentity(failing, newId)).rejects.toThrow();
    // 完整身份未被覆盖 → 仍加载到旧 tenant
    expect((await loadDeviceIdentity(kc))?.tenantId).toBe("old-tenant");
  });
});

describe("clearDeviceIdentity", () => {
  it("删除两个 key", async () => {
    const { kc, store } = makeKeychain();
    await saveDeviceIdentity(kc, createDeviceIdentity());
    await clearDeviceIdentity(kc);
    expect(store.has(DEVICE_IDENTITY_KEY)).toBe(false);
    expect(store.has(DEVICE_ID_KEY)).toBe(false);
  });

  it("幂等：无记录时不抛错", async () => {
    const { kc } = makeKeychain();
    await expect(clearDeviceIdentity(kc)).resolves.toBeUndefined();
  });
});
