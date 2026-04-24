export default () => ({
  port: Number(process.env.PORT ?? 3000),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  database: {
    path: process.env.DATABASE_PATH ?? 'data/time-off.sqlite',
    synchronize: process.env.DB_SYNCHRONIZE === 'true',
    logging: process.env.DB_LOGGING === 'true',
  },
  hcm: {
    baseUrl: process.env.HCM_BASE_URL ?? 'http://localhost:4000',
    apiKey: process.env.HCM_API_KEY ?? 'dev-hcm-key',
    timeoutMs: Number(process.env.HCM_TIMEOUT_MS ?? 5000),
    maxRetries: Number(process.env.HCM_MAX_RETRIES ?? 3),
    verifyAfterWrite: process.env.HCM_VERIFY_AFTER_WRITE !== 'false',
  },
  reconciliation: {
    syncedGraceMs: Number(process.env.RECONCILIATION_GRACE_MS ?? 30000),
  },
});
