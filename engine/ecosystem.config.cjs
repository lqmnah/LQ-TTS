const path = require("path");

const dir = __dirname;
const python = path.join(dir, ".venv/bin/python");

module.exports = {
  apps: [
    {
      name: "lq-tts-engine-api",
      cwd: dir,
      script: python,
      args: "-m uvicorn lq_tts_engine.api.app:app_from_env --factory --host 127.0.0.1 --port 8740",
      interpreter: "none",
      autorestart: true,
      exp_backoff_restart_delay: 2000,
      env: { PYTHONUNBUFFERED: "1" },
    },
    {
      name: "lq-tts-engine-worker",
      cwd: dir,
      script: python,
      args: "-m lq_tts_engine.worker",
      interpreter: "none",
      autorestart: true,
      exp_backoff_restart_delay: 5000,
      kill_timeout: 30000,
      env: { PYTHONUNBUFFERED: "1", PYTORCH_ENABLE_MPS_FALLBACK: "1" },
    },
  ],
};
