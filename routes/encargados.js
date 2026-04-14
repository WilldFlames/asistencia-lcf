const router = require("express").Router();
const { pool } = require("../db");
const { requireAuth, requireRol } = require("../middleware/auth");

const canManage = requireRol("admin","auxiliar");

// ── OBTENER ENCARGADOS DE UN ESTUDIANTE ───────────────────────
router.get("/estudiante/:id", requireAuth, async (req, res) => {
  const r = await pool.query(
    "SELECT * FROM encargados WHERE estudiante_id=$1 ORDER BY es_principal DESC, id ASC",
    [req.params.id]
  );
  res.json(r.rows);
});

// ── CREAR ENCARGADO ───────────────────────────────────────────
router.post("/", canManage, async (req, res) => {
  const { estudiante_id, nombre, primer_apellido, segundo_apellido, parentesco, telefono, celular, email, direccion, es_principal } = req.body;
  if (!estudiante_id || !nombre || !primer_apellido)
    return res.status(400).json({ error: "Nombre y primer apellido son requeridos" });

  // Si es principal, quitar principal a los demás
  if (es_principal) {
    await pool.query("UPDATE encargados SET es_principal=false WHERE estudiante_id=$1", [estudiante_id]);
  }

  const r = await pool.query(`
    INSERT INTO encargados (estudiante_id,nombre,primer_apellido,segundo_apellido,parentesco,telefono,celular,email,direccion,es_principal)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id
  `, [estudiante_id, nombre.trim(), primer_apellido.trim(), segundo_apellido||"", parentesco||"",
      telefono||"", celular||"", email||"", direccion||"", es_principal||false]);
  res.json({ ok: true, id: r.rows[0].id });
});

// ── EDITAR ENCARGADO ──────────────────────────────────────────
router.put("/:id", canManage, async (req, res) => {
  const { nombre, primer_apellido, segundo_apellido, parentesco, telefono, celular, email, direccion, es_principal } = req.body;

  if (es_principal) {
    const enc = await pool.query("SELECT estudiante_id FROM encargados WHERE id=$1", [req.params.id]);
    if (enc.rows.length) {
      await pool.query("UPDATE encargados SET es_principal=false WHERE estudiante_id=$1", [enc.rows[0].estudiante_id]);
    }
  }

  await pool.query(`
    UPDATE encargados SET nombre=$1,primer_apellido=$2,segundo_apellido=$3,parentesco=$4,
      telefono=$5,celular=$6,email=$7,direccion=$8,es_principal=$9 WHERE id=$10
  `, [nombre.trim(), primer_apellido.trim(), segundo_apellido||"", parentesco||"",
      telefono||"", celular||"", email||"", direccion||"", es_principal||false, req.params.id]);
  res.json({ ok: true });
});

// ── ELIMINAR ENCARGADO ────────────────────────────────────────
router.delete("/:id", canManage, async (req, res) => {
  await pool.query("DELETE FROM encargados WHERE id=$1", [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
