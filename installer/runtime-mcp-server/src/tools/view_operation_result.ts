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

export function stripViewCleanupFields(payload: any) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return payload;
    }

    const clone = { ...payload };
    for (const key of CLEANUP_ONLY_FIELDS) {
        delete clone[key];
    }
    return clone;
}
