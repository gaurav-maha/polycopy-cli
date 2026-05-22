import { Command } from "commander";
import {
  addPersistedRpc,
  readPersistedRpcs,
  removePersistedRpc,
  resolveRpcPath
} from "../../config/rpc-persist.js";
import { EXIT_CODES } from "../../errors/exit-codes.js";

function wantsJson(program: Command): boolean {
  return Boolean(program.optsWithGlobals().json);
}

function roleForIndex(index: number): string {
  if (index === 0) return "primary";
  if (index === 1) return "fallback";
  return `fallback-${index}`;
}

function emitRpcSuccess(program: Command, payload: Record<string, unknown>, humanText: string): void {
  if (wantsJson(program)) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }
  process.stdout.write(`${humanText}\n`);
}

function emitRpcFailure(program: Command, command: string, error: string, reason: string): never {
  if (wantsJson(program)) {
    process.stdout.write(`${JSON.stringify({ ok: false, command, error, reason })}\n`);
  } else {
    process.stderr.write(`${reason}\n`);
  }
  process.exit(EXIT_CODES.USAGE_OR_CONFIG);
}

export function registerRpc(program: Command): void {
  const rpc = program.command("rpc").description("Manage persisted Polygon RPC URLs");

  rpc
    .command("add")
    .description("Add a Polygon HTTP RPC URL")
    .argument("<url>", "Polygon RPC URL")
    .action(async (url: string) => {
      try {
        const saved = await addPersistedRpc(url);
        const path = resolveRpcPath();
        const role = roleForIndex(saved.urls.length - 1);
        emitRpcSuccess(
          program,
          { ok: true, command: "rpc add", path, ...saved },
          `Saved ${role} RPC: ${saved.urls[saved.urls.length - 1]}\nRPC file: ${path}`
        );
      } catch (error) {
        emitRpcFailure(program, "rpc add", "RPC_ADD_FAILED", error instanceof Error ? error.message : String(error));
      }
    });

  rpc
    .command("list")
    .description("List persisted Polygon RPC URLs")
    .action(async () => {
      const path = resolveRpcPath();
      const saved = await readPersistedRpcs(path);
      if (!saved) {
        emitRpcFailure(program, "rpc list", "RPC_NOT_CONFIGURED", "run polycopy rpc add <url>");
      }
      emitRpcSuccess(
        program,
        {
          ok: true,
          command: "rpc list",
          path,
          urls: saved!.urls,
          primary: saved!.urls[0],
          updatedAt: saved!.updatedAt
        },
        [`RPC file: ${path}`, ...saved!.urls.map((url, index) => `${index + 1}. ${roleForIndex(index)} ${url}`)].join("\n")
      );
    });

  rpc
    .command("remove")
    .description("Remove a persisted Polygon RPC URL")
    .argument("<url>", "Polygon RPC URL")
    .action(async (url: string) => {
      try {
        const saved = await removePersistedRpc(url);
        const path = resolveRpcPath();
        emitRpcSuccess(
          program,
          { ok: true, command: "rpc remove", path, ...saved },
          `Removed RPC URL. Remaining RPCs: ${saved.urls.length}\nRPC file: ${path}`
        );
      } catch (error) {
        emitRpcFailure(program, "rpc remove", "RPC_REMOVE_FAILED", error instanceof Error ? error.message : String(error));
      }
    });

  rpc
    .command("show")
    .description("Print the primary persisted Polygon RPC URL")
    .action(async () => {
      const path = resolveRpcPath();
      const saved = await readPersistedRpcs(path);
      if (!saved) {
        emitRpcFailure(program, "rpc show", "RPC_NOT_CONFIGURED", "run polycopy rpc add <url>");
      }
      emitRpcSuccess(
        program,
        {
          ok: true,
          command: "rpc show",
          path,
          url: saved!.urls[0],
          urls: saved!.urls,
          updatedAt: saved!.updatedAt
        },
        `${saved!.urls[0]}\nRPC file: ${path}`
      );
    });

  rpc
    .command("path")
    .description("Print the persisted RPC file path")
    .action(() => {
      const path = resolveRpcPath();
      emitRpcSuccess(program, { ok: true, path }, path);
    });
}
