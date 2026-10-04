// Runs INSIDE the LQ-Studio STAGING container (lq-server):
//   docker exec -i -w /app lq-studio-stg-lqs node --input-type=module -   (script on stdin)
// Creates or refreshes the staging-only account `tts-e2e` for the LQ-TTS Playwright gate and writes ONLY an env file
// to stdout, which the caller pipes into a mode-600 file on mac-studio. Refuses to run anywhere but staging.
import { randomBytes, randomUUID } from 'node:crypto';

// stdout is the env file: LQ-Studio modules log their startup lines with console.log, so send those to stderr.
console.log = (...args) => console.error(...args);

if (!/^https:\/\/demo\.lq-studio\.com\/?$/.test(process.env.PUBLIC_URL ?? '')) {
  console.error('refusing: PUBLIC_URL is not LQ-Studio staging');
  process.exit(2);
}

const db = await import('/app/server/infra/db.js');
const twofa = await import('/app/server/services/akun/twofa.js');
// LQ-Studio encrypts the TOTP seed with DATA_ENC_KEY (not JWT_SECRET); fail fast when the key is absent.
const dataCrypto = await import('/app/server/infra/data-crypto.js');
try {
  dataCrypto.pasangKunciData();
} catch (err) {
  console.error(`refusing: ${err.message}`);
  process.exit(2);
}

const IDENT = 'tts-e2e';
const TARGET_BALANCE = 500;
const now = new Date().toISOString();
const existing = await db.getUserByIdentifier(IDENT);
const password = randomBytes(18).toString('base64url');
const secret = twofa.generateSecret();
const balance = Number(existing?.credits ?? 0);
const grant = Math.max(0, TARGET_BALANCE - balance);

const user = {
  ...(existing ?? {}),
  id: existing?.id ?? randomUUID(),
  name: 'TTS E2E (staging)',
  username: IDENT,
  email: 'tts-e2e@lq-studio.com',
  password: db.hashPassword(password),
  role: 'user',
  tier: 'pro', // the API spec creates a real key, which needs Pro (LQ-TTS public API)
  LANGUAGE: 'id',
  credits: balance + grant,
  emailVerified: true,
  emailVerifiedAt: existing?.emailVerifiedAt ?? now,
  phoneVerified: true,
  phoneVerifiedAt: existing?.phoneVerifiedAt ?? now,
  suspended: false,
  totpEnabled: true,
  totpSecret: dataCrypto.encryptData(secret, 'totp'),
  totpPending: null,
  totpBackupCodes: [],
  totpLastStep: 0,
  tokenVersion: Number(existing?.tokenVersion ?? 0) + 1,
  agreeTerms: true,
  agreePrivacy: true,
  createdAt: existing?.createdAt ?? now,
  lastActiveAt: now,
  freeGrantedAt: existing?.freeGrantedAt ?? now,
};

await db.upsert('users', user);
if (grant > 0) {
  // The ledger records every credit move (LQ-Studio's drift monitor sums `amount`), so the top-up is a bonus row.
  await db.upsert('credit_ledger', {
    id: randomUUID(), userId: user.id, type: 'bonus', amount: grant, balanceAfter: user.credits,
    reason: 'tts_e2e_seed', refId: null, refType: 'system', metadata: { purpose: 'LQ-TTS staging Playwright gate' }, createdAt: now,
  });
}
process.stdout.write(`LQTTS_E2E_IDENTIFIER=${IDENT}\nLQTTS_E2E_PASSWORD=${password}\nLQTTS_E2E_TOTP_SECRET=${secret}\n`);
process.exit(0);
