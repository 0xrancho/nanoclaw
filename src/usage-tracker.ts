import fs from 'fs';
import path from 'path';

export interface UsageEntry {
  timestamp: string;
  groupFolder: string;
  model?: string;
  sessionId?: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

const REPORT_PATH = path.resolve(process.cwd(), 'usage-report.jsonl');

export function appendUsage(entry: UsageEntry): void {
  const line = JSON.stringify(entry) + '\n';
  fs.appendFileSync(REPORT_PATH, line);
}
