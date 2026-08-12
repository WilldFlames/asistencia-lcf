const router = require("express").Router();
const { pool } = require("../db");
const { requireAuth } = require("../middleware/auth");

router.get("/", requireAuth, async (req, res) => {
  const r = await pool.query(
    "SELECT * FROM notificaciones WHERE usuario_id=$1 ORDER BY created_at DESC LIMIT 50",
    [req.session.usuario.id]
  );
  res.json(r.rows);
});

router.get("/no-leidas", requireAuth, async (req, res) => {
  const r = await pool.query(
    "SELECT COUNT(*) AS c FROM notificaciones WHERE usuario_id=$1 AND leida=false",
    [req.session.usuario.id]
  );
  res.json({ count: parseInt(r.rows[0].c) });
});

router.put("/:id/leer", requireAuth, async (req, res) => {
  await pool.query("UPDATE notificaciones SET leida=true WHERE id=$1 AND usuario_id=$2",
    [req.params.id, req.session.usuario.id]);
  res.json({ ok: true });
});

router.put("/leer-todas", requireAuth, async (req, res) => {
  await pool.query("UPDATE notificaciones SET leida=true WHERE usuario_id=$1",
    [req.session.usuario.id]);
  res.json({ ok: true });
});

module.exports = router;
