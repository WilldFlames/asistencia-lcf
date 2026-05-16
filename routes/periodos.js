const router = require("express").Router();
const { pool } = require("../db");
const { requireRol } = require("../middleware/auth");

// Solo admin y auxiliar pueden tocar este módulo
const canSwap = requireRol("admin", "auxiliar");

const NOMBRE_HOGAR = "Educación para el Hogar";
const NOMBRE_INDUSTRIALES = "Artes Industriales";

function periodoActualNombre() {
  const hoy = new Date();
  return (hoy < new Date('2026-07-04T00:00:00')) ? 'I Período' : 'II Período';
}

// ── VISTA PREVIA: pares actuales del I Período en 7°-9° ──────────────────────
// Devuelve, agrupado por sección, las asignaciones de Hogar e Industriales
// (incluyendo subgrupos) y el detalle de quién las dicta hoy. Solo muestra
// secciones donde HAY al menos una asignación de Hogar o Industriales.
router.get("/preview", canSwap, async (req, res) => {
  try {
    // Obtener IDs de las materias
    const matR = await pool.query(
      "SELECT id, nombre FROM materias WHERE nombre IN ($1, $2)",
      [NOMBRE_HOGAR, NOMBRE_INDUSTRIALES]);
    const idHogar = matR.rows.find(m => m.nombre === NOMBRE_HOGAR)?.id;
    const idIndus = matR.rows.find(m => m.nombre === NOMBRE_INDUSTRIALES)?.id;

    if (!idHogar || !idIndus) {
      return res.status(400).json({
        error: `No se encontraron las materias "${NOMBRE_HOGAR}" e "${NOMBRE_INDUSTRIALES}" en la base de datos.`
      });
    }

    // Asignaciones del I Período en 7°-9° de Hogar o Industriales
    const asigR = await pool.query(`
      SELECT a.id, a.profesor_id, a.seccion_id, a.materia_id, a.subgrupo, a.lecciones_semana,
        COALESCE(a.periodo,'I Período') AS periodo,
        s.nombre AS seccion_nombre, s.nivel,
        m.nombre AS materia_nombre,
        u.id AS prof_id, u.nombre AS prof_nombre,
        u.primer_apellido AS prof_ap1, u.segundo_apellido AS prof_ap2
      FROM asignaciones a
      JOIN secciones s ON s.id=a.seccion_id
      JOIN materias m ON m.id=a.materia_id
      JOIN usuarios u ON u.id=a.profesor_id
      WHERE a.materia_id IN ($1, $2)
        AND s.nivel BETWEEN 7 AND 9
        AND COALESCE(a.periodo,'I Período') = 'I Período'
      ORDER BY s.nivel, s.nombre, a.subgrupo NULLS FIRST
    `, [idHogar, idIndus]);

    // Asignaciones del II Período (si ya existen, indicar)
    const yaCreadasR = await pool.query(`
      SELECT a.seccion_id, a.materia_id, a.subgrupo
      FROM asignaciones a
      JOIN secciones s ON s.id=a.seccion_id
      WHERE a.materia_id IN ($1, $2)
        AND s.nivel BETWEEN 7 AND 9
        AND COALESCE(a.periodo,'I Período') = 'II Período'
    `, [idHogar, idIndus]);
    const yaExiste = new Set(yaCreadasR.rows.map(r =>
      `${r.seccion_id}|${r.materia_id}|${r.subgrupo || ''}`));

    // Agrupar por sección+subgrupo para detectar pares
    const grupos = {};
    for (const a of asigR.rows) {
      const key = `${a.seccion_id}|${a.subgrupo || ''}`;
      if (!grupos[key]) {
        grupos[key] = {
          seccion_id: a.seccion_id,
          seccion_nombre: a.seccion_nombre,
          nivel: a.nivel,
          subgrupo: a.subgrupo || null,
          hogar: null,
          industriales: null,
          ya_intercambiado: false
        };
      }
      const target = a.materia_id === idHogar ? 'hogar' : 'industriales';
      grupos[key][target] = {
        asignacion_id: a.id,
        prof_id: a.prof_id,
        prof_nombre: `${a.prof_ap1} ${a.prof_ap2 || ''}, ${a.prof_nombre}`.trim(),
        lecciones_semana: a.lecciones_semana
      };
    }

    // Marcar los que ya tienen asignaciones del II Período creadas
    Object.values(grupos).forEach(g => {
      const kHogar = `${g.seccion_id}|${idHogar}|${g.subgrupo || ''}`;
      const kIndus = `${g.seccion_id}|${idIndus}|${g.subgrupo || ''}`;
      g.ya_intercambiado = yaExiste.has(kHogar) || yaExiste.has(kIndus);
    });

    const lista = Object.values(grupos).sort((a, b) => {
      if (a.nivel !== b.nivel) return a.nivel - b.nivel;
      if (a.seccion_nombre !== b.seccion_nombre) return a.seccion_nombre.localeCompare(b.seccion_nombre);
      return (a.subgrupo || '').localeCompare(b.subgrupo || '');
    });

    res.json({
      grupos: lista,
      periodo_actual: periodoActualNombre(),
      materias: { hogar: idHogar, industriales: idIndus }
    });
  } catch (err) {
    console.error('periodos/preview error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── EJECUTAR INTERCAMBIO Hogar↔Industriales ──────────────────────────────────
// Solo intercambia los pares que tienen AMBAS asignaciones (Hogar e Industriales)
// definidas en el mismo subgrupo de la misma sección.
// Crea nuevas asignaciones con periodo='II Período' SIN tocar las del I.
router.post("/intercambiar", canSwap, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const matR = await client.query(
      "SELECT id, nombre FROM materias WHERE nombre IN ($1, $2)",
      [NOMBRE_HOGAR, NOMBRE_INDUSTRIALES]);
    const idHogar = matR.rows.find(m => m.nombre === NOMBRE_HOGAR)?.id;
    const idIndus = matR.rows.find(m => m.nombre === NOMBRE_INDUSTRIALES)?.id;
    if (!idHogar || !idIndus) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: `No se encontraron las materias en la BD.`
      });
    }

    // Recolectar pares del I Período en 7°-9°
    const asigR = await client.query(`
      SELECT a.id, a.profesor_id, a.seccion_id, a.materia_id, a.subgrupo, a.lecciones_semana,
        s.nivel
      FROM asignaciones a
      JOIN secciones s ON s.id=a.seccion_id
      WHERE a.materia_id IN ($1, $2)
        AND s.nivel BETWEEN 7 AND 9
        AND COALESCE(a.periodo,'I Período') = 'I Período'
    `, [idHogar, idIndus]);

    const grupos = {};
    for (const a of asigR.rows) {
      const key = `${a.seccion_id}|${a.subgrupo || ''}`;
      if (!grupos[key]) {
        grupos[key] = {
          seccion_id: a.seccion_id, subgrupo: a.subgrupo || null,
          hogar: null, industriales: null
        };
      }
      const t = a.materia_id === idHogar ? 'hogar' : 'industriales';
      grupos[key][t] = a;
    }

    // Verificar qué pares del II Período ya están creados — si CUALQUIERA está creado,
    // ya se hizo el intercambio para ese par y lo saltamos.
    const yaCreadasR = await client.query(`
      SELECT seccion_id, materia_id, subgrupo
      FROM asignaciones
      WHERE materia_id IN ($1, $2) AND COALESCE(periodo,'I Período')='II Período'
    `, [idHogar, idIndus]);
    const yaExiste = new Set(yaCreadasR.rows.map(r =>
      `${r.seccion_id}|${r.materia_id}|${r.subgrupo || ''}`));

    let intercambiados = 0;
    let saltados = 0;
    const detalle = [];

    for (const g of Object.values(grupos)) {
      // Solo intercambiar si AMBOS lados existen
      if (!g.hogar || !g.industriales) {
        saltados++;
        detalle.push({
          seccion_id: g.seccion_id, subgrupo: g.subgrupo,
          resultado: 'omitido',
          motivo: 'Falta una de las dos materias en este grupo'
        });
        continue;
      }

      // Saltar si ya hay alguna asignación del II Período para este grupo+subgrupo
      const kHogar = `${g.seccion_id}|${idHogar}|${g.subgrupo || ''}`;
      const kIndus = `${g.seccion_id}|${idIndus}|${g.subgrupo || ''}`;
      if (yaExiste.has(kHogar) || yaExiste.has(kIndus)) {
        saltados++;
        detalle.push({
          seccion_id: g.seccion_id, subgrupo: g.subgrupo,
          resultado: 'omitido',
          motivo: 'Ya existe asignación del II Período para este grupo'
        });
        continue;
      }

      // Crear las dos nuevas asignaciones INTERCAMBIADAS para el II Período:
      // El profe que daba Hogar en I → ahora da Industriales en II (misma sección y subgrupo)
      // El profe que daba Industriales en I → ahora da Hogar en II (misma sección y subgrupo)
      const nuevaHogar = await client.query(`
        INSERT INTO asignaciones (profesor_id, seccion_id, materia_id, subgrupo, lecciones_semana, periodo)
        VALUES ($1, $2, $3, $4, $5, 'II Período') RETURNING id
      `, [g.industriales.profesor_id, g.seccion_id, idHogar, g.subgrupo, g.industriales.lecciones_semana]);

      const nuevaIndus = await client.query(`
        INSERT INTO asignaciones (profesor_id, seccion_id, materia_id, subgrupo, lecciones_semana, periodo)
        VALUES ($1, $2, $3, $4, $5, 'II Período') RETURNING id
      `, [g.hogar.profesor_id, g.seccion_id, idIndus, g.subgrupo, g.hogar.lecciones_semana]);

      // Registrar en la bitácora de intercambios
      await client.query(`
        INSERT INTO intercambios_periodo
          (nivel, seccion_id, asig_hogar_i, asig_indus_i, asig_hogar_ii, asig_indus_ii, ejecutado_por)
        SELECT s.nivel, $1, $2, $3, $4, $5, $6 FROM secciones s WHERE s.id=$1
      `, [g.seccion_id, g.hogar.id, g.industriales.id, nuevaHogar.rows[0].id, nuevaIndus.rows[0].id, req.session.usuario.id]);

      intercambiados++;
      detalle.push({
        seccion_id: g.seccion_id, subgrupo: g.subgrupo,
        resultado: 'intercambiado',
        nueva_hogar_id: nuevaHogar.rows[0].id,
        nueva_indus_id: nuevaIndus.rows[0].id
      });
    }

    await client.query('COMMIT');
    res.json({ ok: true, intercambiados, saltados, detalle });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('periodos/intercambiar error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ── REVERTIR ÚLTIMO INTERCAMBIO ──────────────────────────────────────────────
// Elimina las asignaciones del II Período que se crearon en intercambios no revertidos.
// SOLO funciona si esas asignaciones NO tienen sesiones de asistencia (para no perder datos).
router.post("/revertir", canSwap, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const interR = await client.query(`
      SELECT id, asig_hogar_ii, asig_indus_ii
      FROM intercambios_periodo WHERE revertido=false
    `);
    if (!interR.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: "No hay intercambios pendientes de revertir." });
    }

    // Verificar que ninguna asignación del II Período tenga sesiones de asistencia
    const idsII = interR.rows.flatMap(r => [r.asig_hogar_ii, r.asig_indus_ii]).filter(Boolean);
    if (idsII.length) {
      const sesR = await client.query(`
        SELECT asignacion_id, COUNT(*) AS c
        FROM sesiones_asistencia
        WHERE asignacion_id = ANY($1::int[])
        GROUP BY asignacion_id
      `, [idsII]);
      if (sesR.rows.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: `No se puede revertir: ya hay sesiones de asistencia tomadas en las asignaciones del II Período. Si necesitás hacer cambios, hacelos manualmente desde el módulo de asignaciones.`
        });
      }
    }

    // Borrar las asignaciones del II Período creadas por el intercambio
    if (idsII.length) {
      await client.query(`DELETE FROM asignaciones WHERE id = ANY($1::int[])`, [idsII]);
    }
    // Marcar los registros del histórico como revertidos
    await client.query(`UPDATE intercambios_periodo SET revertido=true WHERE revertido=false`);

    await client.query('COMMIT');
    res.json({ ok: true, revertidos: interR.rows.length });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('periodos/revertir error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ── HISTORIAL de intercambios ────────────────────────────────────────────────
router.get("/historial", canSwap, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT ip.*,
        s.nombre AS seccion_nombre,
        u.nombre AS exec_nombre, u.primer_apellido AS exec_ap1
      FROM intercambios_periodo ip
      JOIN secciones s ON s.id=ip.seccion_id
      LEFT JOIN usuarios u ON u.id=ip.ejecutado_por
      ORDER BY ip.created_at DESC
    `);
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
