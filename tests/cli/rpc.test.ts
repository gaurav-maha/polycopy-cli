import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execaNode } from "../helpers/execa-node.js";

describe("rpc CLI", () => {
  let dir: string;
  let rpcPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "polycopy-rpc-"));
    rpcPath = join(dir, "rpc.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("adds, lists, removes, and clears rpc urls", async () => {
    const primary = "https://polygon.example/primary";
    const fallback = "https://polygon.example/fallback";

    const addPrimary = await execaNode(["--json", "rpc", "add", primary], { rpcPath });
    expect(JSON.parse(addPrimary.stdout)).toMatchObject({ ok: true, urls: [primary] });

    const addFallback = await execaNode(["--json", "rpc", "add", fallback], { rpcPath });
    expect(JSON.parse(addFallback.stdout)).toMatchObject({ ok: true, urls: [primary, fallback] });

    const list = await execaNode(["--json", "rpc", "list"], { rpcPath });
    expect(JSON.parse(list.stdout)).toMatchObject({ ok: true, urls: [primary, fallback], primary });

    const show = await execaNode(["--json", "rpc", "show"], { rpcPath });
    expect(JSON.parse(show.stdout)).toMatchObject({ ok: true, url: primary, urls: [primary, fallback] });

    const removeFallback = await execaNode(["--json", "rpc", "remove", fallback], { rpcPath });
    expect(JSON.parse(removeFallback.stdout)).toMatchObject({ ok: true, urls: [primary] });

    const removePrimary = await execaNode(["--json", "rpc", "remove", primary], { rpcPath });
    expect(JSON.parse(removePrimary.stdout)).toMatchObject({ ok: true, urls: [] });
    await expect(stat(rpcPath)).rejects.toMatchObject({ code: "ENOENT" });

    const addReplacement = await execaNode(["--json", "rpc", "add", fallback], { rpcPath });
    expect(JSON.parse(addReplacement.stdout)).toMatchObject({ ok: true, urls: [fallback] });

    const file = JSON.parse(await readFile(rpcPath, "utf8"));
    expect(file.urls).toEqual([fallback]);
  });

  it("does not expose rpc set", async () => {
    const result = await execaNode(["--json", "rpc", "set", "https://polygon.example/primary"], {
      reject: false,
      rpcPath
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/unknown command/i);
  });
});
