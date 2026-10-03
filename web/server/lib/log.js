function write(level, fields, msg) {
  process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields })}\n`);
}

export const log = {
  info: (fields, msg) => write('info', fields, msg),
  warn: (fields, msg) => write('warn', fields, msg),
  error: (fields, msg) => write('error', fields, msg),
};
