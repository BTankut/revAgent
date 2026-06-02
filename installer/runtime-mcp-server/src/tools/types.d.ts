import type { z } from "zod";

export type ToolSchema = Record<string, z.ZodTypeAny>;
export type ToolArgs<Args extends ToolSchema> = z.infer<z.ZodObject<Args>>;
export type ToolHandler<Args extends ToolSchema> = (
    args: ToolArgs<Args>,
    extra: unknown
) => unknown;

export interface ToolServer {
    tool<Args extends ToolSchema>(
        name: string,
        paramsSchema: Args,
        cb: ToolHandler<Args>
    ): unknown;
    tool<Args extends ToolSchema>(
        name: string,
        description: string,
        paramsSchema: Args,
        cb: ToolHandler<Args>
    ): unknown;
}
