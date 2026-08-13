const router = require("express").Router();
const { pool } = require("../db");
const { requireAuth } = require("../middleware/auth");
const { estadoConfiguracion } = require("../utils/push-personal");

router.get("/push/config", requireAuth, async (req,res)=>{
  res.json(estadoConfiguracion());
});

router.post("/push/suscribir", requireAuth, async (req,res)=>{
  const suscripcion=req.body?.subscription;
  const endpoint=String(suscripcion?.endpoint||"").trim();
  const p256dh=String(suscripcion?.keys?.p256dh||"").trim();
  const auth=String(suscripcion?.keys?.auth||"").trim();
  if(!endpoint||!p256dh||!auth)
    return res.status(400).json({error:"La suscripción de notificaciones no es válida."});
  const configuracion=estadoConfiguracion();
  if(!configuracion.configurada)
    return res.status(503).json({error:"Las notificaciones todavía no están configuradas en Railway."});
  const usuarioId=req.session.usuario.id;
  await pool.query(`
    INSERT INTO push_suscripciones_personal(
      usuario_id,endpoint,p256dh,auth,user_agent,last_notification_id
    ) VALUES(
      $1,$2,$3,$4,$5,
      COALESCE((SELECT MAX(id) FROM notificaciones WHERE usuario_id=$1),0)
    )
    ON CONFLICT(endpoint) DO UPDATE SET
      usuario_id=EXCLUDED.usuario_id,
      p256dh=EXCLUDED.p256dh,
      auth=EXCLUDED.auth,
      user_agent=EXCLUDED.user_agent,
      last_notification_id=CASE
        WHEN push_suscripciones_personal.usuario_id=EXCLUDED.usuario_id
          THEN push_suscripciones_personal.last_notification_id
        ELSE EXCLUDED.last_notification_id
      END,
      updated_at=NOW()
  `,[usuarioId,endpoint,p256dh,auth,String(req.get("user-agent")||"").slice(0,500)]);
  res.json({ok:true});
});

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
