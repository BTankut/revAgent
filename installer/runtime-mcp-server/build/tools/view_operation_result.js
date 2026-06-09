const CLEANUP_ONLY_FIELDS = [
    "dryRun",
    "DryRun",
    "deleted",
    "Deleted",
    "confirmDelete",
    "ConfirmDelete",
    "targetIsReviewView",
    "TargetIsReviewView",
    "reviewSignals",
    "ReviewSignals",
    "deletedElementCount",
    "DeletedElementCount",
];
const CLOSE_ONLY_FIELDS = [
    "closed",
    "Closed",
];
export function stripViewCleanupFields(payload, options = {}) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return payload;
    }
    const clone = { ...payload };
    for (const key of CLEANUP_ONLY_FIELDS) {
        delete clone[key];
    }
    if (options.stripCloseOnlyFields) {
        for (const key of CLOSE_ONLY_FIELDS) {
            delete clone[key];
        }
    }
    return clone;
}
