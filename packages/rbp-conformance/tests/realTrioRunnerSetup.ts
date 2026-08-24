// @ts-expect-error -- the runner preflight intentionally stays executable before TypeScript compilation.
import {
  runRealTrioPreflight,
  verifyRealTrioPreflightHandoff,
} from "../scripts/real-trio-runner-preflight.mjs";

/** Dedicated real-trio bootstrap; it deliberately does not share production-suite setup. */
export default function setup(): void {
  if (verifyRealTrioPreflightHandoff() === null) {
    runRealTrioPreflight();
  }
}
