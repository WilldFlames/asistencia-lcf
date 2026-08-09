const router = require("express").Router();
const { pool } = require("../db");
const { requireRol } = require("../middleware/auth");
const { obtenerAnioActivo, obtenerCalendario } = require("../utils/lectivo");

const onlyAdmin = requireRol("admin");

async function asegurarAnio(anio){
  await pool.query(
    "INSERT INTO anios_lectivos (anio,estado) VALUES ($1,'preparacion') ON CONFLICT (anio) DO NOTHING",
    [anio]
  );
}

// Estado general para todos los módulos autenticados.
router.get("/vigente", async (req, res) => {
  const anio_activo = await obtenerAnioActivo();
  const calendario = await obtenerCalendario(anio_activo);
  const siguiente = await obtenerCalendario(anio_activo + 1);
  const cierre = await pool.query("SELECT anio_destino, aplicado_at FROM cierres_anio ORDER BY aplicado_at DESC LIMIT 1");
  res.json({ anio_activo, calendario, siguiente, ultimo_cierre: cierre.rows[0] || null });
});

router.get("/calendario/:anio", onlyAdmin, async (req, res) => {
  const anio = parseInt(req.params.anio);
  if(!anio) return res.status(400).json({ error: "Año inválido" });
  await asegurarAnio(anio);
  res.json(await obtenerCalendario(anio));
});

router.put("/calendario/:anio", onlyAdmin, async (req, res) => {
  const anio = parseInt(req.params.anio);
  const { periodo_i_inicio, periodo_i_fin, periodo_ii_inicio, periodo_ii_fin } = req.body;
  if(!anio) return res.status(400).json({ error: "Año inválido" });
  const fechas = [periodo_i_inicio, periodo_i_fin, periodo_ii_inicio, periodo_ii_fin];
  if(fechas.some(f => !/^\d{4}-\d{2}-\d{2}$/.test(String(f||''))))
    return res.status(400).json({ error: "Debe completar las cuatro fechas del curso lectivo." });
  if(fechas.some(f => Number(String(f).slice(0,4)) !== anio))
    return res.status(400).json({ error: `Todas las fechas deben pertenecer al ${anio}.` });
  if(!(periodo_i_inicio <= periodo_i_fin && periodo_i_fin < periodo_ii_inicio && periodo_ii_inicio <= periodo_ii_fin))
    return res.status(400).json({ error: "Revise el orden de las fechas de los períodos." });
  await asegurarAnio(anio);
  await pool.query(`
    UPDATE anios_lectivos SET periodo_i_inicio=$1, periodo_i_fin=$2,
      periodo_ii_inicio=$3, periodo_ii_fin=$4, updated_at=NOW()
    WHERE anio=$5
  `, [periodo_i_inicio, periodo_i_fin, periodo_ii_inicio, periodo_ii_fin, anio]);
  res.json({ ok:true, calendario: await obtenerCalendario(anio) });
});

// ── Resumen general del año: secciones + estado de cada configuración ─────
// El catálogo de nombres de sección es global, pero su disponibilidad, guía,
// orientador, idioma y configuración A/B se guardan por año.
router.get("/resumen/:anio", onlyAdmin, async (req, res) => {
  const anio = parseInt(req.params.anio);
  if(!anio) return res.status(400).json({ error: "Año inválido" });
  await asegurarAnio(anio);
  const anioActivo = await obtenerAnioActivo();
  const esFuturo = anio > anioActivo;
  const secR = await pool.query(`
    SELECT s.id, s.nombre, s.nivel,
      sg.profesor_id AS guia_id,
      (SELECT TRIM(CONCAT_WS(' ', u.nombre, u.primer_apellido, u.segundo_apellido)) FROM usuarios u WHERE u.id = sg.profesor_id) AS guia,
      so.orientador_id AS orientador_id,
      (SELECT TRIM(CONCAT_WS(' ', u.nombre, u.primer_apellido, u.segundo_apellido)) FROM usuarios u WHERE u.id = so.orientador_id) AS orientador,
      si.idioma AS idioma_exclusivo,
      sc.tec_b, sc.taller_a, sc.taller_b
    FROM secciones s
    JOIN secciones_anio sa ON sa.seccion_id=s.id AND sa.anio=$1 AND sa.activa=true
    LEFT JOIN seccion_guia_anio sg ON sg.seccion_id = s.id AND sg.anio=$1
    LEFT JOIN seccion_orientador_anio so ON so.seccion_id = s.id AND so.anio=$1
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
  res.json({ anio, anio_activo: anioActivo, es_futuro: esFuturo, secciones: secR.rows, por_nivel: porNivel,
    calendario: await obtenerCalendario(anio) });
});

// ── CREAR SECCIÓN NUEVA (a mano, sin guía ni orientador) ──────────────────
router.post("/secciones", onlyAdmin, async (req, res) => {
  const { nombre, anio } = req.body;
  const a = parseInt(anio);
  if(!nombre || !nombre.trim()) return res.status(400).json({ error: "Nombre requerido" });
  if(!a) return res.status(400).json({ error: "Año requerido" });
  const nom = nombre.trim();
  // Validar formato "N-M" donde N es nivel (7-11) y M es número
  const m = nom.match(/^(\d+)-(\d+)$/);
  if(!m) return res.status(400).json({ error: `Formato inválido. Debe ser tipo "10-1", "7-3", etc.` });
  const nivel = parseInt(m[1]);
  if(nivel < 7 || nivel > 11) return res.status(400).json({ error: "Nivel debe estar entre 7 y 11" });
  await asegurarAnio(a);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(`
      INSERT INTO secciones (nombre,nivel) VALUES ($1,$2)
      ON CONFLICT (nombre) DO UPDATE SET nivel=EXCLUDED.nivel
      RETURNING *`, [nom,nivel]);
    await client.query(`INSERT INTO secciones_anio (seccion_id,anio,activa) VALUES ($1,$2,true)
      ON CONFLICT (seccion_id,anio) DO UPDATE SET activa=true`, [r.rows[0].id,a]);
    await client.query('COMMIT');
    res.json({ ok:true, seccion:r.rows[0] });
  } catch(e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error:e.message });
  } finally { client.release(); }
});

// ── ELIMINAR SECCIÓN (solo si NO tiene estudiantes ni asignaciones) ───────
router.delete("/secciones/:id", onlyAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  const anio = parseInt(req.query.anio);
  if(!id || !anio) return res.status(400).json({ error:"Sección y año requeridos" });
  const anioActivo = await obtenerAnioActivo();
  if(anio === anioActivo){
    const est = await pool.query(
      "SELECT COUNT(*)::int AS c FROM estudiantes WHERE seccion_id=$1 AND activo=true AND (archivado=false OR archivado IS NULL)", [id]);
    if(est.rows[0].c > 0)
      return res.status(409).json({ error:`No se puede quitar del ${anio}: tiene ${est.rows[0].c} estudiante(s) activo(s).` });
  }
  const asig = await pool.query("SELECT COUNT(*)::int AS c FROM asignaciones WHERE seccion_id=$1 AND anio=$2", [id,anio]);
  if(asig.rows[0].c > 0){
    return res.status(409).json({ error: `No se puede quitar del ${anio}: tiene ${asig.rows[0].c} asignación(es).` });
  }
  const mat = await pool.query("SELECT COUNT(*)::int AS c FROM matricula WHERE seccion_id=$1 AND anio=$2", [id,anio]);
  if(mat.rows[0].c > 0){
    return res.status(409).json({ error: `No se puede quitar del ${anio}: hay ${mat.rows[0].c} matrícula(s) reservada(s).` });
  }
  await pool.query("DELETE FROM secciones_anio WHERE seccion_id=$1 AND anio=$2", [id,anio]);
  await pool.query("DELETE FROM seccion_guia_anio WHERE seccion_id=$1 AND anio=$2", [id,anio]);
  await pool.query("DELETE FROM seccion_orientador_anio WHERE seccion_id=$1 AND anio=$2", [id,anio]);
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
