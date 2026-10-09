/**
 * Provides PreparedScan data to the tile renderer by reading from Redis.
 *
 * The NEXRAD ingester (separate process) writes scans to Redis.
 * This provider reads them on demand, with an in-memory LRU cache
 * to avoid hitting Redis on every tile request.
 */

import { Redis } from 'ioredis';
import { LRUCache } from 'lru-cache';
import type { PreparedScan } from '../nexrad/projector.js';
import { readScanFromRedis, selectScanTimestamp, readAllStatuses, type RedisStationStatus } from '../nexrad/redis-scan-store.js';
import { findStationsForBounds, getAllStations } from '../nexrad/stations.js';

export class NexradScanProvider {
  private redis: Redis;
  private scanCache = new LRUCache<string, PreparedScan>({ max: 200, ttl: 60_000 });
  constructor(redis: Redis) {
    this.redis = redis;
  }

  /** Get a PreparedScan for a station (from cache or Redis) */
  async getScan(stationId: string, requestedTime: number): Promise<PreparedScan | null> {
    try {
      // Re-select on every request: later ingestion may fill a historical gap.
      const selected = await selectScanTimestamp(this.redis, stationId, requestedTime);
      if (selected === null) return null;
      const cacheKey = `${stationId}:${selected}`;
      const cached = this.scanCache.get(cacheKey);
      if (cached) return cached;
      const scan = await readScanFromRedis(this.redis, stationId, selected);
      if (scan) this.scanCache.set(cacheKey, scan);
      return scan;
    } catch {
      return null;
    }
  }

  /** Get PreparedScans for all stations covering a tile's bounds */
  async getScansForBounds(west: number, south: number, east: number, north: number, requestedTime: number): Promise<PreparedScan[]> {
    const stations = findStationsForBounds(west, south, east, north);
    const scans: PreparedScan[] = [];

    for (const station of stations) {
      const scan = await this.getScan(station.id, requestedTime);
      if (scan) scans.push(scan);
    }

    return scans;
  }

  /** Get station statuses for the API */
  async getStationStatuses(): Promise<RedisStationStatus[]> {
    const allIds = getAllStations().map(s => s.id);
    return readAllStatuses(this.redis, allIds);
  }

  close(): void {
    this.scanCache.clear();
  }
}
