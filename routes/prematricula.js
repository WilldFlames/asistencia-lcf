const router = require("express").Router();
const { pool } = require("../db");
const { requireAuth } = require("../middleware/auth");

function canAccess(req, res, next) {
  const u = req.session.usuario;
  if(!u) return res.status(401).json({ error:"No autorizado" });
  if(["admin","auxiliar","administrativo"].includes(u.rol)) return next();
  // Comité de matrícula
  pool.query("SELECT 1 FROM matricula_comite WHERE usuario_id=$1", [u.id])
    .then(r => r.rows.length ? next() : res.status(403).json({ error:"Sin permisos" }))
    .catch(() => res.status(403).json({ error:"Sin permisos" }));
}

// ── LISTAR ───────────────────────────────────────────────────────────
router.get("/", canAccess, async (req, res) => {
  const r = await pool.query(`
    SELECT p.*, pe.nombre AS enc_nombre, pe.primer_apellido AS enc_ap1,
      pe.parentesco, pe.cedula AS enc_cedula,
      u.nombre AS reg_nombre, u.primer_apellido AS reg_ap1
    FROM prematricula p
    LEFT JOIN prematricula_encargado pe ON pe.prematricula_id=p.id
    LEFT JOIN usuarios u ON u.id=p.registrado_por
    ORDER BY p.created_at DESC
  `);
  res.json(r.rows);
});

// ── OBTENER UNO ──────────────────────────────────────────────────────
router.get("/:id", canAccess, async (req, res) => {
  const r = await pool.query("SELECT * FROM prematricula WHERE id=$1", [req.params.id]);
  if(!r.rows.length) return res.status(404).json({ error:"No encontrado" });
  const enc = await pool.query("SELECT * FROM prematricula_encargado WHERE prematricula_id=$1", [req.params.id]);
  res.json({ ...r.rows[0], encargado: enc.rows[0]||null });
});

// ── BUSCAR POR CÉDULA ────────────────────────────────────────────────
router.get("/cedula/:cedula", canAccess, async (req, res) => {
  const r = await pool.query("SELECT * FROM prematricula WHERE cedula=$1", [req.params.cedula]);
  if(!r.rows.length) return res.json(null);
  const enc = await pool.query("SELECT * FROM prematricula_encargado WHERE prematricula_id=$1", [r.rows[0].id]);
  res.json({ ...r.rows[0], encargado: enc.rows[0]||null });
});

// ── PASO 1: GUARDAR DATOS DEL ESTUDIANTE ─────────────────────────────
router.post("/paso1", canAccess, async (req, res) => {
  const { cedula, nombre, primer_apellido, segundo_apellido,
          fecha_nacimiento, nacionalidad, centro_procedencia } = req.body;
  if(!cedula||!nombre||!primer_apellido||!segundo_apellido||!fecha_nacimiento||!nacionalidad||!centro_procedencia)
    return res.status(400).json({ error:"Todos los campos son obligatorios." });

  const existe = await pool.query("SELECT id FROM prematricula WHERE cedula=$1", [cedula]);
  if(existe.rows.length)
    return res.status(409).json({ error:"Ya existe una prematrícula con esta cédula.", id: existe.rows[0].id });

  const r = await pool.query(`
    INSERT INTO prematricula (cedula, nombre, primer_apellido, segundo_apellido,
      fecha_nacimiento, nacionalidad, centro_procedencia, registrado_por)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id
  `, [cedula.trim(), nombre.trim(), primer_apellido.trim(), segundo_apellido.trim(),
      fecha_nacimiento, nacionalidad, centro_procedencia.trim(), req.session.usuario.id]);

  res.json({ ok:true, id: r.rows[0].id });
});

// ── PASO 2: GUARDAR ENCARGADO ────────────────────────────────────────
router.post("/paso2/:prematricula_id", canAccess, async (req, res) => {
  const pid = req.params.prematricula_id;
  const { parentesco, cedula, nombre, primer_apellido, segundo_apellido,
          fecha_nacimiento, nacionalidad } = req.body;
  if(!parentesco||!cedula||!nombre||!primer_apellido||!fecha_nacimiento||!nacionalidad)
    return res.status(400).json({ error:"Todos los campos son obligatorios." });

  const existe = await pool.query("SELECT id FROM prematricula WHERE id=$1", [pid]);
  if(!existe.rows.length) return res.status(404).json({ error:"Prematrícula no encontrada." });

  // Upsert encargado
  await pool.query("DELETE FROM prematricula_encargado WHERE prematricula_id=$1", [pid]);
  await pool.query(`
    INSERT INTO prematricula_encargado
      (prematricula_id, parentesco, cedula, nombre, primer_apellido, segundo_apellido, fecha_nacimiento, nacionalidad)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
  `, [pid, parentesco, cedula.trim(), nombre.trim(), primer_apellido.trim(),
      segundo_apellido?.trim()||null, fecha_nacimiento, nacionalidad]);

  res.json({ ok:true });
});

// ── PASO 3: ASIGNAR CONSECUTIVO E IMPRIMIR ───────────────────────────
router.post("/paso3/:prematricula_id", canAccess, async (req, res) => {
  const pid = req.params.prematricula_id;

  // Buscar siguiente consecutivo libre (001-220)
  for(let intento=0; intento<5; intento++){
    const client = await pool.connect();
    try{
      await client.query("BEGIN");
      const usados = await client.query(
        "SELECT consecutivo_prematricula FROM prematricula WHERE consecutivo_prematricula IS NOT NULL ORDER BY consecutivo_prematricula"
      );
      const set = new Set(usados.rows.map(r=>r.consecutivo_prematricula));
      let num = null;
      for(let n=1; n<=220; n++){ if(!set.has(n)){ num=n; break; } }
      if(!num){ await client.query("ROLLBACK"); return res.status(400).json({ error:"No hay consecutivos disponibles (máximo 220)." }); }

      await client.query(
        "UPDATE prematricula SET consecutivo_prematricula=$1 WHERE id=$2 AND consecutivo_prematricula IS NULL",
        [num, pid]
      );
      await client.query("COMMIT");

      const r = await pool.query(`
        SELECT p.*, pe.parentesco, pe.cedula AS enc_cedula, pe.nombre AS enc_nombre,
          pe.primer_apellido AS enc_ap1, pe.segundo_apellido AS enc_ap2
        FROM prematricula p
        LEFT JOIN prematricula_encargado pe ON pe.prematricula_id=p.id
        WHERE p.id=$1
      `, [pid]);
      return res.json({ ok:true, consecutivo: num, prematricula: r.rows[0] });
    }catch(e){
      await client.query("ROLLBACK");
      if(e.code==="23505"){ await new Promise(r=>setTimeout(r,50)); continue; }
      return res.status(500).json({ error: e.message });
    }finally{ client.release(); }
  }
  res.status(409).json({ error:"No se pudo asignar consecutivo. Intente de nuevo." });
});

// ── COMITÉ DE MATRÍCULA ──────────────────────────────────────────────
router.get("/comite/lista", requireAuth, async (req, res) => {
  const r = await pool.query(`
    SELECT mc.*, u.nombre, u.primer_apellido, u.segundo_apellido, u.cedula, u.rol
    FROM matricula_comite mc JOIN usuarios u ON u.id=mc.usuario_id
    ORDER BY mc.created_at
  `);
  res.json(r.rows);
});

router.post("/comite/lista", requireAuth, async (req, res) => {
  const u = req.session.usuario;
  if(u.rol!=="admin"&&u.rol!=="auxiliar") return res.status(403).json({ error:"Sin permisos" });
  const { usuario_id } = req.body;
  const count = await pool.query("SELECT COUNT(*) FROM matricula_comite");
  if(parseInt(count.rows[0].count)>=6)
    return res.status(400).json({ error:"Máximo 6 personas en el comité de matrícula." });
  const existe = await pool.query("SELECT 1 FROM matricula_comite WHERE usuario_id=$1", [usuario_id]);
  if(existe.rows.length) return res.status(409).json({ error:"Este usuario ya está en el comité." });
  await pool.query("INSERT INTO matricula_comite (usuario_id) VALUES ($1)", [usuario_id]);
  res.json({ ok:true });
});

router.delete("/comite/lista/:id", requireAuth, async (req, res) => {
  const u = req.session.usuario;
  if(u.rol!=="admin"&&u.rol!=="auxiliar") return res.status(403).json({ error:"Sin permisos" });
  await pool.query("DELETE FROM matricula_comite WHERE id=$1", [req.params.id]);
  res.json({ ok:true });
});

// ── ELIMINAR PREMATRÍCULA (libera consecutivo) ───────────────────────
router.delete("/:id", canAccess, async (req, res) => {
  const { justificacion } = req.body || {};
  if(!justificacion?.trim())
    return res.status(400).json({ error:"La justificación es obligatoria." });

  const r = await pool.query("SELECT * FROM prematricula WHERE id=$1", [req.params.id]);
  if(!r.rows.length) return res.status(404).json({ error:"No encontrada." });
  if(r.rows[0].estado === "matriculado")
    return res.status(409).json({ error:"No se puede eliminar una prematrícula ya matriculada." });

  // Eliminar encargado y prematrícula — el consecutivo queda libre automáticamente
  await pool.query("DELETE FROM prematricula_encargado WHERE prematricula_id=$1", [req.params.id]);
  await pool.query("DELETE FROM prematricula WHERE id=$1", [req.params.id]);

  res.json({ ok:true, consecutivo_liberado: r.rows[0].consecutivo_prematricula });
});

module.exports = router;
