import { runPreProductionSecretHandoffSource } from "./preProductionSecretHandoff.js";

// Dedicated binary stdout entry point: no server, composition, or barrel import.
process.exitCode = await runPreProductionSecretHandoffSource(
  process.argv.slice(2),
);
