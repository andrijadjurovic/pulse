"use strict";

const vm = require("node:vm");

const MAX_INPUT_BYTES = 256 * 1024;
const MAX_SCRIPT_BYTES = 8 * 1024;
const EXECUTION_TIMEOUT_MS = 5000;

function readInput() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    process.stdin.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_INPUT_BYTES) {
        reject(new Error("Sandbox input exceeds 256 KiB."));
        process.stdin.destroy();
        return;
      }
      chunks.push(chunk);
    });
    process.stdin.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("Sandbox input is not valid JSON."));
      }
    });
    process.stdin.on("error", reject);
  });
}

function execute(customScript, response) {
  if (typeof customScript !== "string" || Buffer.byteLength(customScript, "utf8") > MAX_SCRIPT_BYTES) {
    throw new Error("Custom JavaScript must be at most 8 KiB.");
  }

  const serializedResponse = JSON.stringify(response);
  const source = `
    const response = JSON.parse(${JSON.stringify(serializedResponse)});
    (function freezeDeep(value) {
      if (value && typeof value === "object" && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const key of Object.keys(value)) freezeDeep(value[key]);
      }
    })(response);
    (function (response) {
      "use strict";
      ${customScript}
    })(response);
  `;
  const context = vm.createContext(Object.create(null), {
    codeGeneration: { strings: false, wasm: false },
    microtaskMode: "afterEvaluate",
  });
  const result = new vm.Script(source, { filename: "custom-check.js" }).runInContext(context, {
    timeout: EXECUTION_TIMEOUT_MS,
    breakOnSigint: true,
  });
  if (typeof result !== "boolean") {
    throw new Error("Custom check must return true or false synchronously.");
  }
  return result;
}

async function main() {
  try {
    const input = await readInput();
    const passed = execute(input.customScript, input.response);
    process.stdout.write(JSON.stringify({ ok: true, passed }));
  } catch (error) {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: String(error.message || "Custom check failed.").slice(0, 300),
    }));
    process.exitCode = 1;
  }
}

main().catch(() => {
  process.stdout.write(JSON.stringify({ ok: false, error: "Custom sandbox failed." }));
  process.exitCode = 1;
});
