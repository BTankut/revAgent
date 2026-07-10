type JsonToolResultOptions = {
    isError?: boolean;
};

export function formatJsonToolResult(payload: unknown, options: JsonToolResultOptions = {}) {
    const result = {
        content: [
            {
                type: "text" as const,
                text: JSON.stringify(payload, null, 2),
            },
        ],
    };
    return options.isError === true
        ? {
            ...result,
            isError: true,
        }
        : result;
}

export function formatToolFailure(action: string, error: unknown) {
    return formatJsonToolResult({
        success: false,
        state: "failed",
        action,
        error: error instanceof Error ? error.message : String(error),
    }, { isError: true });
}
