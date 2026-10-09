import request from 'supertest';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock ioredis
vi.mock('ioredis', () => {
  const storage = new Map<string, Record<string, string>>();
  const sets = new Map<string, Set<string>>();
  const sortedSets = new Map<string, Map<string, number>>();
  const expiry = new Map<string, number>();

  const mockRedis = {
    hset: vi.fn(async (key: string, data: Record<string, string>) => {
      storage.set(key, { ...(storage.get(key) || {}), ...data });
    }),
    hgetall: vi.fn(async (key: string) => {
      return storage.get(key) || {};
    }),
    expire: vi.fn(async (key: string, ttl: number) => {
      expiry.set(key, ttl);
    }),
    sadd: vi.fn(async (key: string, value: string) => {
      if (!sets.has(key)) sets.set(key, new Set());
      sets.get(key)!.add(value);
    }),
    smembers: vi.fn(async (key: string) => {
      return [...(sets.get(key) || [])];
    }),
    pexpireat: vi.fn(async (key: string, time: number) => { expiry.set(key, time); }),
    zadd: vi.fn(async (key: string, score: number, value: string) => {
      if (!sortedSets.has(key)) sortedSets.set(key, new Map());
      sortedSets.get(key)!.set(value, score);
    }),
    zremrangebyscore: vi.fn(async (key: string, _min: string, max: number) => {
      for (const [member, score] of sortedSets.get(key) || []) {
        if (score <= max) sortedSets.get(key)!.delete(member);
      }
    }),
    zrevrangebyscore: vi.fn(async (key: string, max: number, min: number) => {
      return [...(sortedSets.get(key) || [])].filter(([, score]) => score <= max && score >= min)
        .sort((a, b) => b[1] - a[1]).slice(0, 1).map(([member]) => member);
    }),
    multi: vi.fn(() => {
      const commands: Array<() => Promise<unknown>> = [];
      const transaction: any = { exec: async () => Promise.all(commands.map(async fn => [null, await fn()])) };
      for (const name of ['hset', 'expire', 'pexpireat', 'zadd', 'zremrangebyscore', 'sadd'] as const) {
        transaction[name] = (...args: any[]) => {
          commands.push(() => (mockRedis[name] as any)(...args));
          return transaction;
        };
      }
      return transaction;
    }),
    // Expose internals for test verification
    _storage: storage,
    _sets: sets,
    _expiry: expiry,
    _clear: () => {
      storage.clear();
      sortedSets.clear();
      sets.clear();
      expiry.clear();
    },
  };

  return {
    Redis: vi.fn(() => mockRedis),
  };
});

import { Redis } from 'ioredis';
import {
  writeScanToRedis,
  readScanFromRedis,
  getActiveStationIds,
  writeStatusToRedis,
  readAllStatuses,
} from '../../src/nexrad/redis-scan-store.js';
import type { PreparedScan } from '../../src/nexrad/projector.js';

function createMockPreparedScan(overrides?: Partial<PreparedScan>): PreparedScan {
  const numRadials = 4;
  const gateCount = 10;
  const velGateCount = 8;

  const azimuthsRad = new Float32Array(numRadials);
  for (let i = 0; i < numRadials; i++) {
    azimuthsRad[i] = (i / numRadials) * 2 * Math.PI;
  }

  const gatePixels: Uint8Array[] = [];
  const bioGatePixels: Uint8Array[] = [];
  const velGatePixels: Uint8Array[] = [];
  for (let i = 0; i < numRadials; i++) {
    const gp = new Uint8Array(gateCount);
    gp[0] = 100 + i;
    gp[1] = 200;
    gatePixels.push(gp);

    const bp = new Uint8Array(gateCount);
    bp[2] = 50 + i;
    bioGatePixels.push(bp);

    const vp = new Uint8Array(velGateCount);
    vp[0] = 128; // zero velocity
    vp[1] = 180 + i;
    velGatePixels.push(vp);
  }

  return {
    stationId: 'KTLX',
    timestamp: 1711000000000,
    stationMx: -10826574.123,
    stationMy: 4192484.567,
    stationLatRad: 0.6166,
    stationLonRad: -1.6981,
    azimuthsRad,
    gatePixels,
    bioGatePixels,
    velGatePixels,
    velFirstGateRange: 2125,
    velGateSpacing: 250,
    velGateCount,
    firstGateRange: 2125,
    gateSpacing: 250,
    gateCount,
    elevation: 0.5,
    maxRangeM: 460000,
    bounds: { west: -11800000, east: -9800000, north: 5200000, south: 3200000 },
    count: numRadials,
    mercatorScale: 1.22,
    ...overrides,
  };
}

describe('nexrad/redis-scan-store', () => {
  let redis: any;

  beforeEach(() => {
    redis = new Redis() as any;
    redis._clear();
    vi.clearAllMocks();
  });

  describe('writeScanToRedis', () => {
    it('calls redis.hset with correct key', async () => {
      const scan = createMockPreparedScan();
      await writeScanToRedis(redis, scan);

      expect(redis.hset).toHaveBeenCalledWith(
        'nexrad:scan:KTLX',
        expect.objectContaining({
          stationId: 'KTLX',
          timestamp: '1711000000000',
          gateCount: '10',
          count: '4',
        }),
      );
    });

    it('sets TTL on the key', async () => {
      const scan = createMockPreparedScan();
      await writeScanToRedis(redis, scan);

      expect(redis.expire).toHaveBeenCalledWith('nexrad:scan:KTLX', 1800);
    });

    it('adds station to active set', async () => {
      const scan = createMockPreparedScan();
      await writeScanToRedis(redis, scan);

      expect(redis.sadd).toHaveBeenCalledWith('nexrad:active-stations', 'KTLX');
    });

    it('stores all scalar fields as strings', async () => {
      const scan = createMockPreparedScan();
      await writeScanToRedis(redis, scan);

      const stored = redis._storage.get('nexrad:scan:KTLX');
      expect(stored).toBeDefined();
      expect(stored.stationId).toBe('KTLX');
      expect(stored.timestamp).toBe('1711000000000');
      expect(stored.stationMx).toBe(String(scan.stationMx));
      expect(stored.stationMy).toBe(String(scan.stationMy));
      expect(stored.stationLatRad).toBe(String(scan.stationLatRad));
      expect(stored.stationLonRad).toBe(String(scan.stationLonRad));
      expect(stored.firstGateRange).toBe('2125');
      expect(stored.gateSpacing).toBe('250');
      expect(stored.gateCount).toBe('10');
      expect(stored.elevation).toBe('0.5');
      expect(stored.maxRangeM).toBe('460000');
      expect(stored.boundsWest).toBe(String(scan.bounds.west));
      expect(stored.boundsEast).toBe(String(scan.bounds.east));
      expect(stored.boundsNorth).toBe(String(scan.bounds.north));
      expect(stored.boundsSouth).toBe(String(scan.bounds.south));
      expect(stored.count).toBe('4');
      expect(stored.mercatorScale).toBe('1.22');
    });

    it('stores azimuthsRad as base64', async () => {
      const scan = createMockPreparedScan();
      await writeScanToRedis(redis, scan);

      const stored = redis._storage.get('nexrad:scan:KTLX');
      // Verify it's a valid base64 string
      const buf = Buffer.from(stored.azimuthsRad, 'base64');
      const decoded = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
      expect(decoded.length).toBe(4);
      for (let i = 0; i < 4; i++) {
        expect(decoded[i]).toBeCloseTo(scan.azimuthsRad[i], 4);
      }
    });

    it('stores gatePixels as base64', async () => {
      const scan = createMockPreparedScan();
      await writeScanToRedis(redis, scan);

      const stored = redis._storage.get('nexrad:scan:KTLX');
      const buf = Buffer.from(stored.gatePixels, 'base64');
      // 4 radials * 10 gates = 40 bytes
      expect(buf.length).toBe(40);
      // First radial, first gate should be 100
      expect(buf[0]).toBe(100);
      // Second radial, first gate should be 101
      expect(buf[10]).toBe(101);
    });
  });

  describe('readScanFromRedis', () => {
    it('returns null for missing station', async () => {
      const result = await readScanFromRedis(redis, 'NONEXISTENT');
      expect(result).toBeNull();
    });

    it('returns null when hgetall returns empty object', async () => {
      const result = await readScanFromRedis(redis, 'EMPTY');
      expect(result).toBeNull();
    });
  });

  describe('round-trip: write then read', () => {
    it('produces equivalent PreparedScan', async () => {
      const original = createMockPreparedScan();
      await writeScanToRedis(redis, original);
      const restored = await readScanFromRedis(redis, 'KTLX');

      expect(restored).not.toBeNull();
      expect(restored!.stationId).toBe(original.stationId);
      expect(restored!.timestamp).toBe(original.timestamp);
      expect(restored!.stationMx).toBeCloseTo(original.stationMx, 2);
      expect(restored!.stationMy).toBeCloseTo(original.stationMy, 2);
      expect(restored!.stationLatRad).toBeCloseTo(original.stationLatRad, 4);
      expect(restored!.stationLonRad).toBeCloseTo(original.stationLonRad, 4);
      expect(restored!.firstGateRange).toBe(original.firstGateRange);
      expect(restored!.gateSpacing).toBe(original.gateSpacing);
      expect(restored!.gateCount).toBe(original.gateCount);
      expect(restored!.elevation).toBe(original.elevation);
      expect(restored!.maxRangeM).toBe(original.maxRangeM);
      expect(restored!.count).toBe(original.count);
      expect(restored!.mercatorScale).toBeCloseTo(original.mercatorScale, 2);
      expect(restored!.velFirstGateRange).toBe(original.velFirstGateRange);
      expect(restored!.velGateSpacing).toBe(original.velGateSpacing);
      expect(restored!.velGateCount).toBe(original.velGateCount);

      // Bounds
      expect(restored!.bounds.west).toBe(original.bounds.west);
      expect(restored!.bounds.east).toBe(original.bounds.east);
      expect(restored!.bounds.north).toBe(original.bounds.north);
      expect(restored!.bounds.south).toBe(original.bounds.south);
    });

    it('Float32Array serialization/deserialization is correct (azimuthsRad)', async () => {
      const original = createMockPreparedScan();
      await writeScanToRedis(redis, original);
      const restored = await readScanFromRedis(redis, 'KTLX');

      expect(restored).not.toBeNull();
      expect(restored!.azimuthsRad).toBeInstanceOf(Float32Array);
      expect(restored!.azimuthsRad.length).toBe(original.azimuthsRad.length);
      for (let i = 0; i < original.azimuthsRad.length; i++) {
        expect(restored!.azimuthsRad[i]).toBeCloseTo(original.azimuthsRad[i], 4);
      }
    });

    it('Uint8Array serialization/deserialization is correct (gatePixels)', async () => {
      const original = createMockPreparedScan();
      await writeScanToRedis(redis, original);
      const restored = await readScanFromRedis(redis, 'KTLX');

      expect(restored).not.toBeNull();
      expect(restored!.gatePixels.length).toBe(original.gatePixels.length);
      for (let r = 0; r < original.gatePixels.length; r++) {
        expect(restored!.gatePixels[r].length).toBe(original.gatePixels[r].length);
        for (let g = 0; g < original.gatePixels[r].length; g++) {
          expect(restored!.gatePixels[r][g]).toBe(original.gatePixels[r][g]);
        }
      }
    });

    it('Uint8Array serialization/deserialization is correct (bioGatePixels)', async () => {
      const original = createMockPreparedScan();
      await writeScanToRedis(redis, original);
      const restored = await readScanFromRedis(redis, 'KTLX');

      expect(restored).not.toBeNull();
      expect(restored!.bioGatePixels.length).toBe(original.bioGatePixels.length);
      for (let r = 0; r < original.bioGatePixels.length; r++) {
        for (let g = 0; g < original.bioGatePixels[r].length; g++) {
          expect(restored!.bioGatePixels[r][g]).toBe(original.bioGatePixels[r][g]);
        }
      }
    });

    it('Uint8Array serialization/deserialization is correct (velGatePixels)', async () => {
      const original = createMockPreparedScan();
      await writeScanToRedis(redis, original);
      const restored = await readScanFromRedis(redis, 'KTLX');

      expect(restored).not.toBeNull();
      expect(restored!.velGatePixels.length).toBe(original.velGatePixels.length);
      for (let r = 0; r < original.velGatePixels.length; r++) {
        for (let g = 0; g < original.velGatePixels[r].length; g++) {
          expect(restored!.velGatePixels[r][g]).toBe(original.velGatePixels[r][g]);
        }
      }
    });
  });

  describe('getActiveStationIds', () => {
    it('returns station IDs from Redis set', async () => {
      const scan1 = createMockPreparedScan({ stationId: 'KTLX' });
      const scan2 = createMockPreparedScan({ stationId: 'KOUN' });
      await writeScanToRedis(redis, scan1);
      await writeScanToRedis(redis, scan2);

      const ids = await getActiveStationIds(redis);
      expect(ids).toContain('KTLX');
      expect(ids).toContain('KOUN');
    });
  });

  describe('writeStatusToRedis / readAllStatuses', () => {
    it('writes and reads station status', async () => {
      await writeStatusToRedis(redis, {
        stationId: 'KTLX',
        status: 'active',
        lastDataTime: 1711000000000,
        ageMinutes: 2,
      });

      const statuses = await readAllStatuses(redis, ['KTLX']);
      expect(statuses).toHaveLength(1);
      expect(statuses[0].stationId).toBe('KTLX');
      expect(statuses[0].status).toBe('active');
      expect(statuses[0].lastDataTime).toBe(1711000000000);
      expect(statuses[0].ageMinutes).toBe(2);
    });

    it('returns unavailable for missing status', async () => {
      const statuses = await readAllStatuses(redis, ['NONEXISTENT']);
      expect(statuses).toHaveLength(1);
      expect(statuses[0].status).toBe('unavailable');
    });
  });
});


describe('historical selection', () => {
  it('selects newest scan at or before time; excludes future, stale, and missing observations', async () => {
    const redis = new Redis() as any;
    redis._clear();
    const now = Date.now();
    const earlier = now - 8 * 60_000;
    await writeScanToRedis(redis, createMockPreparedScan({ timestamp: earlier }));
    await writeScanToRedis(redis, createMockPreparedScan({ timestamp: now - 2 * 60_000 }));
    expect((await readScanFromRedis(redis, 'KTLX', now - 4 * 60_000))?.timestamp).toBe(earlier);
    expect((await readScanFromRedis(redis, 'KTLX', now))?.timestamp).toBe(now - 2 * 60_000);
    expect(await readScanFromRedis(redis, 'KTLX', earlier - 1)).toBeNull();
    expect(await readScanFromRedis(redis, 'KTLX', now + 8 * 60_000 + 1)).toBeNull();
    expect(await readScanFromRedis(redis, 'MISSING', now)).toBeNull();
    expect(await readScanFromRedis(redis, 'KTLX', Date.UTC(2000, 0, 1))).toBeNull();
  });

  it('retains two hours by observation time and prunes the history index', async () => {
    const redis = new Redis() as any;
    redis._clear();
    const now = Date.now();
    const old = now - 2 * 60 * 60_000 - 100;
    await writeScanToRedis(redis, createMockPreparedScan({ timestamp: old }));
    await writeScanToRedis(redis, createMockPreparedScan({ timestamp: now }));
    expect(redis.pexpireat).toHaveBeenCalledWith(`nexrad:history:KTLX:${now}`, now + 2 * 60 * 60_000);
    expect(await readScanFromRedis(redis, 'KTLX', old)).toBeNull();
  });
});


// Exercise the HTTP -> provider -> historical store -> real projector path.
// These are synthetic radar observations; live real-data checks remain required.
vi.mock('../../src/storage/index.js', () => ({ getTileStore: () => ({ readTile: async () => null }) }));
vi.mock('../../src/wind/fetcher.js', () => ({ getWindGrid: () => null, startWindFetcher: async () => {} }));
import { createApp } from '../../src/server/index.js';
import { createNexradTileHandler } from '../../src/server/nexrad-tile.js';
import { NexradScanProvider } from '../../src/server/nexrad-scan-provider.js';
import { projectScan } from '../../src/nexrad/projector.js';
import { getAllStations } from '../../src/nexrad/stations.js';

function observation(timestamp: number, dbz: number): PreparedScan {
  const station = getAllStations().find(s => s.id === 'KTLX')!;
  return projectScan(station, {
    stationId: station.id, timestamp, elevation: 0.5, vcp: 212,
    radials: Array.from({ length: 360 }, (_, azimuth) => ({
      azimuth, elevation: 0.5, firstGateRange: 0, gateSpacing: 1000,
      values: new Float32Array(300).fill(dbz),
      bioValues: new Float32Array(300).fill(NaN), velocity: null,
    })),
  });
}

function frameTime(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
}

describe('historical tiles through HTTP', () => {
  it('renders distinct observations and reports unavailable for missing/stale/future-only history', async () => {
    const redis = new Redis() as any;
    redis._clear();
    const now = Math.floor(Date.now() / 1000) * 1000;
    const earlier = now - 5 * 60_000;
    await writeScanToRedis(redis, observation(earlier, 20));
    await writeScanToRedis(redis, observation(now, 50));
    const provider = new NexradScanProvider(redis);
    const { app } = createApp(redis, { nexradTileHandler: createNexradTileHandler(provider) });
    const tile = (time: number, layer = 'reflectivity') => request(app).get(
      `/tile/${frameTime(time)}/9/117/202?source=mrms&layer=${layer}`,
    );
    const old = await tile(earlier);
    const current = await tile(now);
    expect(old.status).toBe(200);
    expect(old.headers['x-source']).toBe('nexrad-level2');
    expect(old.headers['x-nexrad-scans']).toBe(`KTLX:${earlier}`);
    expect(current.headers['x-nexrad-scans']).toBe(`KTLX:${now}`);
    expect(Buffer.compare(old.body, current.body)).not.toBe(0);
    expect((await tile(earlier)).body).toEqual(old.body);
    for (const time of [Date.UTC(2000, 0, 1), earlier - 1000, now + 10 * 60_000 + 1000]) {
      const unavailable = await tile(time);
      expect(unavailable.headers['x-source']).toBe('unavailable');
      expect(unavailable.headers['cache-control']).toBe('no-store');
    }
    // Reflectivity cache must not hide a biological-layer request.
    expect((await tile(earlier, 'biological')).headers['x-source']).toBe('unavailable');
    expect((await request(app).get('/tile/20260230000000/9/117/202')).status).toBe(400);
    provider.close();
  });
});
