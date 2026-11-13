import { describe, expect, it } from "vitest";
import { parseModelMatrix, varianceReport, type BenchModelRun, type BenchResult } from "../../bench/runners/run.js";

function result(caseId: string, score: number | null, extra: Partial<BenchResult> = {}): BenchResult {
  return {
    caseId,
    status: score === null ? "not-evaluated" : "evaluated",
    invariantsMet: [],
    invariantsMissed: [],
    forbiddenSeen: [],
    artifactsPresent: [],
    dimensionScores: {},
    score,
    ...extra,
  };
}

describe("the model matrix", () => {
  it("parses a comma-separated list, preserving order and dropping blanks and duplicates", () => {
    expect(parseModelMatrix(undefined)).toEqual([]);
    expect(parseModelMatrix("")).toEqual([]);
    expect(parseModelMatrix(" provider/a , provider/b ,provider/a,, ")).toEqual(["provider/a", "provider/b"]);
  });

  it("reports the per-case spread across models and the mean spread", () => {
    const runs: BenchModelRun[] = [
      { model: "a", results: [result("CASE-1", 1), result("CASE-2", 0.8), result("CASE-3", null)] },
      { model: "b", results: [result("CASE-1", 0.5), result("CASE-2", 0.8), result("CASE-3", 1)] },
    ];
    const report = varianceReport(runs);
    expect(report.models).toEqual(["a", "b"]);
    expect(report.meanByModel).toEqual({ a: 0.9, b: 0.77 });
    expect(report.perCase.find((c) => c.caseId === "CASE-1")?.spread).toBe(0.5);
    expect(report.perCase.find((c) => c.caseId === "CASE-2")?.spread).toBe(0);
    // One model did not complete CASE-3, so that case has no spread: a
    // missing run is not a zero.
    expect(report.perCase.find((c) => c.caseId === "CASE-3")?.spread).toBeNull();
    expect(report.meanSpread).toBe(0.25);
  });

  it("excludes incomplete and not-evaluated runs from both the means and the spread", () => {
    const runs: BenchModelRun[] = [
      { model: "a", results: [result("CASE-1", 1), result("CASE-2", 0.4, { incomplete: true })] },
      { model: "b", results: [result("CASE-1", 1), result("CASE-2", null)] },
    ];
    const report = varianceReport(runs);
    expect(report.meanByModel).toEqual({ a: 1, b: 1 });
    expect(report.perCase.find((c) => c.caseId === "CASE-2")?.spread).toBeNull();
    expect(report.meanSpread).toBe(0);
  });

  it("reports no spread when only one model produced a complete score", () => {
    const report = varianceReport([{ model: "a", results: [result("CASE-1", 1)] }]);
    expect(report.meanByModel).toEqual({ a: 1 });
    expect(report.meanSpread).toBeNull();
  });
});
