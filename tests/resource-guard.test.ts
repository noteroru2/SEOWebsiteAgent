import { describe, expect, it } from 'vitest';
import {
  ResourceGuard,
  type ResourceCollector,
  type ResourceSnapshot,
} from '@seo-agent/resource-guard';

const collector = (snapshot: ResourceSnapshot): ResourceCollector => ({
  collect: async () => snapshot,
});
describe('resource guard', () => {
  it('allows work when resources exceed thresholds', async () => {
    const guard = new ResourceGuard(
      {},
      collector({ freeMemoryMb: 2048, freeDiskMb: 10000, loadPerCpu: 0.2, platform: 'linux' }),
    );
    expect((await guard.evaluate()).allowed).toBe(true);
    expect(guard.config.heavyJobConcurrency).toBe(1);
  });
  it('denies work and explains each unsafe resource', async () => {
    const guard = new ResourceGuard(
      {},
      collector({ freeMemoryMb: 10, freeDiskMb: 20, loadPerCpu: 3, platform: 'linux' }),
    );
    expect((await guard.evaluate()).reasons).toEqual(['LOW_MEMORY', 'LOW_DISK', 'HIGH_LOAD']);
  });
  it('does not fail Windows because load average is unavailable', async () => {
    const guard = new ResourceGuard(
      {},
      collector({ freeMemoryMb: 2048, freeDiskMb: 10000, loadPerCpu: null, platform: 'win32' }),
    );
    expect((await guard.evaluate()).allowed).toBe(true);
  });
});
