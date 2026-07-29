import { performance } from "node:perf_hooks";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

export interface ToolCatalogTimingSummary {
  iterations: number;
  minMs: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  samplesMs: number[];
}

export interface ToolCatalogMeasurement {
  endpoint: string;
  observedToolCount: number;
  toolNames: string[];
  connectMs: number;
  listTools: ToolCatalogTimingSummary;
}

function roundMs(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function percentile(sortedValues: number[], fraction: number): number {
  const index = Math.max(0, Math.ceil(sortedValues.length * fraction) - 1);
  return sortedValues[index] ?? 0;
}

function summarize(samples: number[]): ToolCatalogTimingSummary {
  const sorted = [...samples].sort((left, right) => left - right);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    iterations: sorted.length,
    minMs: roundMs(sorted[0] ?? 0),
    meanMs: roundMs(total / sorted.length),
    p50Ms: roundMs(percentile(sorted, 0.5)),
    p95Ms: roundMs(percentile(sorted, 0.95)),
    maxMs: roundMs(sorted.at(-1) ?? 0),
    samplesMs: samples.map(roundMs),
  };
}

export async function measureToolCatalog(
  endpoint: URL,
  iterations = 1,
): Promise<ToolCatalogMeasurement> {
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 1_000) {
    throw new RangeError("iterations must be an integer between 1 and 1000");
  }

  const client = new Client({
    name: "revAgent W1-5 external probe",
    version: "0.0.0-m0",
  });
  const transport = new StreamableHTTPClientTransport(endpoint);
  const connectStarted = performance.now();

  try {
    await client.connect(transport);
    const connectMs = roundMs(performance.now() - connectStarted);
    const samples: number[] = [];
    let toolNames: string[] = [];

    for (let index = 0; index < iterations; index += 1) {
      const listStarted = performance.now();
      const result = await client.listTools();
      samples.push(performance.now() - listStarted);

      const currentNames = result.tools.map((tool) => tool.name).sort();
      if (index === 0) {
        toolNames = currentNames;
      } else if (currentNames.join("\n") !== toolNames.join("\n")) {
        throw new Error("tool catalog changed during the latency measurement");
      }
    }

    return {
      endpoint: endpoint.toString(),
      observedToolCount: toolNames.length,
      toolNames,
      connectMs,
      listTools: summarize(samples),
    };
  } finally {
    await client.close();
  }
}
