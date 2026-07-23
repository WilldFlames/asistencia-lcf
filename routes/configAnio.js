const router = require("express").Router();
const { pool } = require("../db");
const { requireRol } = require("../middleware/auth");

const onlyAdmin = requireRol("admin");

function anioCR(){
  const ahora = new Date();
  const offsetCR = -6 * 60;
  const localMs = ahora.getTime() + (ahora.getTimezoneOffset() + offsetCR) * 60000;
  return parseInt(new Date(localMs).toISOString().slice(0,4));
}

// ── Resumen general del año: secciones + estado de cada configuración ─────
// Nota: la tabla `secciones` es global (no hay una por año). Los vínculos de
// guía y orientador corresponden al AÑO EN CURSO. Para años futuros los
// devolvemos vacíos, para no confundir a admin con datos que se limpiarán al
// archivar el año actual.
router.get("/resumen/:anio", onlyAdmin, async (req, res) => {
  const anio = parseInt(req.params.anio);
  if(!anio) return res.status(400).json({ error: "Año inválido" });
  const esFuturo = anio > anioCR();
  // Secciones existentes (globales)
  const secR = await pool.query(`
    SELECT s.id, s.nombre, s.nivel,
      ${esFuturo ? "NULL::int AS guia_id, NULL::text AS guia, NULL::int AS orientador_id, NULL::text AS orientador," : `
      sg.profesor_id AS guia_id,
      (SELECT u.primer_apellido || ' ' || u.nombre FROM usuarios u WHERE u.id = sg.profesor_id) AS guia,
      so.orientador_id AS orientador_id,
      (SELECT u.primer_apellido || ' ' || u.nombre FROM usuarios u WHERE u.id = so.orientador_id) AS orientador,`}
      si.idioma AS idioma_exclusivo,
      sc.tec_b, sc.taller_a, sc.taller_b
    FROM secciones s
    ${esFuturo ? "" : `
    LEFT JOIN seccion_guia sg ON sg.seccion_id = s.id
    LEFT JOIN seccion_orientador so ON so.seccion_id = s.id`}
    LEFT JOIN secciones_idioma si ON si.seccion_id = s.id AND si.anio = $1
    LEFT JOIN secciones_config sc ON sc.seccion_id = s.id AND sc.anio = $1
    ORDER BY s.nivel, s.nombre
  `, [anio]);
  // Estadísticas por nivel
  const porNivel = {};
  secR.rows.forEach(s => {
    const n = s.nivel;
    if(!porNivel[n]) porNivel[n] = { total: 0, con_idioma: 0, con_talleres: 0, con_tec_b: 0 };
    porNivel[n].total++;
    if(s.idioma_exclusivo) porNivel[n].con_idioma++;
    if(s.taller_a && s.taller_b) porNivel[n].con_talleres++;
    if(s.tec_b) porNivel[n].con_tec_b++;
  });
  res.json({ anio, es_futuro: esFuturo, secciones: secR.rows, por_nivel: porNivel });
});

// ── CREAR SECCIÓN NUEVA (a mano, sin guía ni orientador) ──────────────────
router.post("/secciones", onlyAdmin, async (req, res) => {
  const { nombre } = req.body;
  if(!nombre || !nombre.trim()) return res.status(400).json({ error: "Nombre requerido" });
  const nom = nombre.trim();
  // Validar formato "N-M" donde N es nivel (7-11) y M es número
  const m = nom.match(/^(\d+)-(\d+)$/);
  if(!m) return res.status(400).json({ error: `Formato inválido. Debe ser tipo "10-1", "7-3", etc.` });
  const nivel = parseInt(m[1]);
  if(nivel < 7 || nivel > 11) return res.status(400).json({ error: "Nivel debe estar entre 7 y 11" });
  try {
    const r = await pool.query(
      "INSERT INTO secciones (nombre, nivel) VALUES ($1,$2) RETURNING *",
      [nom, nivel]
    );
    res.json({ ok: true, seccion: r.rows[0] });
  } catch(e) {
    if(String(e.message).includes("duplicate") || String(e.message).includes("unique")){
      return res.status(409).json({ error: `Ya existe una sección con el nombre "${nom}".` });
    }
    res.status(500).json({ error: e.message });
  }
});

// ── ELIMINAR SECCIÓN (solo si NO tiene estudiantes ni asignaciones) ───────
router.delete("/secciones/:id", onlyAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  const est = await pool.query(
    "SELECT COUNT(*)::int AS c FROM estudiantes WHERE seccion_id=$1 AND (archivado=false OR archivado IS NULL)", [id]);
  if(est.rows[0].c > 0){
    return res.status(409).json({ error: `No se puede eliminar: la sección tiene ${est.rows[0].c} estudiante(s) activo(s).` });
  }
  const asig = await pool.query("SELECT COUNT(*)::int AS c FROM asignaciones WHERE seccion_id=$1", [id]);
  if(asig.rows[0].c > 0){
    return res.status(409).json({ error: `No se puede eliminar: la sección tiene ${asig.rows[0].c} asignación(es) de profesores. Bórrelas primero.` });
  }
  const mat = await pool.query("SELECT COUNT(*)::int AS c FROM matricula WHERE seccion_id=$1", [id]);
  if(mat.rows[0].c > 0){
    return res.status(409).json({ error: `No se puede eliminar: hay ${mat.rows[0].c} matrícula(s) reservada(s) en esta sección.` });
  }
  await pool.query("DELETE FROM secciones WHERE id=$1", [id]);
  res.json({ ok: true });
});

// ── CONFIG A/B por sección + año (talleres 7-9 y tecnología B 10-11) ──────
router.put("/config/:seccion_id", onlyAdmin, async (req, res) => {
  const seccionId = parseInt(req.params.seccion_id);
  const { anio, tec_b, taller_a, taller_b } = req.body;
  const a = parseInt(anio);
  if(!seccionId || !a) return res.status(400).json({ error: "seccion_id y anio requeridos" });
  // Validar valores
  if(tec_b && !["Diseño Publicitario","Matem/AMPROSA"].includes(tec_b))
    return res.status(400).json({ error: "tec_b inválido (Diseño Publicitario o Matem/AMPROSA)" });
  const tallerValido = t => !t || ["Educación para el Hogar","Artes Industriales"].includes(t);
  if(!tallerValido(taller_a) || !tallerValido(taller_b))
    return res.status(400).json({ error: "Taller inválido (Educación para el Hogar o Artes Industriales)" });
  if(taller_a && taller_b && taller_a === taller_b)
    return res.status(400).json({ error: "El taller de A debe ser distinto al de B (uno Hogar y otro Industriales)." });
  await pool.query(`
    INSERT INTO secciones_config (seccion_id, anio, tec_b, taller_a, taller_b)
    VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (seccion_id, anio) DO UPDATE
      SET tec_b = EXCLUDED.tec_b,
          taller_a = EXCLUDED.taller_a,
          taller_b = EXCLUDED.taller_b
  `, [seccionId, a, tec_b || null, taller_a || null, taller_b || null]);
  res.json({ ok: true });
});

module.exports = router;
