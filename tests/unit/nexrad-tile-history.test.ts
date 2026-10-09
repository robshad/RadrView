import { describe, expect, it, vi } from 'vitest';
import type { PreparedScan } from '../../src/nexrad/projector.js';
import type { NexradScanProvider } from '../../src/server/nexrad-scan-provider.js';

vi.mock('../../src/nexrad/projector.js', () => ({
  renderTile: vi.fn(() => new Uint8Array(256 * 256).fill(100)),
}));
import { renderTile } from '../../src/nexrad/projector.js';
import { createNexradTileHandler } from '../../src/server/nexrad-tile.js';

describe('native tile observation cache', () => {
  it('re-renders when a secondary station changes despite an unchanged maximum timestamp', async () => {
    const newest = { stationId: 'KTLX', timestamp: 2000 } as PreparedScan;
    const older = { stationId: 'KVNX', timestamp: 1000 } as PreparedScan;
    const provider = { getScansForBounds: vi.fn().mockResolvedValue([newest, older]) };
    const handle = createNexradTileHandler(provider as unknown as NexradScanProvider);
    const initial = await handle(9, 117, 202, 'reflectivity', 2500);
    expect(initial?.observations).toBe('KTLX:2000,KVNX:1000');
    expect(provider.getScansForBounds).toHaveBeenCalledWith(
      expect.any(Number), expect.any(Number), expect.any(Number), expect.any(Number), 2500,
    );
    const calls = vi.mocked(renderTile).mock.calls.length;
    await handle(9, 117, 202, 'reflectivity', 2500);
    expect(vi.mocked(renderTile).mock.calls.length).toBe(calls);
    provider.getScansForBounds.mockResolvedValue([newest, { ...older, timestamp: 1500 }]);
    const changed = await handle(9, 117, 202, 'reflectivity', 2500);
    expect(changed?.observations).toBe('KTLX:2000,KVNX:1500');
    expect(vi.mocked(renderTile).mock.calls.length).toBe(calls + 1);
    provider.getScansForBounds.mockResolvedValue([]);
    expect(await handle(9, 117, 202, 'reflectivity', 2500)).toBeNull();
  });
});
