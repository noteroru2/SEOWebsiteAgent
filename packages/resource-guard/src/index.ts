import { freemem, loadavg, cpus } from 'node:os';
import { statfs } from 'node:fs/promises';
import { z } from 'zod';

export type ResourceSnapshot = {
  freeMemoryMb: number;
  freeDiskMb: number;
  loadPerCpu: number | null;
  platform: NodeJS.Platform;
};
export interface ResourceCollector {
  collect(path?: string): Promise<ResourceSnapshot>;
}

export class SystemResourceCollector implements ResourceCollector {
  async collect(path = process.cwd()): Promise<ResourceSnapshot> {
    const disk = await statfs(path);
    const cpuCount = Math.max(cpus().length, 1);
    const oneMinuteLoad = loadavg()[0] ?? 0;
    return {
      freeMemoryMb: freemem() / 1024 / 1024,
      freeDiskMb: (Number(disk.bavail) * Number(disk.bsize)) / 1024 / 1024,
      loadPerCpu: process.platform === 'win32' ? null : oneMinuteLoad / cpuCount,
      platform: process.platform,
    };
  }
}

const configSchema = z.object({
  minFreeMemoryMb: z.number().nonnegative().default(512),
  minFreeDiskMb: z.number().nonnegative().default(2048),
  maxLoadPerCpu: z.number().positive().default(1.5),
  heavyJobConcurrency: z.literal(1).default(1),
});
export type ResourceGuardConfig = z.infer<typeof configSchema>;

export class ResourceGuard {
  readonly config: ResourceGuardConfig;
  constructor(
    config: Partial<ResourceGuardConfig> = {},
    private collector: ResourceCollector = new SystemResourceCollector(),
  ) {
    this.config = configSchema.parse(config);
  }
  async evaluate(path?: string) {
    const snapshot = await this.collector.collect(path);
    const reasons: string[] = [];
    if (snapshot.freeMemoryMb < this.config.minFreeMemoryMb) reasons.push('LOW_MEMORY');
    if (snapshot.freeDiskMb < this.config.minFreeDiskMb) reasons.push('LOW_DISK');
    if (snapshot.loadPerCpu !== null && snapshot.loadPerCpu > this.config.maxLoadPerCpu)
      reasons.push('HIGH_LOAD');
    return { allowed: reasons.length === 0, reasons, snapshot };
  }
}

export function resourceGuardFromEnv() {
  return new ResourceGuard({
    minFreeMemoryMb: Number(process.env.MIN_FREE_MEMORY_MB ?? 512),
    minFreeDiskMb: Number(process.env.MIN_FREE_DISK_MB ?? 2048),
    maxLoadPerCpu: Number(process.env.MAX_LOAD_PER_CPU ?? 1.5),
    heavyJobConcurrency: 1,
  });
}
