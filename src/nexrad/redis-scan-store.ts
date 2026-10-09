/**
 * Redis-backed store for PreparedScan data.
 *
 * The NEXRAD ingester (separate process) writes PreparedScans to Redis.
 * The server reads them on demand for tile rendering.
 *
 * Storage format: immutable station/timestamp hashes indexed by per-station
 * sorted sets retain two hours; a latest-scan hash is kept for compatibility.
 * Each scan hash contains:
 * - Scalar fields as strings (stationId, timestamp, coordinates, etc.)
 * - azimuthsRad as a base64-encoded Float32Array buffer
 * - gatePixels as a base64-encoded concatenated buffer (all radials packed sequentially)
 * - Station status stored separately in nexrad:status:{stationId}
 */

import { Redis } from 'ioredis';
import type { PreparedScan } from './projector.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('redis-scan-store');

const SCAN_KEY_PREFIX = 'nexrad:scan:';
const STATUS_KEY_PREFIX = 'nexrad:status:';
const STATIONS_KEY = 'nexrad:active-stations';
export const HISTORY_RETENTION_MS = 2 * 60 * 60 * 1000;
export const MAX_SCAN_AGE_MS = 10 * 60 * 1000;
const HISTORY_PREFIX = 'nexrad:history:';
const SCAN_TTL = 1800;  // 30 minutes (scans update every ~7 min, TTL covers gaps)

export interface RedisStationStatus {
  stationId: string;
  status: 'active' | 'stale' | 'unavailable';
  lastDataTime: number | null;
  ageMinutes: number | null;
}

/** Write a PreparedScan to Redis (called by the ingester process) */
export async function writeScanToRedis(redis: Redis, scan: PreparedScan): Promise<void> {
  const key = SCAN_KEY_PREFIX + scan.stationId;

  // Pack azimuthsRad Float32Array to base64
  const azBuf = Buffer.from(scan.azimuthsRad.buffer, scan.azimuthsRad.byteOffset, scan.azimuthsRad.byteLength);

  // Pack gate arrays into contiguous buffers
  function packGates(arrays: Uint8Array[], perRadialCount: number): string {
    const buf = Buffer.alloc(arrays.length * perRadialCount);
    for (let i = 0; i < arrays.length; i++) {
      buf.set(arrays[i].subarray(0, perRadialCount), i * perRadialCount);
    }
    return buf.toString('base64');
  }

  const data = {
    stationId: scan.stationId,
    timestamp: String(scan.timestamp),
    stationMx: String(scan.stationMx),
    stationMy: String(scan.stationMy),
    stationLatRad: String(scan.stationLatRad),
    stationLonRad: String(scan.stationLonRad),
    firstGateRange: String(scan.firstGateRange),
    gateSpacing: String(scan.gateSpacing),
    gateCount: String(scan.gateCount),
    elevation: String(scan.elevation),
    maxRangeM: String(scan.maxRangeM),
    boundsWest: String(scan.bounds.west),
    boundsEast: String(scan.bounds.east),
    boundsNorth: String(scan.bounds.north),
    boundsSouth: String(scan.bounds.south),
    count: String(scan.count),
    mercatorScale: String(scan.mercatorScale),
    velFirstGateRange: String(scan.velFirstGateRange),
    velGateSpacing: String(scan.velGateSpacing),
    velGateCount: String(scan.velGateCount),
    azimuthsRad: azBuf.toString('base64'),
    gatePixels: packGates(scan.gatePixels, scan.gateCount),
    bioGatePixels: packGates(scan.bioGatePixels, scan.gateCount),
    velGatePixels: packGates(scan.velGatePixels, scan.velGateCount || 1),
  };
  // Publish payload and index together; retention follows observation time, not
  // ingestion time. Refreshing latest/status must never extend historical TTLs.
  const historyKey = `${HISTORY_PREFIX}${scan.stationId}:${scan.timestamp}`;
  const indexKey = `${HISTORY_PREFIX}${scan.stationId}`;
  const result = await redis.multi()
    .hset(key, data).expire(key, SCAN_TTL)
    .hset(historyKey, data).pexpireat(historyKey, scan.timestamp + HISTORY_RETENTION_MS)
    .zadd(indexKey, scan.timestamp, String(scan.timestamp))
    .zremrangebyscore(indexKey, '-inf', Date.now() - HISTORY_RETENTION_MS)
    .expire(indexKey, HISTORY_RETENTION_MS / 1000)
    .sadd(STATIONS_KEY, scan.stationId).exec();
  if (!result || result.some(([err]) => err)) throw new Error('Failed to persist NEXRAD scan');
}

/** Write station status to Redis */
export async function writeStatusToRedis(redis: Redis, status: RedisStationStatus): Promise<void> {
  const key = STATUS_KEY_PREFIX + status.stationId;
  await redis.hset(key, {
    stationId: status.stationId,
    status: status.status,
    lastDataTime: String(status.lastDataTime ?? ''),
    ageMinutes: String(status.ageMinutes ?? ''),
  });
  await redis.expire(key, SCAN_TTL);
}

/** Refresh TTL on scan and status keys without rewriting data (called when data hasn't changed).
 *  Returns true if the scan key still exists, false if it has expired. */
export async function refreshScanTTL(redis: Redis, stationId: string): Promise<boolean> {
  const scanAlive = await redis.expire(SCAN_KEY_PREFIX + stationId, SCAN_TTL);
  await redis.expire(STATUS_KEY_PREFIX + stationId, SCAN_TTL);
  return scanAlive === 1;
}

/** Select newest retained observation at or before the requested UTC time. */
export async function selectScanTimestamp(redis: Redis, stationId: string, requestedTime: number): Promise<number | null> {
  if (!Number.isFinite(requestedTime)) return null;
  const timestamps = await redis.zrevrangebyscore(
    HISTORY_PREFIX + stationId, requestedTime,
    Math.max(requestedTime - MAX_SCAN_AGE_MS, Date.now() - HISTORY_RETENTION_MS),
    'LIMIT', 0, 1,
  );
  return timestamps.length ? Number(timestamps[0]) : null;
}

/** Read a PreparedScan from Redis (called by the server process) */
export async function readScanFromRedis(redis: Redis, stationId: string, requestedTime?: number): Promise<PreparedScan | null> {
  let key = SCAN_KEY_PREFIX + stationId;
  if (requestedTime !== undefined) {
    if (!Number.isFinite(requestedTime)) return null;
    const selected = await selectScanTimestamp(redis, stationId, requestedTime);
    if (selected === null) return null;
    key = `${HISTORY_PREFIX}${stationId}:${selected}`;
  }
  const data = await redis.hgetall(key);
  if (!data.stationId) return null;
  const observationTime = Number(data.timestamp);
  if (requestedTime !== undefined && (!Number.isFinite(observationTime)
    || observationTime > requestedTime || requestedTime - observationTime > MAX_SCAN_AGE_MS
    || observationTime <= Date.now() - HISTORY_RETENTION_MS)) return null;

  const gateCount = parseInt(data.gateCount);
  const count = parseInt(data.count);  // number of radials

  // Unpack azimuthsRad
  const azBuf = Buffer.from(data.azimuthsRad, 'base64');
  const azimuthsRad = new Float32Array(azBuf.buffer, azBuf.byteOffset, azBuf.byteLength / 4);

  // Unpack gate pixel arrays
  function unpackGates(b64: string, perRadial: number): Uint8Array[] {
    if (!b64 || perRadial === 0) return Array.from({ length: count }, () => new Uint8Array(0));
    const buf = Buffer.from(b64, 'base64');
    const arrays: Uint8Array[] = [];
    for (let i = 0; i < count; i++) {
      arrays.push(new Uint8Array(buf.buffer, buf.byteOffset + i * perRadial, perRadial));
    }
    return arrays;
  }

  const velGateCount = parseInt(data.velGateCount || '0');

  return {
    stationId: data.stationId,
    timestamp: parseInt(data.timestamp),
    stationMx: parseFloat(data.stationMx),
    stationMy: parseFloat(data.stationMy),
    stationLatRad: parseFloat(data.stationLatRad),
    stationLonRad: parseFloat(data.stationLonRad),
    azimuthsRad,
    gatePixels: unpackGates(data.gatePixels, gateCount),
    bioGatePixels: unpackGates(data.bioGatePixels, gateCount),
    velGatePixels: unpackGates(data.velGatePixels, velGateCount),
    velFirstGateRange: parseFloat(data.velFirstGateRange || '0'),
    velGateSpacing: parseFloat(data.velGateSpacing || '250'),
    velGateCount,
    firstGateRange: parseFloat(data.firstGateRange),
    gateSpacing: parseFloat(data.gateSpacing),
    gateCount,
    elevation: parseFloat(data.elevation),
    maxRangeM: parseFloat(data.maxRangeM),
    bounds: {
      west: parseFloat(data.boundsWest),
      east: parseFloat(data.boundsEast),
      north: parseFloat(data.boundsNorth),
      south: parseFloat(data.boundsSouth),
    },
    count,
    mercatorScale: parseFloat(data.mercatorScale),
  };
}

/** Get all active station IDs from Redis */
export async function getActiveStationIds(redis: Redis): Promise<string[]> {
  return redis.smembers(STATIONS_KEY);
}

/** Read all station statuses from Redis */
export async function readAllStatuses(redis: Redis, stationIds: string[]): Promise<RedisStationStatus[]> {
  const results: RedisStationStatus[] = [];
  for (const id of stationIds) {
    const key = STATUS_KEY_PREFIX + id;
    const data = await redis.hgetall(key);
    results.push({
      stationId: id,
      status: (data.status as any) || 'unavailable',
      lastDataTime: data.lastDataTime ? parseInt(data.lastDataTime) : null,
      ageMinutes: data.ageMinutes ? parseInt(data.ageMinutes) : null,
    });
  }
  return results;
}
