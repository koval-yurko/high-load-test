// BASE_URL and the API keys reach a run only as -e values or through the archive that
// scripts/upload-k6.sh (plan 2) builds from terraform output. Never in git: the keys
// identify test users, and the URL is a public endpoint.
export const BASE_URL = __ENV.BASE_URL || 'http://localhost:1';
export const USER_AGENT = 'k6/2.3.0';

// A run on default rates is not a capacity measurement; /loadtest refuses to record rate_source=default.
export const RATE_SOURCE = ['RATE', 'START_RATE', 'MAX_RATE', 'STEP_RPS', 'PEAK_RATE', 'NORMAL_RATE', 'NOISY_RATE'].some((k) => __ENV[k]) ? 'explicit' : 'default';

// The seed shape, from seed-manifest.json via upload-k6.sh. Defaults are the seed's.
export const SEED = {
  feeds: Number(__ENV.FEEDS || 200),
  itemsPerFeed: Number(__ENV.ITEMS_PER_FEED || 20),
  reports: Number(__ENV.REPORTS || 20),
  itemsPerReport: Number(__ENV.ITEMS_PER_REPORT || 100),
};

export const KEYS = {
  load: __ENV.API_KEY_LOAD || '',
  'normal-1': __ENV.API_KEY_NORMAL_1 || '',
  'normal-2': __ENV.API_KEY_NORMAL_2 || '',
  'normal-3': __ENV.API_KEY_NORMAL_3 || '',
  'normal-4': __ENV.API_KEY_NORMAL_4 || '',
  noisy: __ENV.API_KEY_NOISY || '',
};

// Frankfurt is next to eu-central-1, where the function runs (the root .env's AWS_REGION), so the
// API Gateway overhead `o` is not an ocean crossing. Corrected 2026-11-09 from Ashburn: the spec
// had the region wrong.
export const CLOUD = {
  distribution: { frankfurt: { loadZone: 'amazon:de:frankfurt', percent: 100 } },
};
