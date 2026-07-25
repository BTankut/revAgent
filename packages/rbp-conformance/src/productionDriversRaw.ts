import {
  createRawBindingStepHooks,
  type RawBindingStepHookOptions,
  type RawHttpSseBindingDriverOptions,
  type RawWssBindingDriverOptions,
} from "./rawBindingDrivers.js";
import { rawProductionOpeningHello } from "./productionCaseSeedsRaw.js";
import type { RawBindingStepHooks } from "./parentStepEngine.js";

export interface RawProductionBindingDriverOptions {
  readonly wss?: Omit<RawWssBindingDriverOptions, "openingHello">;
  readonly streamableHttpSse?: Omit<RawHttpSseBindingDriverOptions, "openingHello">;
}

/**
 * Installs the deterministic per-step opening hello required by the C25-C40
 * catalog. Both raw bindings still retain their normal pinned-TLS and
 * numeric-loopback enforcement.
 */
export function createRawProductionBindingStepHooks(
  options: RawProductionBindingDriverOptions,
): RawBindingStepHooks {
  const configured: RawBindingStepHookOptions = {
    ...(options.wss === undefined
      ? {}
      : {
          wss: {
            ...options.wss,
            openingHello: rawProductionOpeningHello,
          },
        }),
    ...(options.streamableHttpSse === undefined
      ? {}
      : {
          streamableHttpSse: {
            ...options.streamableHttpSse,
            openingHello: rawProductionOpeningHello,
          },
        }),
  };
  return createRawBindingStepHooks(configured);
}
