import fs from 'node:fs';
import path from 'node:path';
import express from 'express';

export function mountClient(app, clientDist) {
  const index = path.join(clientDist, 'index.html');
  if (!fs.existsSync(index)) return false;
  app.use('/assets', express.static(path.join(clientDist, 'assets'), { immutable: true, maxAge: '1y', index: false }));
  app.use('/assets', (req, res) => res.status(404).end());
  app.use(express.static(clientDist, { index: false }));
  app.get(/^(?!\/api(?:\/|$)).*/, (req, res) => {
    res.set('cache-control', 'no-cache').sendFile(index);
  });
  return true;
}
