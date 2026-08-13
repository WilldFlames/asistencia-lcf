const router = require("express").Router();
const { pool } = require("../db");
const { requireAuth, requireRol } = require("../middleware/auth");
const { exigirAccesoEstudiante } = require("../utils/acceso-estudiantes");

const canManage = requireRol("admin","auxiliar");

// ── OBTENER ENCARGADOS DE UN ESTUDIANTE ───────────────────────
router.get("/estudiante/:id", requireAuth, exigirAccesoEstudiante(req=>req.params.id), async (req, res) => {
  const r = await pool.query(
    "SELECT * FROM encargados WHERE estudiante_id=$1 ORDER BY es_principal DESC, id ASC",
    [req.params.id]
  );
  res.json(r.rows);
});

// ── CREAR ENCARGADO ───────────────────────────────────────────
router.post("/", canManage, async (req, res) => {
  const { estudiante_id, cedula, nombre, primer_apellido, segundo_apellido, parentesco,
          telefono, celular, telefono_trabajo, lugar_trabajo, email, direccion, es_principal } = req.body;
  if (!estudiante_id || !nombre || !primer_apellido)
    return res.status(400).json({ error: "Nombre y primer apellido son requeridos" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existentes = await client.query(
      "SELECT id FROM encargados WHERE estudiante_id=$1 FOR UPDATE",
      [estudiante_id]
    );
    const principalFinal = es_principal === true || existentes.rows.length === 0;
    if (principalFinal && !String(cedula||"").trim()) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error:"El encargado principal debe tener cédula." });
    }
    if (principalFinal) {
      await client.query("UPDATE encargados SET es_principal=false WHERE estudiante_id=$1", [estudiante_id]);
    }
    const r = await client.query(`
      INSERT INTO encargados (estudiante_id,cedula,nombre,primer_apellido,segundo_apellido,parentesco,
        telefono,celular,telefono_trabajo,lugar_trabajo,email,direccion,es_principal)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id
    `, [estudiante_id, cedula||"", nombre.trim(), primer_apellido.trim(), segundo_apellido||"",
        parentesco||"", telefono||"", celular||"", telefono_trabajo||"", lugar_trabajo||"",
        email||"", direccion||"", principalFinal]);
    await client.query("COMMIT");
    res.json({ ok:true, id:r.rows[0].id, es_principal:principalFinal });
  } catch(e) {
    await client.query("ROLLBACK");
    console.error("crear encargado:", e.message);
    res.status(500).json({ error:"No se pudo guardar el encargado." });
  } finally { client.release(); }
});

// ── EDITAR ENCARGADO ──────────────────────────────────────────
router.put("/:id", canManage, async (req, res) => {
  const { cedula, nombre, primer_apellido, segundo_apellido, parentesco,
          telefono, celular, telefono_trabajo, lugar_trabajo, email, direccion, es_principal } = req.body;
  if (!nombre || !primer_apellido)
    return res.status(400).json({ error: "Nombre y primer apellido son requeridos" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const enc = await client.query(
      "SELECT estudiante_id,es_principal FROM encargados WHERE id=$1 FOR UPDATE",
      [req.params.id]
    );
    if(!enc.rows.length){
      await client.query("ROLLBACK");
      return res.status(404).json({ error:"Encargado no encontrado." });
    }
    const quierePrincipal = es_principal === true;
    if(quierePrincipal && !String(cedula||"").trim()){
      await client.query("ROLLBACK");
      return res.status(400).json({ error:"El encargado principal debe tener cédula." });
    }
    if(!quierePrincipal && enc.rows[0].es_principal){
      await client.query("ROLLBACK");
      return res.status(400).json({ error:"Primero designá a otro encargado como principal." });
    }
    if(quierePrincipal){
      await client.query("UPDATE encargados SET es_principal=false WHERE estudiante_id=$1", [enc.rows[0].estudiante_id]);
    }
    await client.query(`
      UPDATE encargados SET cedula=$1,nombre=$2,primer_apellido=$3,segundo_apellido=$4,parentesco=$5,
        telefono=$6,celular=$7,telefono_trabajo=$8,lugar_trabajo=$9,email=$10,direccion=$11,es_principal=$12
      WHERE id=$13
    `, [cedula||"", nombre.trim(), primer_apellido.trim(), segundo_apellido||"", parentesco||"",
        telefono||"", celular||"", telefono_trabajo||"", lugar_trabajo||"",
        email||"", direccion||"", quierePrincipal, req.params.id]);
    await client.query("COMMIT");
    res.json({ ok:true });
  } catch(e) {
    await client.query("ROLLBACK");
    console.error("editar encargado:", e.message);
    res.status(500).json({ error:"No se pudo actualizar el encargado." });
  } finally { client.release(); }
});

// Designar principal sin tener que volver a editar todos sus datos.
router.put("/:id/principal", canManage, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const enc = await client.query(
      "SELECT estudiante_id,cedula FROM encargados WHERE id=$1 FOR UPDATE",
      [req.params.id]
    );
    if(!enc.rows.length){
      await client.query("ROLLBACK");
      return res.status(404).json({ error:"Encargado no encontrado." });
    }
    if(!String(enc.rows[0].cedula||"").trim()){
      await client.query("ROLLBACK");
      return res.status(400).json({ error:"Agregá la cédula antes de designarlo como principal." });
    }
    await client.query("UPDATE encargados SET es_principal=false WHERE estudiante_id=$1", [enc.rows[0].estudiante_id]);
    await client.query("UPDATE encargados SET es_principal=true WHERE id=$1", [req.params.id]);
    await client.query("COMMIT");
    res.json({ ok:true });
  } catch(e) {
    await client.query("ROLLBACK");
    console.error("designar encargado principal:", e.message);
    res.status(500).json({ error:"No se pudo cambiar el encargado principal." });
  } finally { client.release(); }
});

// ── ELIMINAR ENCARGADO ────────────────────────────────────────
router.delete("/:id", canManage, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const enc = await client.query(
      "SELECT estudiante_id,es_principal FROM encargados WHERE id=$1 FOR UPDATE",
      [req.params.id]
    );
    if(!enc.rows.length){
      await client.query("ROLLBACK");
      return res.status(404).json({ error:"Encargado no encontrado." });
    }
    const total = await client.query(
      "SELECT COUNT(*)::int AS total FROM encargados WHERE estudiante_id=$1",
      [enc.rows[0].estudiante_id]
    );
    if(total.rows[0].total<=1){
      await client.query("ROLLBACK");
      return res.status(400).json({ error:"No se puede eliminar el único encargado del estudiante." });
    }
    await client.query("DELETE FROM encargados WHERE id=$1", [req.params.id]);
    if(enc.rows[0].es_principal){
      await client.query(`UPDATE encargados SET es_principal=true
        WHERE id=(SELECT id FROM encargados WHERE estudiante_id=$1 ORDER BY id LIMIT 1)`,
        [enc.rows[0].estudiante_id]);
    }
    await client.query("COMMIT");
    res.json({ ok:true });
  } catch(e) {
    await client.query("ROLLBACK");
    console.error("eliminar encargado:", e.message);
    res.status(500).json({ error:"No se pudo eliminar el encargado." });
  } finally { client.release(); }
});

module.exports = router;
