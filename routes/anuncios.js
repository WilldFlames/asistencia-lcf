const router = require("express").Router();
const { pool } = require("../db");
const { requireRol } = require("../middleware/auth");
const { notificarSecciones } = require("../utils/push-familias");

const canAnunciar = requireRol("admin", "secretaria", "administrativo");

// ── LISTAR (personal) ─────────────────────────────────────────────────────
router.get("/", canAnunciar, async (req, res) => {
  const r = await pool.query(`
    SELECT a.*, u.nombre AS creador_nombre, u.primer_apellido AS creador_ap1
    FROM anuncios a
    LEFT JOIN usuarios u ON u.id = a.creado_por
    ORDER BY a.created_at DESC
    LIMIT 100
  `);
  res.json(r.rows);
});

// ── CREAR ─────────────────────────────────────────────────────────────────
router.post("/", canAnunciar, async (req, res) => {
  const { titulo, cuerpo, para_todos, secciones } = req.body;
  if(!titulo || !titulo.trim()) return res.status(400).json({ error: "El título es requerido" });
  if(!cuerpo || !cuerpo.trim()) return res.status(400).json({ error: "El contenido es requerido" });
  const todos = para_todos !== false && !(Array.isArray(secciones) && secciones.length);
  if(!todos && (!Array.isArray(secciones) || !secciones.length))
    return res.status(400).json({ error: "Marcá al menos una sección o seleccioná 'Para todos'" });
  const r = await pool.query(`
    INSERT INTO anuncios (titulo, cuerpo, para_todos, secciones, creado_por)
    VALUES ($1,$2,$3,$4,$5) RETURNING *
  `, [titulo.trim(), cuerpo.trim(), todos, todos ? [] : secciones.map(Number), req.session.usuario.id]);
  void notificarSecciones(todos ? null : secciones, {
    title: `📣 ${titulo.trim()}`,
    body: cuerpo.trim().slice(0, 240),
    url: "/?app=familias&abrir=avisos",
    tag: `anuncio-${r.rows[0].id}`,
  });
  res.json({ ok: true, anuncio: r.rows[0] });
});

// ── ACTIVAR / DESACTIVAR ──────────────────────────────────────────────────
router.put("/:id/toggle", canAnunciar, async (req, res) => {
  const r = await pool.query("UPDATE anuncios SET activo = NOT activo WHERE id=$1 RETURNING activo", [req.params.id]);
  if(!r.rows.length) return res.status(404).json({ error: "Anuncio no encontrado" });
  res.json({ ok: true, activo: r.rows[0].activo });
});

// ── ELIMINAR ──────────────────────────────────────────────────────────────
router.delete("/:id", canAnunciar, async (req, res) => {
  await pool.query("DELETE FROM anuncios WHERE id=$1", [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
