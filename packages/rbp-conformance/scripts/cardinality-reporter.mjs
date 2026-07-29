import { writeFileSync } from "node:fs";

function countTests(tasks) {
  return tasks.reduce(
    (total, task) => total +
      (task.type === "test" ? 1 : countTests(Array.isArray(task.tasks) ? task.tasks : [])),
    0,
  );
}

export default class CardinalityReporter {
  onFinished(files = []) {
    const outputPath = process.env.REVAGENT_RBP_CARDINALITY_PATH;
    if (outputPath === undefined) return;
    const report = {
      files: files.length,
      tests: files.reduce(
        (total, file) => total + countTests(Array.isArray(file.tasks) ? file.tasks : []),
        0,
      ),
    };
    writeFileSync(outputPath, `${JSON.stringify(report)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
  }
}
