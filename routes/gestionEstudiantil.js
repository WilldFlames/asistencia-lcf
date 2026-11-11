const router=require('express').Router();
const {pool}=require('../db');
const {obtenerAnioActivo}=require('../utils/lectivo');

function permitido(req,res,next){
  const u=req.session.usuario;
  if(['admin','auxiliar'].includes(u?.rol)) return next();
  return res.status(403).json({error:'Esta gestión es exclusiva de Auxiliares y Administración.'});
}
const nombre=`TRIM(CONCAT_WS(' ',e.nombre,e.primer_apellido,e.segundo_apellido))`;
const nombreUsuario=`TRIM(CONCAT_WS(' ',u.nombre,u.primer_apellido,u.segundo_apellido))`;

router.get('/estudiantes',permitido,async(req,res)=>{
  const q=String(req.query.q||'').trim(),params=[];
  let filtro='WHERE e.activo=true AND COALESCE(e.archivado,false)=false';
  if(q){params.push(`%${q}%`);filtro+=` AND (e.cedula ILIKE $1 OR ${nombre} ILIKE $1)`;}
  const r=await pool.query(`SELECT e.id,e.cedula,${nombre} AS nombre,s.nombre AS seccion,s.nivel
    FROM estudiantes e LEFT JOIN secciones s ON s.id=e.seccion_id ${filtro}
    ORDER BY s.nivel,s.nombre,e.primer_apellido,e.segundo_apellido,e.nombre LIMIT 300`,params);
  res.json(r.rows);
});

router.post('/constancias',permitido,async(req,res)=>{
  const tipo=String(req.body?.tipo||'');
  if(!['regular','retiro'].includes(tipo)) return res.status(400).json({error:'Tipo de constancia inválido.'});
  const estudianteId=Number(req.body?.estudiante_id),anio=Number(req.body?.anio)||await obtenerAnioActivo();
  const est=await pool.query(`SELECT e.id,e.cedula,${nombre} AS nombre,COALESCE(s.nombre,'') AS seccion
    FROM estudiantes e LEFT JOIN secciones s ON s.id=e.seccion_id WHERE e.id=$1`,[estudianteId]);
  if(!est.rows.length) return res.status(404).json({error:'Estudiante no encontrado.'});
  const fecha=String(req.body?.fecha_documento||'').slice(0,10)||new Date().toISOString().slice(0,10);
  const fechaRetiro=tipo==='retiro'?String(req.body?.fecha_retiro||'').slice(0,10)||fecha:null;
  const motivo=String(req.body?.motivo||'').trim();
  const datos=req.body?.datos&&typeof req.body.datos==='object'?req.body.datos:{};
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`,[`constancia:${tipo}:${anio}`]);
    const n=await client.query(`SELECT COALESCE(MAX(numero),0)+1 AS numero FROM constancias_estudiantiles WHERE tipo=$1 AND anio=$2`,[tipo,anio]);
    const numero=Number(n.rows[0].numero),e=est.rows[0];
    const ins=await client.query(`INSERT INTO constancias_estudiantiles
      (tipo,anio,numero,estudiante_id,estudiante_nombre,estudiante_cedula,seccion_nombre,fecha_documento,fecha_retiro,motivo,emitida_por,datos)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb) RETURNING *`,
      [tipo,anio,numero,e.id,e.nombre,e.cedula,e.seccion,fecha,fechaRetiro,motivo,req.session.usuario.id,JSON.stringify(datos)]);
    await client.query('COMMIT');
    res.json({...ins.rows[0],consecutivo:`${tipo==='retiro'?'RET':'CER'}-${String(numero).padStart(3,'0')}-${anio}`});
  }catch(err){await client.query('ROLLBACK');throw err;}finally{client.release();}
});

router.get('/constancias',permitido,async(req,res)=>{
  const tipo=['regular','retiro'].includes(req.query.tipo)?req.query.tipo:null;
  const anio=Number(req.query.anio)||await obtenerAnioActivo(),params=[anio];
  let filtro='c.anio=$1'; if(tipo){params.push(tipo);filtro+=' AND c.tipo=$2';}
  const r=await pool.query(`SELECT c.*,${nombreUsuario} AS emitida_por_nombre,
      (CASE c.tipo WHEN 'retiro' THEN 'RET' ELSE 'CER' END)||'-'||LPAD(c.numero::text,3,'0')||'-'||c.anio AS consecutivo
    FROM constancias_estudiantiles c LEFT JOIN usuarios u ON u.id=c.emitida_por
    WHERE ${filtro} ORDER BY c.tipo,c.numero DESC`,params);
  res.json(r.rows);
});

router.get('/traslados',permitido,async(req,res)=>{
  const anio=Number(req.query.anio)||await obtenerAnioActivo();
  const r=await pool.query(`SELECT t.*,${nombre} AS estudiante_nombre,e.cedula,s.nombre AS seccion,
      ${nombreUsuario} AS registrado_por_nombre,
      COALESCE(json_agg(json_build_object('id',n.id,'materia_id',m.id,'materia',m.nombre,'nota',n.nota)
        ORDER BY m.nombre) FILTER(WHERE n.id IS NOT NULL),'[]') AS notas
    FROM traslados_ingreso t JOIN estudiantes e ON e.id=t.estudiante_id LEFT JOIN secciones s ON s.id=e.seccion_id
    LEFT JOIN usuarios u ON u.id=t.registrado_por LEFT JOIN notas_traslado n ON n.traslado_id=t.id AND n.activa=true
    LEFT JOIN materias m ON m.id=n.materia_id WHERE t.anio=$1
    GROUP BY t.id,e.nombre,e.primer_apellido,e.segundo_apellido,e.cedula,s.nombre,u.nombre,u.primer_apellido,u.segundo_apellido
    ORDER BY t.fecha_ingreso DESC,e.primer_apellido,e.segundo_apellido,e.nombre`,[anio]);
  res.json(r.rows);
});

router.get('/traslados/materias/:estudianteId',permitido,async(req,res)=>{
  const r=await pool.query(`SELECT DISTINCT m.id,m.nombre FROM estudiantes e JOIN secciones s ON s.id=e.seccion_id
    JOIN asignaciones a ON a.seccion_id=s.id JOIN materias m ON m.id=a.materia_id
    WHERE e.id=$1 AND m.nombre NOT IN ('Guía','Orientación') ORDER BY m.nombre`,[req.params.estudianteId]);
  res.json(r.rows);
});

router.post('/traslados',permitido,async(req,res)=>{
  const estudianteId=Number(req.body?.estudiante_id),anio=Number(req.body?.anio)||await obtenerAnioActivo();
  const fecha=String(req.body?.fecha_ingreso||'').slice(0,10),centro=String(req.body?.centro_procedencia||'').trim();
  const notas=Array.isArray(req.body?.notas)?req.body.notas:[];
  if(!estudianteId||!fecha||!centro) return res.status(400).json({error:'Complete estudiante, fecha de ingreso y centro de procedencia.'});
  if(!notas.length) return res.status(400).json({error:'Ingrese al menos una nota por materia.'});
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const tr=await client.query(`INSERT INTO traslados_ingreso(estudiante_id,anio,fecha_ingreso,centro_procedencia,observaciones,registrado_por)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(estudiante_id,anio) DO UPDATE SET fecha_ingreso=EXCLUDED.fecha_ingreso,
      centro_procedencia=EXCLUDED.centro_procedencia,observaciones=EXCLUDED.observaciones,registrado_por=EXCLUDED.registrado_por,updated_at=NOW()
      RETURNING id`,[estudianteId,anio,fecha,centro,String(req.body?.observaciones||''),req.session.usuario.id]);
    for(const x of notas){
      const materiaId=Number(x.materia_id),nota=Number(x.nota);
      if(!materiaId||!Number.isFinite(nota)||nota<0||nota>100) throw new Error('Hay una nota de traslado inválida.');
      const previa=await client.query(`SELECT id,nota FROM notas_traslado WHERE estudiante_id=$1 AND materia_id=$2 AND anio=$3 AND periodo='I Período'`,[estudianteId,materiaId,anio]);
      const nr=await client.query(`INSERT INTO notas_traslado(traslado_id,estudiante_id,materia_id,anio,nota,registrada_por)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(estudiante_id,materia_id,anio,periodo) DO UPDATE SET
        traslado_id=EXCLUDED.traslado_id,nota=EXCLUDED.nota,registrada_por=EXCLUDED.registrada_por,activa=true,updated_at=NOW() RETURNING id`,
        [tr.rows[0].id,estudianteId,materiaId,anio,nota,req.session.usuario.id]);
      await client.query(`INSERT INTO notas_traslado_auditoria(nota_traslado_id,estudiante_id,materia_id,anio,nota_anterior,nota_nueva,accion,usuario_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[nr.rows[0].id,estudianteId,materiaId,anio,previa.rows[0]?.nota??null,nota,previa.rows.length?'actualizada':'creada',req.session.usuario.id]);
    }
    await client.query('COMMIT');res.json({ok:true,id:tr.rows[0].id});
  }catch(err){await client.query('ROLLBACK');res.status(400).json({error:err.message});}finally{client.release();}
});

router.get('/encargados-temporales',permitido,async(req,res)=>{
  const r=await pool.query(`SELECT t.*,${nombre} AS estudiante_nombre,e.cedula,s.nombre AS seccion,${nombreUsuario} AS registrado_por_nombre
    FROM encargados_temporales t JOIN estudiantes e ON e.id=t.estudiante_id LEFT JOIN secciones s ON s.id=e.seccion_id
    LEFT JOIN usuarios u ON u.id=t.registrado_por ORDER BY t.estado='vigente' DESC,t.created_at DESC`);
  res.json(r.rows);
});

router.post('/encargados-temporales',permitido,async(req,res)=>{
  const b=req.body||{},permanente=b.permanente===true,estudianteId=Number(b.estudiante_id);
  for(const campo of ['nombre','primer_apellido','motivo','fecha_inicio','entidad_autoriza','numero_resolucion'])
    if(!String(b[campo]||'').trim()) return res.status(400).json({error:`Falta el campo ${campo.replaceAll('_',' ')}.`});
  if(!estudianteId||(!permanente&&!b.fecha_fin)) return res.status(400).json({error:'Indique estudiante y fecha final, o marque permanente.'});
  if(permanente&&!String(b.cedula||'').trim()) return res.status(400).json({error:'El encargado permanente debe tener cédula.'});
  const client=await pool.connect();
  try{
    await client.query('BEGIN'); let encargadoId=null;
    if(permanente){
      await client.query('UPDATE encargados SET es_principal=false WHERE estudiante_id=$1',[estudianteId]);
      const enc=await client.query(`INSERT INTO encargados(estudiante_id,cedula,nombre,primer_apellido,segundo_apellido,parentesco,telefono,celular,telefono_trabajo,lugar_trabajo,email,direccion,nacionalidad,profesion,es_principal)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,true) RETURNING id`,[estudianteId,b.cedula||'',b.nombre,b.primer_apellido,b.segundo_apellido||'',b.parentesco||'',b.telefono||'',b.celular||'',b.telefono_trabajo||'',b.lugar_trabajo||'',b.email||'',b.direccion||'',b.nacionalidad||'',b.profesion||'']);
      encargadoId=enc.rows[0].id;
    }
    const r=await client.query(`INSERT INTO encargados_temporales(estudiante_id,cedula,nombre,primer_apellido,segundo_apellido,parentesco,telefono,celular,telefono_trabajo,lugar_trabajo,email,direccion,nacionalidad,profesion,motivo,fecha_inicio,fecha_fin,permanente,entidad_autoriza,numero_resolucion,estado,registrado_por,encargado_permanente_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23) RETURNING id`,[estudianteId,b.cedula||'',b.nombre,b.primer_apellido,b.segundo_apellido||'',b.parentesco||'',b.telefono||'',b.celular||'',b.telefono_trabajo||'',b.lugar_trabajo||'',b.email||'',b.direccion||'',b.nacionalidad||'',b.profesion||'',b.motivo,b.fecha_inicio,permanente?null:b.fecha_fin,permanente,b.entidad_autoriza,b.numero_resolucion,permanente?'sustituido':'vigente',req.session.usuario.id,encargadoId]);
    await client.query('COMMIT');res.json({ok:true,id:r.rows[0].id,encargado_permanente_id:encargadoId});
  }catch(err){await client.query('ROLLBACK');throw err;}finally{client.release();}
});

router.put('/encargados-temporales/:id/finalizar',permitido,async(req,res)=>{
  const r=await pool.query(`UPDATE encargados_temporales SET estado='finalizado',fecha_fin=COALESCE(fecha_fin,CURRENT_DATE),finalizado_por=$2,updated_at=NOW()
    WHERE id=$1 AND estado='vigente' RETURNING id`,[req.params.id,req.session.usuario.id]);
  if(!r.rows.length) return res.status(404).json({error:'Registro vigente no encontrado.'});
  res.json({ok:true});
});

module.exports=router;
