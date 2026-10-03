import { startFakeLqStudio } from '../../server/test/fakes/fake-lqstudio.js';
import { FAKE_LQS_PORT, FAKE_LQS_TOKEN, LOCAL_USERS } from '../target.mjs';

const fake = await startFakeLqStudio({ port: FAKE_LQS_PORT, token: FAKE_LQS_TOKEN, users: LOCAL_USERS });
process.stdout.write(`fake LQ-Studio listening at ${fake.url}\n`);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await fake.close();
    process.exit(0);
  });
}
