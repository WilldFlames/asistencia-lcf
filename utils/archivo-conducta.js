async function archivarConductaDetallada(db,{estudianteId=null,anio=null}={}){
  const r=await db.query(`
    INSERT INTO expediente_conducta_detalle (
      estudiante_id,boleta_origen_id,anio,periodo,fecha,infraccion_tipo,puntos,
      infraccion_descripcion,observacion,materia_nombre,responsable_nombre,registrado_por_nombre
    )
    SELECT b.estudiante_id,b.id,EXTRACT(YEAR FROM b.fecha)::int,
      CASE
        WHEN al.periodo_i_inicio IS NOT NULL AND b.fecha BETWEEN al.periodo_i_inicio AND al.periodo_i_fin THEN 'I Período'
        WHEN al.periodo_ii_inicio IS NOT NULL AND b.fecha BETWEEN al.periodo_ii_inicio AND al.periodo_ii_fin THEN 'II Período'
        WHEN EXTRACT(MONTH FROM b.fecha)::int <= 7 THEN 'I Período'
        ELSE 'II Período'
      END,
      b.fecha,i.tipo,i.puntos,i.descripcion,b.observacion,m.nombre,
      NULLIF(TRIM(CONCAT_WS(' ',COALESCE(u.nombre,ap.nombre),COALESCE(u.primer_apellido,ap.primer_apellido),COALESCE(u.segundo_apellido,ap.segundo_apellido))),''),
      NULLIF(TRIM(CONCAT_WS(' ',reg.nombre,reg.primer_apellido,reg.segundo_apellido)),'')
    FROM boletas_conducta b
    JOIN infracciones i ON i.id=b.infraccion_id
    LEFT JOIN asignaciones a ON a.id=b.asignacion_id
    LEFT JOIN materias m ON m.id=a.materia_id
    LEFT JOIN usuarios u ON u.id=a.profesor_id
    LEFT JOIN usuarios ap ON ap.id=b.usuario_apoyo_id
    LEFT JOIN usuarios reg ON reg.id=b.registrado_por
    LEFT JOIN anios_lectivos al ON al.anio=EXTRACT(YEAR FROM b.fecha)::int
    WHERE ($1::int IS NULL OR b.estudiante_id=$1)
      AND ($2::int IS NULL OR EXTRACT(YEAR FROM b.fecha)::int=$2)
    ON CONFLICT (estudiante_id,boleta_origen_id) DO UPDATE SET
      anio=EXCLUDED.anio,periodo=EXCLUDED.periodo,fecha=EXCLUDED.fecha,
      infraccion_tipo=EXCLUDED.infraccion_tipo,puntos=EXCLUDED.puntos,
      infraccion_descripcion=EXCLUDED.infraccion_descripcion,observacion=EXCLUDED.observacion,
      materia_nombre=EXCLUDED.materia_nombre,responsable_nombre=EXCLUDED.responsable_nombre,
      registrado_por_nombre=EXCLUDED.registrado_por_nombre
    RETURNING id
  `,[estudianteId,anio]);
  return r.rows.length;
}

module.exports={archivarConductaDetallada};
