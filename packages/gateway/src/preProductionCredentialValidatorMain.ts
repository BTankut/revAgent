import { runPreProductionCredentialValidator } from "./preProductionCredentialValidator.js";

// Dedicated one-shot entry point: no server, store, composition, or barrel import.
process.exitCode = await runPreProductionCredentialValidator(
  process.argv.slice(2),
);
