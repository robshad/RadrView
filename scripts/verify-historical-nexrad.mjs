import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// Choose two retained real frames over precipitation at the same tile coordinate.
const [base = 'https://radrview.grrmode.com', first, second, z = '9', x = '141', y = '218'] = process.argv.slice(2);
assert(first && second, 'Usage: node scripts/verify-historical-nexrad.mjs URL OLDER_YYYYMMDDHHmmss NEWER_YYYYMMDDHHmmss [z x y]');
function epoch(timestamp) {
  assert(/^\d{14}$/.test(timestamp), 'Expected UTC YYYYMMDDHHmmss');
  return Date.parse(timestamp.replace(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/, '$1-$2-$3T$4:$5:$6Z'));
}
assert(epoch(first) < epoch(second), 'First frame must precede second frame');
async function tile(timestamp) {
  const response = await fetch(`${base}/tile/${timestamp}/${z}/${x}/${y}?source=mrms`, { signal: AbortSignal.timeout(60_000) });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /image\/png/);
  const bytes = Buffer.from(await response.arrayBuffer());
  const result = {
    timestamp, source: response.headers.get('x-source'),
    observations: response.headers.get('x-nexrad-scans'),
    hash: createHash('sha256').update(bytes).digest('hex'),
  };
  console.log(JSON.stringify(result));
  return result;
}
const missing = await tile('20000101000000');
assert.equal(missing.source, 'unavailable', 'Ancient frame must never use current NEXRAD');
const observations = [];
for (const timestamp of [first, second]) {
  const result = await tile(timestamp);
  assert.equal(result.source, 'nexrad-level2', 'Need retained native history at this coordinate');
  assert(result.observations, 'Missing station observation metadata');
  for (const observation of result.observations.split(',')) {
    const [station, time] = observation.split(':');
    assert(/^[A-Z0-9]{4}$/.test(station));
    assert(Number.isFinite(Number(time)));
    assert(Number(time) <= epoch(timestamp), 'Future scan substituted');
    assert(epoch(timestamp) - Number(time) <= 600_000, 'Scan more than ten minutes old');
  }
  observations.push(result);
}
assert.notEqual(observations[0].observations, observations[1].observations, 'Choose frames with distinct station observations');
assert.notEqual(observations[0].hash, observations[1].hash, 'Choose a tile with evolving precipitation; image bytes must differ');
assert.equal((await tile(first)).hash, observations[0].hash, 'Playback changed when requesting older frame again');
console.log('Historical real-observation HTTP checks passed. Verify persistence across a Coolify redeploy before enabling the consumer flag.');
