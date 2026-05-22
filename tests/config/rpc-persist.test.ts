import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addPersistedRpc,
  assertRpcUrl,
  readPersistedRpcs,
  removePersistedRpc,
  resolveRpcUrl,
  resolveRpcUrls,
  rpcProvidersFromUrls,
  writePersistedRpc
} from "../../src/config/rpc-persist.js";

describe("rpc persistence", () => {
  let dir: string;
  let rpcPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "polycopy-rpc-persist-"));
    rpcPath = join(dir, "rpc.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes and reads multiple persisted rpc urls", async () => {
    await writePersistedRpc("https://polygon.example/primary", rpcPath);
    const saved = await addPersistedRpc("https://polygon.example/fallback", rpcPath);
    expect(saved.urls).toEqual(["https://polygon.example/primary", "https://polygon.example/fallback"]);
    expect(await readPersistedRpcs(rpcPath)).toMatchObject({ urls: saved.urls });
  });

  it("dedupes rpc urls case-insensitively", async () => {
    await addPersistedRpc("https://polygon.example/RPC", rpcPath);
    const saved = await addPersistedRpc("https://polygon.example/rpc", rpcPath);
    expect(saved.urls).toEqual(["https://polygon.example/RPC"]);
  });

  it("resolves persisted rpcs before env fallback", async () => {
    await writePersistedRpc("https://saved.example/rpc", rpcPath);
    await expect(
      resolveRpcUrls({ path: rpcPath, env: { POLYGON_RPC_PRIMARY: "https://env.example/rpc" } })
    ).resolves.toEqual(["https://saved.example/rpc"]);
    await expect(resolveRpcUrl({ path: rpcPath })).resolves.toBe("https://saved.example/rpc");
  });

  it("maps multiple urls to rpc providers", () => {
    expect(rpcProvidersFromUrls(["https://a.example", "https://b.example", "https://c.example"])).toEqual([
      { name: "primary", url: "https://a.example", maxLagMs: 30_000, maxLagBlocks: 1 },
      { name: "fallback", url: "https://b.example", maxLagMs: 30_000, maxLagBlocks: 1 },
      { name: "fallback-2", url: "https://c.example", maxLagMs: 30_000, maxLagBlocks: 1 }
    ]);
  });

  it("removes a configured rpc url", async () => {
    await addPersistedRpc("https://polygon.example/primary", rpcPath);
    await addPersistedRpc("https://polygon.example/fallback", rpcPath);
    const saved = await removePersistedRpc("https://polygon.example/fallback", rpcPath);
    expect(saved.urls).toEqual(["https://polygon.example/primary"]);
  });

  it("clears persisted rpcs when removing the last url", async () => {
    await addPersistedRpc("https://polygon.example/primary", rpcPath);
    const saved = await removePersistedRpc("https://polygon.example/primary", rpcPath);
    expect(saved.urls).toEqual([]);
    await expect(readPersistedRpcs(rpcPath)).resolves.toBeUndefined();
  });

  it("rejects invalid rpc urls", () => {
    expect(() => assertRpcUrl("polygon.example")).toThrow(/http/i);
  });
});
