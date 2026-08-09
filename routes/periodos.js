const router = require("express").Router();
const { pool } = require("../db");
const { requireRol } = require("../middleware/auth");

// Roles autorizados: admin, auxiliar y administrativo pueden hacer intercambio.
// (Antes solo admin y auxiliar — administrativo también debería poder).
const canSwap = requireRol("admin", "auxiliar", "administrativo");

// Nombres oficiales de las materias intercambiables. La búsqueda en la BD
// es case-insensitive (con ILIKE) por si en algún seed quedó con mayúsculas
// distintas.
const NOMBRE_HOGAR = "Educación para el Hogar";
const NOMBRE_INDUSTRIALES = "Artes Industriales";

function periodoActualNombre() {
  const hoy = new Date();
  return (hoy < new Date('2026-07-04T00:00:00')) ? 'I Período' : 'II Período';
}

// Busca los IDs de las materias Hogar e Industriales de forma tolerante:
// primero intenta con nombre exacto, si no encuentra usa ILIKE.
async function obtenerIdsMaterias(client) {
  const cli = client || pool;
  // Exacto primero
  let r = await cli.query(
    "SELECT id, nombre FROM materias WHERE nombre IN ($1, $2)",
    [NOMBRE_HOGAR, NOMBRE_INDUSTRIALES]);
  let idHogar = r.rows.find(m => m.nombre === NOMBRE_HOGAR)?.id;
  let idIndus = r.rows.find(m => m.nombre === NOMBRE_INDUSTRIALES)?.id;
  // Fallback tolerante
  if (!idHogar) {
    const rh = await cli.query(
      "SELECT id FROM materias WHERE nombre ILIKE $1 LIMIT 1",
      ['%hogar%']);
    if (rh.rows.length) idHogar = rh.rows[0].id;
  }
  if (!idIndus) {
    const ri = await cli.query(
      "SELECT id FROM materias WHERE nombre ILIKE $1 LIMIT 1",
      ['%industriales%']);
    if (ri.rows.length) idIndus = ri.rows[0].id;
  }
  return { idHogar, idIndus };
}

// ── VISTA PREVIA: pares actuales del I Período en 7°-9° ──────────────────────
// Devuelve, agrupado por sección, las asignaciones de Hogar e Industriales
// (incluyendo subgrupos) y el detalle de quién las dicta hoy. Solo muestra
// secciones donde HAY al menos una asignación de Hogar o Industriales.
router.get("/preview", canSwap, async (req, res) => {
  try {
    // Obtener IDs de las materias (con búsqueda tolerante)
    const { idHogar, idIndus } = await obtenerIdsMaterias();

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

    // Agrupar por SECCIÓN (no por subgrupo). Dentro de cada sección
    // recolectamos todos los subgrupos con Hogar y con Industriales, para
    // que el frontend muestre los intercambios como pares "Hogar subgrupo A
    // ↔ Industriales subgrupo B" claramente.
    const secciones = {};
    for (const a of asigR.rows) {
      if (!secciones[a.seccion_id]) {
        secciones[a.seccion_id] = {
          seccion_id: a.seccion_id,
          seccion_nombre: a.seccion_nombre,
          nivel: a.nivel,
          hogar: [],        // lista de {subgrupo, prof_nombre, ...}
          industriales: [],
          ya_intercambiado: false
        };
      }
      const info = {
        asignacion_id: a.id,
        subgrupo: a.subgrupo || null,
        prof_id: a.prof_id,
        prof_nombre: `${a.prof_nombre} ${a.prof_ap1} ${a.prof_ap2 || ''}`.replace(/\s+/g,' ').trim(),
        lecciones_semana: a.lecciones_semana
      };
      if (a.materia_id === idHogar) secciones[a.seccion_id].hogar.push(info);
      else secciones[a.seccion_id].industriales.push(info);
    }

    // Marcar las secciones que ya tienen intercambios en II Período
    Object.values(secciones).forEach(sec => {
      sec.hogar.sort((a,b) => (a.subgrupo||'').localeCompare(b.subgrupo||''));
      sec.industriales.sort((a,b) => (a.subgrupo||'').localeCompare(b.subgrupo||''));
      // Se considera "ya intercambiada" si existe alguna asignación de II en esta sección
      sec.ya_intercambiado = [...yaExiste].some(k => k.startsWith(`${sec.seccion_id}|`));
    });

    const lista = Object.values(secciones).sort((a, b) => {
      if (a.nivel !== b.nivel) return a.nivel - b.nivel;
      return a.seccion_nombre.localeCompare(b.seccion_nombre);
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

    const { idHogar, idIndus } = await obtenerIdsMaterias(client);
    if (!idHogar || !idIndus) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: `No se encontraron las materias en la BD.`
      });
    }

    // Recolectar todas las asignaciones de Hogar/Industriales en 7°-9° del I Período
    const asigR = await client.query(`
      SELECT a.id, a.profesor_id, a.seccion_id, a.materia_id, a.subgrupo, a.lecciones_semana,
        s.nivel, s.nombre AS seccion_nombre
      FROM asignaciones a
      JOIN secciones s ON s.id=a.seccion_id
      WHERE a.materia_id IN ($1, $2)
        AND s.nivel BETWEEN 7 AND 9
        AND COALESCE(a.periodo,'I Período') = 'I Período'
    `, [idHogar, idIndus]);

    // Agrupar por SECCIÓN (no por sección+subgrupo). Dentro de cada sección
    // recolectamos todas las asignaciones de Hogar y de Industriales por
    // subgrupo. La lógica del intercambio es: el subgrupo que tenía Hogar
    // en el I Período, ahora tiene Industriales en el II (y viceversa).
    // Cada profe MANTIENE su materia y su sección — solo cambia de subgrupo.
    const secciones = {};
    for (const a of asigR.rows) {
      if (!secciones[a.seccion_id]) {
        secciones[a.seccion_id] = {
          seccion_id: a.seccion_id,
          seccion_nombre: a.seccion_nombre,
          nivel: a.nivel,
          hogar: [],       // asignaciones de Hogar (con sus subgrupos)
          industriales: [] // asignaciones de Industriales (con sus subgrupos)
        };
      }
      if (a.materia_id === idHogar) secciones[a.seccion_id].hogar.push(a);
      else secciones[a.seccion_id].industriales.push(a);
    }

    // Verificar qué pares del II Período ya están creados
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

    for (const sec of Object.values(secciones)) {
      // Para intercambiar necesitamos AL MENOS un Hogar y un Industriales
      // en la misma sección, con subgrupos distintos entre sí.
      if (!sec.hogar.length || !sec.industriales.length) {
        saltados++;
        detalle.push({
          seccion_id: sec.seccion_id, seccion_nombre: sec.seccion_nombre,
          resultado: 'omitido',
          motivo: 'Falta Hogar o Industriales en esta sección'
        });
        continue;
      }

      // Emparejar: cada asignación de Hogar (subgrupo X) se cruza con la de
      // Industriales de OTRO subgrupo. En el modelo estándar del liceo, cada
      // sección tiene 2 subgrupos: A y B. Hogar A se cruza con Industriales B,
      // resultando en: profe de Hogar A ahora enseña Hogar B, y profe de
      // Industriales B ahora enseña Industriales A.
      //
      // Si hay más de un subgrupo por materia (raro), emparejamos por orden.
      const subgruposHogar = sec.hogar.slice().sort((a,b) => (a.subgrupo||'').localeCompare(b.subgrupo||''));
      const subgruposIndus = sec.industriales.slice().sort((a,b) => (a.subgrupo||'').localeCompare(b.subgrupo||''));

      // Verificar que los subgrupos sean DISTINTOS entre Hogar e Industriales
      // (si un profe da Hogar al subgrupo A y otro Industriales también al A,
      // no hay intercambio posible: hay conflicto de horario).
      const subgH = new Set(subgruposHogar.map(a => a.subgrupo || ''));
      const subgI = new Set(subgruposIndus.map(a => a.subgrupo || ''));
      const hayInterseccion = [...subgH].some(x => subgI.has(x));
      if (hayInterseccion) {
        saltados++;
        detalle.push({
          seccion_id: sec.seccion_id, seccion_nombre: sec.seccion_nombre,
          resultado: 'omitido',
          motivo: 'Hay subgrupos compartidos entre Hogar e Industriales (no se pueden intercambiar)'
        });
        continue;
      }

      // Para cada asignación de Hogar, creamos una nueva en II Período con
      // el MISMO profe, MISMA sección, MISMA materia (Hogar), pero con el
      // SUBGRUPO del que daba Industriales.
      // Y viceversa para Industriales.
      let alguIntercambio = false;
      const paresProcesados = Math.min(subgruposHogar.length, subgruposIndus.length);

      for (let i = 0; i < paresProcesados; i++) {
        const aH = subgruposHogar[i];    // El profe X daba Hogar al subgrupo aH.subgrupo
        const aI = subgruposIndus[i];    // El profe Y daba Industriales al subgrupo aI.subgrupo

        // En II Período:
        //   Profe X sigue con Hogar en la sección, pero ahora con el subgrupo de aI
        //   Profe Y sigue con Industriales en la sección, pero ahora con el subgrupo de aH
        const kNuevaHogar = `${sec.seccion_id}|${idHogar}|${aI.subgrupo || ''}`;
        const kNuevaIndus = `${sec.seccion_id}|${idIndus}|${aH.subgrupo || ''}`;
        if (yaExiste.has(kNuevaHogar) || yaExiste.has(kNuevaIndus)) {
          continue;  // ya se hizo antes, saltar
        }

        const nuevaHogar = await client.query(`
          INSERT INTO asignaciones (profesor_id, seccion_id, materia_id, subgrupo, lecciones_semana, periodo)
          VALUES ($1, $2, $3, $4, $5, 'II Período') RETURNING id
        `, [aH.profesor_id, sec.seccion_id, idHogar, aI.subgrupo, aH.lecciones_semana]);

        const nuevaIndus = await client.query(`
          INSERT INTO asignaciones (profesor_id, seccion_id, materia_id, subgrupo, lecciones_semana, periodo)
          VALUES ($1, $2, $3, $4, $5, 'II Período') RETURNING id
        `, [aI.profesor_id, sec.seccion_id, idIndus, aH.subgrupo, aI.lecciones_semana]);

        await client.query(`
          INSERT INTO intercambios_periodo
            (nivel, seccion_id, asig_hogar_i, asig_indus_i, asig_hogar_ii, asig_indus_ii, ejecutado_por)
          SELECT s.nivel, $1, $2, $3, $4, $5, $6 FROM secciones s WHERE s.id=$1
        `, [sec.seccion_id, aH.id, aI.id, nuevaHogar.rows[0].id, nuevaIndus.rows[0].id, req.session.usuario.id]);

        alguIntercambio = true;
        intercambiados++;
        detalle.push({
          seccion_id: sec.seccion_id, seccion_nombre: sec.seccion_nombre,
          resultado: 'intercambiado',
          hogar_original_subgrupo: aH.subgrupo,
          hogar_nuevo_subgrupo: aI.subgrupo,
          industriales_original_subgrupo: aI.subgrupo,
          industriales_nuevo_subgrupo: aH.subgrupo
        });
      }

      if (!alguIntercambio) {
        saltados++;
        detalle.push({
          seccion_id: sec.seccion_id, seccion_nombre: sec.seccion_nombre,
          resultado: 'omitido',
          motivo: 'Ya existe asignación del II Período para esta sección'
        });
      }
    }

    await client.query('COMMIT');
    console.log(`[INTERCAMBIO] Ejecutado por usuario ${req.session.usuario.id} (${req.session.usuario.rol}): ${intercambiados} pares intercambiados, ${saltados} omitidos.`);
    res.json({ ok: true, intercambiados, saltados, detalle });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[INTERCAMBIO] Error:', err.code || '', err.message);
    console.error('   Detail:', err.detail || '(sin detalle)');
    console.error('   Stack:', err.stack);
    res.status(500).json({ error: err.message + (err.detail ? ' — ' + err.detail : '') });
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
