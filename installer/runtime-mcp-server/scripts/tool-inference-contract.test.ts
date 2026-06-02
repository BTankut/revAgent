import { z } from "zod";
import { wrapServerWithTelemetry } from "../src/utils/telemetry.js";
import type { ToolServer } from "../src/tools/types.js";

type IsAny<T> = 0 extends (1 & T) ? true : false;
type AssertNotAny<T> = IsAny<T> extends true ? never : true;

const baseServer: ToolServer = {
    tool: ((..._args: unknown[]) => ({})) as ToolServer["tool"],
};

const wrappedServer = wrapServerWithTelemetry(baseServer);

wrappedServer.tool(
    "tool_inference_contract",
    "Compile-time guard proving telemetry wrapper preserves schema inference.",
    {
        taskName: z.string().optional(),
        count: z.number().int(),
    },
    async (args) => {
        const _argsNotAny: AssertNotAny<typeof args> = true;
        const taskName: string | undefined = args.taskName;
        const count: number = args.count;

        void _argsNotAny;
        void taskName;
        void count;

        // @ts-expect-error Schema inference must reject fields outside the tool schema.
        void args.notInSchema;

        return {
            content: [
                {
                    type: "text",
                    text: "ok",
                },
            ],
        };
    }
);
