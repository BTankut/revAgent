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

const ACTIVATE_VIEW_ONLY_FIELDS = [
    "closed",
    "Closed",
];

export function stripViewCleanupFields(payload: any, options: { stripActivateOnlyFields?: boolean } = {}) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return payload;
    }

    const clone = { ...payload };
    for (const key of CLEANUP_ONLY_FIELDS) {
        delete clone[key];
    }
    if (options.stripActivateOnlyFields) {
        for (const key of ACTIVATE_VIEW_ONLY_FIELDS) {
            delete clone[key];
        }
    }
    return clone;
}
