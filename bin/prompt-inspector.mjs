#!/usr/bin/env node
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { defaultSidecarPath, verifyPromptSidecar, writePromptSidecar } from "../prompt-sidecar.js";

function usage() {
  return "用法: node bin/prompt-inspector.mjs <session.jsonl-or-directory> [--out <dir>] [--max-bytes <n>]";
}

function parseArgs(argv) {
  const positionals = [];
  let output;
  let maxBytes;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--out") {
      output = argv[++index];
      if (!output) throw new Error("--out 需要目录路径");
    } else if (argument === "--max-bytes") {
      const raw = argv[++index];
      if (!raw) throw new Error("--max-bytes 需要正整数");
      maxBytes = Number(raw);
      if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("--max-bytes 必须是大于 0 的安全整数");
    } else if (argument === "--help" || argument === "-h") {
      return { help: true };
    } else if (argument.startsWith("-")) {
      throw new Error("未知选项: " + argument);
    } else {
      positionals.push(argument);
    }
  }
  if (positionals.length !== 1) throw new Error(usage());
  return { input: resolve(positionals[0]), output: output ? resolve(output) : undefined, maxBytes };
}

const main = async () => {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      process.stdout.write(usage() + "\n");
      return;
    }
    await access(args.input, constants.R_OK);
    const output = args.output ?? defaultSidecarPath(args.input);
    const result = await writePromptSidecar(args.input, output, { maxBytes: args.maxBytes });
    const verification = await verifyPromptSidecar(result.outputDir);
    if (!verification.ok) throw new Error(verification.errors.join("；"));
    process.stdout.write(JSON.stringify({
      sourceFiles: result.sourceFiles,
      records: result.recordCount,
      chunks: result.chunkCount,
      outputDir: result.outputDir,
      verified: verification.ok,
    }) + "\n");
  } catch (error) {
    process.stderr.write("Prompt Inspector 失败: " + (error instanceof Error ? error.message : String(error)) + "\n");
    process.stderr.write(usage() + "\n");
    process.exitCode = 1;
  }
};

await main();
