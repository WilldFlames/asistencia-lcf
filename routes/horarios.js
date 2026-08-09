const router = require("express").Router();
const { pool } = require("../db");
const { requireAuth, requireRol } = require("../middleware/auth");
const { obtenerAnioActivo } = require("../utils/lectivo");

// ── HORAS OFICIALES DE LECCIÓN (Curso Lectivo — formato imagen MEP) ────────
// Formato 24h con cero a la izquierda para poder comparar como texto.
const LECCIONES = [
  { n: 1,  ini: "07:00", fin: "07:40" },
  { n: 2,  ini: "07:40", fin: "08:20" },
  { n: 3,  ini: "08:35", fin: "09:15" },
  { n: 4,  ini: "09:15", fin: "09:55" },
  { n: 5,  ini: "10:00", fin: "10:40" },
  { n: 6,  ini: "10:40", fin: "11:20" },
  { n: 7,  ini: "12:00", fin: "12:40" },
  { n: 8,  ini: "12:40", fin: "13:20" },
  { n: 9,  ini: "13:30", fin: "14:10" },
  { n: 10, ini: "14:10", fin: "14:50" },
  { n: 11, ini: "14:55", fin: "15:35" },
  { n: 12, ini: "15:35", fin: "16:15" },
];

// Fecha/hora actual en Costa Rica (UTC-6) — mismo patrón que comedor.js
function fechaCR(){
  const ahora = new Date();
  const offsetCR = -6 * 60;
  const localMs = ahora.getTime() + (ahora.getTimezoneOffset() + offsetCR) * 60000;
  return new Date(localMs).toISOString().slice(0,10);
}
// ── CATÁLOGO DE LECCIONES (horas) ──────────────────────────────────────────
router.get("/lecciones", requireAuth, (req, res) => {
  res.json(LECCIONES);
});

// ── ASIGNACIONES DE UNA SECCIÓN (para llenar el editor — solo admin) ──────
// Aplica herencia I → II Período: muestra la asignación del período actual
// si existe una versión específica (ej. talleres), si no, la del I Período.
router.get("/asignaciones/:seccion_id", requireRol("admin"), async (req, res) => {
  const anio = parseInt(req.query.anio) || await obtenerAnioActivo();
  const r = await pool.query(`
    SELECT a.id, a.subgrupo, a.periodo,
      m.nombre AS materia_nombre,
      u.nombre AS prof_nombre, u.primer_apellido AS prof_ap1
    FROM asignaciones a
    JOIN materias m ON m.id = a.materia_id
    JOIN usuarios u ON u.id = a.profesor_id
    WHERE a.seccion_id = $1
      AND a.anio = $2
      AND NOT (
        COALESCE(a.periodo,'I Período') = 'I Período'
        AND EXISTS (
          SELECT 1 FROM asignaciones a2
          WHERE a2.seccion_id = a.seccion_id AND a2.materia_id = a.materia_id
            AND a2.profesor_id = a.profesor_id AND a2.periodo = 'II Período'
            AND a2.anio = $2
        )
      )
    ORDER BY m.nombre, u.primer_apellido
  `, [req.params.seccion_id, anio]);
  res.json(r.rows);
});

// ── HORARIO DE UNA SECCIÓN ─────────────────────────────────────────────────
// Cualquier usuario autenticado del personal puede VERLO (profes ven horarios
// de estudiantes). Devuelve celdas + nombre del profe guía de la sección.
router.get("/", requireAuth, async (req, res) => {
  const seccionId = req.query.seccion_id;
  const anio = parseInt(req.query.anio) || await obtenerAnioActivo();
  if(!seccionId) return res.status(400).json({ error: "seccion_id requerido" });

  const celdas = await pool.query(`
    SELECT h.id, h.dia, h.leccion, h.asignacion_id, h.materia_texto, h.aula,
      m.nombre AS materia_nombre,
      u.nombre AS prof_nombre, u.primer_apellido AS prof_ap1
    FROM horarios h
    LEFT JOIN asignaciones a ON a.id = h.asignacion_id
    LEFT JOIN materias m ON m.id = a.materia_id
    LEFT JOIN usuarios u ON u.id = a.profesor_id
    WHERE h.seccion_id = $1 AND h.anio = $2
    ORDER BY h.dia, h.leccion, h.id
  `, [seccionId, anio]);

  const guiaR = await pool.query(`
    SELECT u.nombre, u.primer_apellido, u.segundo_apellido
    FROM seccion_guia_anio sg JOIN usuarios u ON u.id = sg.profesor_id
    WHERE sg.seccion_id = $1 AND sg.anio=$2
  `, [seccionId, anio]);

  res.json({ anio, celdas: celdas.rows, guia: guiaR.rows[0] || null });
});

// ── GUARDAR HORARIO DE UNA SECCIÓN (solo admin) ────────────────────────────
// Reemplaza la grilla completa de esa sección + año (transaccional).
router.put("/:seccion_id", requireRol("admin"), async (req, res) => {
  const seccionId = req.params.seccion_id;
  const { anio, celdas } = req.body;
  const a = parseInt(anio) || await obtenerAnioActivo();
  if(!Array.isArray(celdas)) return res.status(400).json({ error: "celdas debe ser un array" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const idsAsignacion = [...new Set(celdas.map(c=>parseInt(c.asignacion_id)).filter(Boolean))];
    if(idsAsignacion.length){
      const validas = await client.query(`SELECT id FROM asignaciones
        WHERE id=ANY($1::int[]) AND seccion_id=$2 AND anio=$3`, [idsAsignacion,seccionId,a]);
      if(validas.rows.length !== idsAsignacion.length){
        await client.query("ROLLBACK");
        return res.status(409).json({ error:`El horario contiene asignaciones que no pertenecen a la sección o al año ${a}. Recargue la pantalla.` });
      }
    }
    await client.query("DELETE FROM horarios WHERE seccion_id=$1 AND anio=$2", [seccionId, a]);
    for(const c of celdas){
      if(!c.dia || !c.leccion) continue;
      if(!c.asignacion_id && !c.materia_texto) continue; // celda libre — no se guarda
      let aula = null;
      if(c.aula !== undefined && c.aula !== null && String(c.aula).trim() !== ''){
        aula = parseInt(c.aula);
        if(isNaN(aula) || aula < 0 || aula > 30){
          await client.query("ROLLBACK");
          return res.status(400).json({ error: `Aula inválida "${c.aula}" (día ${c.dia}, lección ${c.leccion}). Debe ser un número de 0 a 30.` });
        }
      }
      await client.query(`
        INSERT INTO horarios (anio, seccion_id, dia, leccion, asignacion_id, materia_texto, aula)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
      `, [a, seccionId, c.dia, c.leccion, c.asignacion_id || null, c.materia_texto || null, aula]);
    }
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch(e) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── MI HORARIO (profesor: sus lecciones en todas las secciones) ────────────
router.get("/mi-horario", requireAuth, async (req, res) => {
  const anio = parseInt(req.query.anio) || await obtenerAnioActivo();
  const r = await pool.query(`
    SELECT h.dia, h.leccion, h.aula, s.nombre AS seccion_nombre, m.nombre AS materia_nombre
    FROM horarios h
    JOIN asignaciones a ON a.id = h.asignacion_id
    JOIN secciones s ON s.id = h.seccion_id
    JOIN materias m ON m.id = a.materia_id
    WHERE a.profesor_id = $1 AND h.anio = $2
    ORDER BY h.dia, h.leccion
  `, [req.session.usuario.id, anio]);
  res.json({ anio, celdas: r.rows });
});

module.exports = router;
module.exports.LECCIONES = LECCIONES;
