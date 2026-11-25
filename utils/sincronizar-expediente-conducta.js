const { pool } = require("../db");
const { obtenerCalendario } = require("./lectivo");

function redondearUna(n) {
  return Math.round((Number(n) + Number.EPSILON) * 10) / 10;
}

async function calcularNotaAnualConducta(estudianteId, anio, db = pool) {
  const cal = await obtenerCalendario(anio, db);
  const desdeI = cal.periodo_i_inicio || `${anio}-01-01`;
  const hastaI = cal.periodo_i_fin || `${anio}-06-30`;
  const desdeII = cal.periodo_ii_inicio || `${anio}-07-01`;
  const hastaII = cal.periodo_ii_fin || `${anio}-12-31`;
  const r = await db.query(`
    SELECT e.id AS estudiante_id,e.seccion_id,s.nivel,
      COALESCE(SUM(i.puntos) FILTER(WHERE b.fecha BETWEEN $2 AND $3
        AND (b.debido_proceso_id IS NULL OR dp.estado='resuelto'
          OR (dp.estado IN ('pendiente_archivo','archivado') AND dp.estado_previo_archivo='resuelto'))),0) AS puntos_i,
      COALESCE(SUM(i.puntos) FILTER(WHERE b.fecha BETWEEN $4 AND $5
        AND (b.debido_proceso_id IS NULL OR dp.estado='resuelto'
          OR (dp.estado IN ('pendiente_archivo','archivado') AND dp.estado_previo_archivo='resuelto'))),0) AS puntos_ii
    FROM estudiantes e
    JOIN secciones s ON s.id=e.seccion_id
    LEFT JOIN boletas_conducta b ON b.estudiante_id=e.id
    LEFT JOIN infracciones i ON i.id=b.infraccion_id
    LEFT JOIN debidos_procesos dp ON dp.id=b.debido_proceso_id
    WHERE e.id=$1
    GROUP BY e.id,e.seccion_id,s.nivel`,
    [estudianteId,desdeI,hastaI,desdeII,hastaII]);
  if (!r.rows.length) return null;
  const x = r.rows[0];
  const notaI = Math.max(0, 100 - Number(x.puntos_i || 0));
  const notaII = Math.max(0, 100 - Number(x.puntos_ii || 0));
  const minimo = Number(x.nivel) <= 9 ? 65 : 70;
  const notaAnual=redondearUna((notaI + notaII) / 2);
  return {
    estudiante_id: Number(x.estudiante_id),
    seccion_id: Number(x.seccion_id),
    nivel: Number(x.nivel),
    nota_i: notaI,
    nota_ii: notaII,
    nota_anual: notaAnual,
    nota_anual_redondeada: Math.round(notaAnual),
    minimo,
  };
}

// Mientras siga aplazado, el expediente conserva la nota inicial y su avance.
// Al alcanzar el mínimo, se archiva la copia y se libera el consecutivo.
async function sincronizarExpedienteConductaAbierto(estudianteId, anio, db = pool) {
  const nota = await calcularNotaAnualConducta(estudianteId, anio, db);
  if (!nota) return { existe: false };
  const er = await db.query(`SELECT * FROM expedientes_conducta_tes
    WHERE estudiante_id=$1 AND anio=$2 AND estado='en_curso' LIMIT 1`,
    [estudianteId,anio]);
  const expediente = er.rows[0];
  if (!expediente) return { existe: false, ...nota };

  if (nota.nota_anual_redondeada < nota.minimo) {
    return { existe: true, eliminado: false, expediente_id: expediente.id, numero: expediente.numero, ...nota };
  }

  const borrado = await db.query(`WITH retirado AS (
      DELETE FROM expedientes_conducta_tes
      WHERE id=$1 AND estado='en_curso' RETURNING *
    )
    INSERT INTO expedientes_conducta_cancelados
      (expediente_id_original,numero,anio,estudiante_id,seccion_id,guia_id,creado_por,
       nota_anual_previa,nota_anual_actual,minimo,estado_original,
       expediente_snapshot,pasos_snapshot,aprobaciones_snapshot,motivo)
    SELECT ec.id,ec.numero,ec.anio,ec.estudiante_id,ec.seccion_id,ec.guia_id,ec.creado_por,
      ec.nota_anual,$2,$3,ec.estado,to_jsonb(ec),
      COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.paso)
        FROM expedientes_conducta_pasos p WHERE p.expediente_id=ec.id),'[]'::jsonb),
      COALESCE((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.aprobado_en)
        FROM expedientes_conducta_aprobaciones a WHERE a.expediente_id=ec.id),'[]'::jsonb),
      $4
    FROM retirado ec
    ON CONFLICT(expediente_id_original) DO UPDATE SET
      nota_anual_actual=EXCLUDED.nota_anual_actual,minimo=EXCLUDED.minimo,
      expediente_snapshot=EXCLUDED.expediente_snapshot,
      pasos_snapshot=EXCLUDED.pasos_snapshot,
      aprobaciones_snapshot=EXCLUDED.aprobaciones_snapshot,
      motivo=EXCLUDED.motivo,cancelado_at=NOW()
    RETURNING expediente_id_original`,
    [expediente.id,nota.nota_anual,nota.minimo,
      `Cancelación automática: la nota anual de ${nota.nota_anual} redondea a ${nota.nota_anual_redondeada} y alcanza el mínimo de ${nota.minimo}.`]);
  return {
    existe: true,
    eliminado: borrado.rows.length > 0,
    expediente_id: expediente.id,
    numero: expediente.numero,
    ...nota,
  };
}

async function sincronizarExpedientesConductaAbiertos(anio, db = pool) {
  const r = await db.query(`SELECT DISTINCT estudiante_id
    FROM expedientes_conducta_tes WHERE anio=$1 AND estado='en_curso'
    ORDER BY estudiante_id`,[anio]);
  const resultados = [];
  for (const fila of r.rows) {
    resultados.push(await sincronizarExpedienteConductaAbierto(fila.estudiante_id, anio, db));
  }
  return resultados;
}

module.exports = {
  calcularNotaAnualConducta,
  sincronizarExpedienteConductaAbierto,
  sincronizarExpedientesConductaAbiertos,
};
