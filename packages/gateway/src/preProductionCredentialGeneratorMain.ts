import { runPreProductionCredentialGenerator } from "./preProductionCredentialGenerator.js";

// Dedicated one-shot entry point: no server, store, composition, or barrel import.
process.exitCode = await runPreProductionCredentialGenerator(
  process.argv.slice(2),
);
