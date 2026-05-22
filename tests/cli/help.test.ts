import { execaNode } from "../helpers/execa-node.js";

describe("CLI help", () => {
  const helpCommands: Array<[string[]]> = [
    [[]],
    [["init", "--help"]],
    [["config", "--help"]],
    [["leader", "--help"]],
    [["decisions", "--help"]],
    [["orders", "--help"]],
    [["positions", "--help"]],
    [["kill-switch", "--help"]],
    [["verify", "--help"]],
    [["demo", "--help"]],
    [["copytrade", "--help"]],
    [["wallet", "--help"]],
    [["auth", "--help"]],
    [["rpc", "add", "--help"]],
    [["rpc", "list", "--help"]],
    [["setup-account", "--help"]],
    [["live", "--help"]],
    [["status", "--help"]]
  ];

  it.each(helpCommands)("prints help for %j", async (args) => {
    const result = await execaNode(args.length === 0 ? ["--help"] : args);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage:");
  });
});
