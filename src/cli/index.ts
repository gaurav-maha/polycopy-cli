#!/usr/bin/env node
import { Command } from "commander";
import { registerAuth } from "./commands/auth.js";
import { registerRpc } from "./commands/rpc.js";
import { registerCopytrade } from "./commands/copytrade.js";
import { registerConfig } from "./commands/config.js";
import { registerDecisions } from "./commands/decisions.js";
import { registerDemo } from "./commands/demo.js";
import { registerInit } from "./commands/init.js";
import { registerKillSwitch } from "./commands/kill-switch.js";
import { registerLeader } from "./commands/leader.js";
import { registerLive } from "./commands/live.js";
import { registerOrders } from "./commands/orders.js";
import { registerPositions } from "./commands/positions.js";
import { registerSetupAccount } from "./commands/setup-account.js";
import { registerStatus } from "./commands/status.js";
import { registerVerify } from "./commands/verify.js";
import { registerWallet } from "./commands/wallet.js";

const program = new Command();

program
  .name("polycopy")
  .description("Polymarket CLOB V2 copy-trader CLI")
  .option("--config <path>", "config file path")
  .option("--json", "emit JSON output")
  .option("--verbose", "enable verbose output");

registerCopytrade(program);
registerRpc(program);
registerInit(program);
registerConfig(program);
registerLeader(program);
registerWallet(program);
registerAuth(program);
registerVerify(program);
registerDemo(program);
registerSetupAccount(program);
registerLive(program);
registerStatus(program);
registerDecisions(program);
registerOrders(program);
registerPositions(program);
registerKillSwitch(program);

await program.parseAsync(process.argv);
