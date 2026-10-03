import express from 'express';

export function creditsRouter({ accounts, pool, config }) {
  const router = express.Router();
  router.get('/credits', async (req, res) => {
    const session = await accounts.fresh(req.session);
    const { rows } = await pool.query(
      `SELECT c.id, c.job_id, j.title, (j.id IS NOT NULL AND j.deleted_at IS NULL) AS job_available,
              c.kind, c.chars, c.credits, c.state, c.created_at
       FROM charges c LEFT JOIN jobs j ON j.id = c.job_id
       WHERE c.user_id = $1 ORDER BY c.created_at DESC, c.id DESC LIMIT 100`,
      [req.session.user_id],
    );
    res.json({
      balance: session.balance,
      topupUrl: config.topupUrl,
      usage: rows.map((r) => ({
        id: String(r.id), jobId: r.job_id, title: r.title, jobAvailable: r.job_available, kind: r.kind,
        chars: r.chars, credits: r.credits, state: r.state, createdAt: r.created_at,
      })),
    });
  });
  return router;
}
