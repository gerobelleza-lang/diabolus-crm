// Cost logging — tracks IA usage per level and summarizes for metrics
import type { RouteLevel } from './types.js';

export interface CostEntry {
  timestamp: string;
  level: RouteLevel;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostEur: number;
  query: string;
  success: boolean;
}

export interface CostSummary {
  totalQueries: number;
  byLevel: Record<RouteLevel, { count: number; totalCost: number; avgCost: number }>;
  totalCostEur: number;
  avgCostPerQuery: number;
}

const entries: CostEntry[] = [];

export function logCost(entry: CostEntry): void {
  entries.push(entry);
}

export function getCostSummary(): CostSummary {
  const byLevel: Record<RouteLevel, { count: number; totalCost: number; avgCost: number }> = {
    0: { count: 0, totalCost: 0, avgCost: 0 },
    1: { count: 0, totalCost: 0, avgCost: 0 },
    2: { count: 0, totalCost: 0, avgCost: 0 },
    3: { count: 0, totalCost: 0, avgCost: 0 },
  };

  let totalCost = 0;

  for (const entry of entries) {
    if (entry.success) {
      byLevel[entry.level].count += 1;
      byLevel[entry.level].totalCost += entry.estimatedCostEur;
      totalCost += entry.estimatedCostEur;
    }
  }

  for (const level of [0, 1, 2, 3] as const) {
    if (byLevel[level].count > 0) {
      byLevel[level].avgCost = byLevel[level].totalCost / byLevel[level].count;
    }
  }

  const totalQueries = entries.filter((e) => e.success).length;
  const avgCostPerQuery = totalQueries > 0 ? totalCost / totalQueries : 0;

  return {
    totalQueries,
    byLevel,
    totalCostEur: totalCost,
    avgCostPerQuery,
  };
}

export function clearCosts(): void {
  entries.length = 0;
}

export function getCostLog(): CostEntry[] {
  return [...entries];
}

// Estimadores de coste por modelo (euros, basados en OpenRouter rates)
const MODEL_COSTS: Record<string, { input: number; output: number }> = {
  'openai/gpt-4.1-mini': { input: 0.00015, output: 0.0006 }, // $0.15/$0.60 por 1M tokens
  'anthropic/claude-sonnet-4': { input: 0.003, output: 0.015 }, // $3/$15 per 1M
};

export function estimateCost(
  model: string,
  inputTokens: number = 100,
  outputTokens: number = 50,
): number {
  const rates = MODEL_COSTS[model] || MODEL_COSTS['openai/gpt-4.1-mini'];
  return (inputTokens * rates.input + outputTokens * rates.output) / 1000;
}
