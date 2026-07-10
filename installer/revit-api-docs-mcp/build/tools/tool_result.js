export function formatJsonToolResult(payload, options = {}) {
    const result = {
        content: [
            {
                type: "text",
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
export function formatToolFailure(action, error) {
    return formatJsonToolResult({
        success: false,
        state: "failed",
        action,
        error: error instanceof Error ? error.message : String(error),
    }, { isError: true });
}
