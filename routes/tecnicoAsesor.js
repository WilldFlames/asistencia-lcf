const router=require('express').Router();
const {pool}=require('../db');
const asyncRoute=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);

function esCTA(u){ return u?.rol==='admin'||(u?.funciones_extra||[]).includes('comite_tecnico_asesor'); }
function exigirCTA(req,res,next){ if(!esCTA(req.session.usuario)) return res.status(403).json({error:'Solo el Comité Técnico Asesor puede modificar calendarios.'}); next(); }
const fechaCR=()=>new Date(new Date().toLocaleString('en-US',{timeZone:'America/Costa_Rica'})).toISOString().slice(0,10);
const diaSemana=f=>new Date(`${f}T12:00:00Z`).getUTCDay();
const lecciones=[['07:00','07:40'],['07:40','08:20'],['08:35','09:15'],['09:15','09:55'],['10:10','10:50'],['10:50','11:30'],['11:40','12:20'],['12:20','13:00'],['13:25','14:05'],['14:05','14:45'],['14:55','15:35'],['15:35','16:15']];
const rondas=['07:00','09:15','12:00','14:10'];
const sumarMinutos=(hora,minutos)=>{const [h,m]=String(hora).slice(0,5).split(':').map(Number),total=h*60+m+minutos;return `${String(Math.floor(total/60)).padStart(2,'0')}:${String(total%60).padStart(2,'0')}`;};
const leccionDeHora=h=>{const x=String(h||'').slice(0,5);const i=lecciones.findIndex(([a,b])=>x>=a&&x<b);return i<0?null:i+1;};
const leccionesDelRango=(inicio,fin)=>lecciones.map(([a,b],i)=>({a,b,n:i+1})).filter(l=>l.a<String(fin).slice(0,5)&&l.b>String(inicio).slice(0,5)).map(l=>l.n);

async function candidatosCuido(client,e,calendarioId,adecuacionId=0){
  const fecha=String(e.fecha).slice(0,10),dia=diaSemana(fecha),anio=Number(fecha.slice(0,4)),lecs=leccionesDelRango(e.hora_inicio,e.hora_fin);
  if(dia<1||dia>5||!lecs.length)return [];
  const r=await client.query(`
    SELECT u.id,u.nombre,u.primer_apellido,u.segundo_apellido,
      ((SELECT COUNT(*) FROM calendario_pruebas_cuidos cx JOIN calendario_pruebas_eventos ex ON ex.id=cx.evento_id WHERE ex.calendario_id=$4 AND cx.profesor_id=u.id)+(SELECT COUNT(*) FROM calendario_pruebas_cuidos_adecuacion ax WHERE ax.calendario_id=$4 AND ax.profesor_id=u.id))::int AS total_cuidos,
      ((SELECT COUNT(*) FROM calendario_pruebas_cuidos cx JOIN calendario_pruebas_eventos ex ON ex.id=cx.evento_id WHERE ex.calendario_id=$4 AND cx.profesor_id=u.id AND ex.fecha=$6::date)+(SELECT COUNT(*) FROM calendario_pruebas_cuidos_adecuacion ax WHERE ax.calendario_id=$4 AND ax.profesor_id=u.id AND ax.fecha=$6::date))::int AS cuidos_dia
    FROM usuarios u
    JOIN asignaciones a ON a.profesor_id=u.id AND a.anio=$1 AND COALESCE(a.activa,true)=true
    JOIN horarios h ON h.asignacion_id=a.id AND h.anio=$1 AND h.dia=$2 AND h.leccion=ANY($3::int[])
    WHERE u.activo=true AND u.rol IN ('profesor','profesor_guia')
      AND NOT EXISTS (
        SELECT 1 FROM calendario_pruebas_cuidos co JOIN calendario_pruebas_eventos eo ON eo.id=co.evento_id
        WHERE co.profesor_id=u.id AND eo.fecha=$6::date AND eo.id<>$9
          AND eo.hora_inicio<$8::time AND eo.hora_fin>$7::time
      )
      AND NOT EXISTS (
        SELECT 1 FROM calendario_pruebas_cuidos_adecuacion ao
        WHERE ao.profesor_id=u.id AND ao.fecha=$6::date AND ao.id<>$10
          AND ao.hora_inicio<$8::time AND ao.hora_fin>$7::time
      )
    GROUP BY u.id,u.nombre,u.primer_apellido,u.segundo_apellido
    HAVING COUNT(DISTINCT h.leccion)=$5
    ORDER BY total_cuidos ASC,cuidos_dia ASC,u.primer_apellido,u.segundo_apellido,u.nombre
  `,[anio,dia,lecs,calendarioId,lecs.length,fecha,String(e.hora_inicio).slice(0,5),String(e.hora_fin).slice(0,5),e.id||0,adecuacionId||0]);
  return r.rows;
}

router.get('/calendarios',async(req,res)=>{
  const u=req.session.usuario,hoy=fechaCR();
  const r=await pool.query(`SELECT c.*,u.nombre AS creador_nombre,u.primer_apellido AS creador_ap1,
    (SELECT COUNT(*) FROM calendario_pruebas_eventos e WHERE e.calendario_id=c.id)::int AS eventos
    FROM calendarios_pruebas c LEFT JOIN usuarios u ON u.id=c.creado_por
    WHERE ($1 OR c.estado='publicado') AND ($1 OR c.fecha_fin >= $2::date)
    ORDER BY c.fecha_inicio DESC`,[esCTA(u),hoy]);
  res.json(r.rows);
});
router.post('/calendarios',exigirCTA,async(req,res)=>{
  const {titulo,fecha_inicio,fecha_fin}=req.body;
  if(!titulo?.trim()||!fecha_inicio||!fecha_fin||fecha_fin<fecha_inicio) return res.status(400).json({error:'Título y rango de fechas válidos son requeridos.'});
  const r=await pool.query(`INSERT INTO calendarios_pruebas(titulo,fecha_inicio,fecha_fin,creado_por) VALUES($1,$2,$3,$4) RETURNING *`,[titulo.trim(),fecha_inicio,fecha_fin,req.session.usuario.id]);res.json(r.rows[0]);
});
router.put('/calendarios/:id',exigirCTA,async(req,res)=>{
  const {titulo,fecha_inicio,fecha_fin}=req.body;
  if(fecha_inicio&&fecha_fin&&fecha_fin<fecha_inicio) return res.status(400).json({error:'La fecha final no puede ser anterior a la inicial.'});
  const r=await pool.query(`UPDATE calendarios_pruebas SET titulo=COALESCE($1,titulo),fecha_inicio=COALESCE($2,fecha_inicio),fecha_fin=COALESCE($3,fecha_fin),updated_at=NOW() WHERE id=$4 RETURNING *`,[titulo||null,fecha_inicio||null,fecha_fin||null,req.params.id]);
  if(!r.rows.length)return res.status(404).json({error:'Calendario no encontrado'});res.json(r.rows[0]);
});
router.delete('/calendarios/:id',exigirCTA,async(req,res)=>{
  const r=await pool.query('DELETE FROM calendarios_pruebas WHERE id=$1 RETURNING id',[req.params.id]);
  if(!r.rows.length)return res.status(404).json({error:'Calendario no encontrado'});
  res.json({ok:true});
});
router.put('/calendarios/:id/publicar',exigirCTA,async(req,res)=>{
  const r=await pool.query(`UPDATE calendarios_pruebas SET estado='publicado',publicado_por=$1,publicado_en=NOW(),updated_at=NOW() WHERE id=$2 RETURNING *`,[req.session.usuario.id,req.params.id]);
  if(!r.rows.length)return res.status(404).json({error:'Calendario no encontrado'});
  await pool.query(`INSERT INTO notificaciones(usuario_id,tipo,mensaje) SELECT id,'calendario_pruebas',$1 FROM usuarios WHERE activo=true AND rol IN ('profesor','profesor_guia')`,[`📝 Se publicó el calendario de pruebas: ${r.rows[0].titulo}`]);res.json(r.rows[0]);
});
router.get('/calendarios/:id',async(req,res)=>{
  const c=await pool.query('SELECT * FROM calendarios_pruebas WHERE id=$1',[req.params.id]);if(!c.rows.length)return res.status(404).json({error:'Calendario no encontrado'});
  if(c.rows[0].estado!=='publicado'&&!esCTA(req.session.usuario))return res.status(403).json({error:'Calendario no publicado'});
  const e=await pool.query(`SELECT e.*,s.nombre AS seccion_nombre,s.nivel,(SELECT COUNT(*)::int FROM secciones sx JOIN secciones_anio sa ON sa.seccion_id=sx.id AND sa.anio=EXTRACT(YEAR FROM e.fecha)::int AND sa.activa=true WHERE sx.nivel=s.nivel) AS secciones_nivel_total,
    COALESCE(json_agg(json_build_object('id',cu.id,'profesor_id',cu.profesor_id,'nombre',concat_ws(' ',u.nombre,u.primer_apellido,u.segundo_apellido))) FILTER(WHERE cu.id IS NOT NULL),'[]') AS cuidos
    FROM calendario_pruebas_eventos e JOIN secciones s ON s.id=e.seccion_id LEFT JOIN calendario_pruebas_cuidos cu ON cu.evento_id=e.id LEFT JOIN usuarios u ON u.id=cu.profesor_id
    WHERE e.calendario_id=$1 GROUP BY e.id,s.nombre,s.nivel ORDER BY e.fecha,e.hora_inicio,s.nombre`,[req.params.id]);
  const ad=await pool.query(`SELECT a.*,concat_ws(' ',u.nombre,u.primer_apellido,u.segundo_apellido) AS profesor_nombre FROM calendario_pruebas_cuidos_adecuacion a JOIN usuarios u ON u.id=a.profesor_id WHERE a.calendario_id=$1 ORDER BY a.fecha,a.hora_inicio`,[req.params.id]);
  res.json({calendario:c.rows[0],eventos:e.rows,adecuaciones:ad.rows});
});
router.get('/docentes-cuido',async(req,res)=>{const r=await pool.query(`SELECT id,nombre,primer_apellido,segundo_apellido FROM usuarios WHERE activo=true AND rol IN ('profesor','profesor_guia') ORDER BY primer_apellido,segundo_apellido,nombre`);res.json(r.rows);});
router.get('/cronograma-publicado',async(req,res)=>{const r=await pool.query(`SELECT c.id AS calendario_id,c.titulo,c.fecha_inicio::text,c.fecha_fin::text,e.fecha::text,e.hora_inicio::text,e.hora_fin::text,e.materia,e.seccion_id,s.nombre AS seccion_nombre,s.nivel,(SELECT COUNT(*)::int FROM secciones sx JOIN secciones_anio sa ON sa.seccion_id=sx.id AND sa.anio=EXTRACT(YEAR FROM e.fecha)::int AND sa.activa=true WHERE sx.nivel=s.nivel) AS secciones_nivel_total FROM calendarios_pruebas c JOIN calendario_pruebas_eventos e ON e.calendario_id=c.id JOIN secciones s ON s.id=e.seccion_id WHERE c.estado='publicado' AND c.fecha_fin>=CURRENT_DATE ORDER BY c.fecha_inicio,e.fecha,e.hora_inicio,s.nivel,s.nombre`);res.json(r.rows);});
router.post('/calendarios/:id/eventos',exigirCTA,async(req,res)=>{
  const {fecha,hora_inicio,hora_fin,materia,seccion_id,nivel,niveles,observacion}=req.body;
  const inicio=String(hora_inicio||'').slice(0,5),fin=sumarMinutos(inicio,80);
  const nivelesElegidos=[...new Set((Array.isArray(niveles)?niveles:[nivel]).map(Number).filter(n=>n>=1&&n<=20))];
  if(!fecha||!rondas.includes(inicio)||!materia?.trim()||(!seccion_id&&!nivelesElegidos.length))return res.status(400).json({error:'Completá fecha, una ronda válida, materia y al menos un nivel o sección.'});
  let secciones=[];
  if(nivelesElegidos.length){
    const anio=Number(String(fecha).slice(0,4));
    const s=await pool.query(`SELECT s.id FROM secciones s JOIN secciones_anio sa ON sa.seccion_id=s.id AND sa.anio=$1 AND sa.activa=true WHERE s.nivel=ANY($2::int[]) ORDER BY s.nivel,s.nombre`,[anio,nivelesElegidos]);
    secciones=s.rows.map(x=>x.id);
    if(!secciones.length)return res.status(400).json({error:'No hay secciones activas para los niveles seleccionados en el año de la prueba.'});
  }else secciones=[Number(seccion_id)];
  const client=await pool.connect();
  try{
    await client.query('BEGIN');const creadas=[];
    for(const sid of secciones){const r=await client.query(`INSERT INTO calendario_pruebas_eventos(calendario_id,fecha,hora_inicio,hora_fin,materia,seccion_id,observacion) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[req.params.id,fecha,inicio,fin,materia.trim(),sid,observacion||'']);creadas.push(r.rows[0]);}
    await client.query('COMMIT');res.json({ok:true,creadas,total:creadas.length});
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
});
router.put('/eventos/:id',exigirCTA,async(req,res)=>{
  const {fecha,hora_inicio,hora_fin,materia,seccion_id,observacion}=req.body;
  const inicio=String(hora_inicio||'').slice(0,5);if(!rondas.includes(inicio))return res.status(400).json({error:'Seleccione una de las cuatro rondas disponibles.'});
  const r=await pool.query(`UPDATE calendario_pruebas_eventos SET fecha=$1,hora_inicio=$2,hora_fin=$3,materia=$4,seccion_id=$5,observacion=$6 WHERE id=$7 RETURNING *`,[fecha,inicio,sumarMinutos(inicio,80),materia,seccion_id,observacion||'',req.params.id]);if(!r.rows.length)return res.status(404).json({error:'Prueba no encontrada'});res.json(r.rows[0]);
});
router.delete('/eventos/:id',exigirCTA,async(req,res)=>{await pool.query('DELETE FROM calendario_pruebas_eventos WHERE id=$1',[req.params.id]);res.json({ok:true});});
router.post('/calendarios/:id/generar-cuidos',exigirCTA,asyncRoute(async(req,res)=>{
  const eventos=(await pool.query('SELECT * FROM calendario_pruebas_eventos WHERE calendario_id=$1 ORDER BY fecha,hora_inicio,id',[req.params.id])).rows;
  const sinHorario=[],cuidos=[],adecuaciones=[];
  if(eventos.length){
    const anios=[...new Set(eventos.map(e=>Number(String(e.fecha).slice(0,4))))];
    const filas=(await pool.query(`
      SELECT DISTINCT u.id,u.nombre,u.primer_apellido,u.segundo_apellido,h.anio,h.dia,h.leccion
      FROM usuarios u
      JOIN asignaciones a ON a.profesor_id=u.id AND a.anio=ANY($1::int[]) AND COALESCE(a.activa,true)=true
      JOIN horarios h ON h.asignacion_id=a.id AND h.anio=a.anio
      WHERE u.activo=true AND u.rol IN ('profesor','profesor_guia')
      ORDER BY u.primer_apellido,u.segundo_apellido,u.nombre,u.id
    `,[anios])).rows;
    const mapa=new Map();
    for(const f of filas){
      if(!mapa.has(f.id))mapa.set(f.id,{id:f.id,nombre:`${f.primer_apellido||''} ${f.segundo_apellido||''} ${f.nombre||''}`.trim(),horario:new Set(),total:0,porDia:new Map(),ocupado:new Map()});
      mapa.get(f.id).horario.add(`${f.anio}|${f.dia}|${f.leccion}`);
    }
    const docentes=[...mapa.values()];
    const elegir=e=>{
      const fecha=String(e.fecha).slice(0,10),inicio=String(e.hora_inicio).slice(0,5),fin=String(e.hora_fin).slice(0,5),anio=Number(fecha.slice(0,4)),dia=diaSemana(fecha),lecs=leccionesDelRango(inicio,fin);
      if(dia<1||dia>5||!lecs.length)return null;
      const disponibles=docentes.filter(d=>lecs.every(l=>d.horario.has(`${anio}|${dia}|${l}`))&&!(d.ocupado.get(fecha)||[]).some(x=>inicio<x.fin&&fin>x.inicio));
      disponibles.sort((a,b)=>a.total-b.total||(a.porDia.get(fecha)||0)-(b.porDia.get(fecha)||0)||a.nombre.localeCompare(b.nombre,'es')||a.id-b.id);
      const elegido=disponibles[0];if(!elegido)return null;
      elegido.total++;elegido.porDia.set(fecha,(elegido.porDia.get(fecha)||0)+1);
      if(!elegido.ocupado.has(fecha))elegido.ocupado.set(fecha,[]);
      elegido.ocupado.get(fecha).push({inicio,fin});return elegido;
    };
    const rondasUnicas=[...new Map(eventos.map(e=>[`${String(e.fecha).slice(0,10)}|${String(e.hora_inicio).slice(0,5)}`,e])).values()];
    for(const base of rondasUnicas){
      const fecha=String(base.fecha).slice(0,10),inicio=String(base.hora_inicio).slice(0,5),fin=sumarMinutos(base.hora_inicio,120),docente=elegir({...base,hora_inicio:inicio,hora_fin:fin});
      if(docente)adecuaciones.push({fecha,hora_inicio:inicio,hora_fin:fin,profesor_id:docente.id});else sinHorario.push(`adecuacion:${fecha}:${inicio}`);
    }
    for(const evento of eventos){const docente=elegir(evento);if(docente)cuidos.push({evento_id:evento.id,profesor_id:docente.id});else sinHorario.push(evento.id);}
  }
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    await client.query('DELETE FROM calendario_pruebas_cuidos WHERE evento_id IN (SELECT id FROM calendario_pruebas_eventos WHERE calendario_id=$1)',[req.params.id]);
    await client.query('DELETE FROM calendario_pruebas_cuidos_adecuacion WHERE calendario_id=$1',[req.params.id]);
    if(cuidos.length)await client.query(`INSERT INTO calendario_pruebas_cuidos(evento_id,profesor_id,creado_por) SELECT x.evento_id,x.profesor_id,$1 FROM jsonb_to_recordset($2::jsonb) AS x(evento_id int,profesor_id int)`,[req.session.usuario.id,JSON.stringify(cuidos)]);
    if(adecuaciones.length)await client.query(`INSERT INTO calendario_pruebas_cuidos_adecuacion(calendario_id,fecha,hora_inicio,hora_fin,profesor_id,creado_por) SELECT $1,x.fecha::date,x.hora_inicio::time,x.hora_fin::time,x.profesor_id,$2 FROM jsonb_to_recordset($3::jsonb) AS x(fecha text,hora_inicio text,hora_fin text,profesor_id int)`,[req.params.id,req.session.usuario.id,JSON.stringify(adecuaciones)]);
    await client.query('COMMIT');
    res.json({ok:true,generados:cuidos.length,adecuaciones_generadas:adecuaciones.length,sin_horario:sinHorario});
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}));
router.put('/cuidos/:id',exigirCTA,async(req,res)=>{const actual=await pool.query(`SELECT e.* FROM calendario_pruebas_cuidos c JOIN calendario_pruebas_eventos e ON e.id=c.evento_id WHERE c.id=$1`,[req.params.id]);if(!actual.rows.length)return res.status(404).json({error:'Cuido no encontrado'});const e=actual.rows[0],candidatos=await candidatosCuido(pool,e,e.calendario_id);if(!candidatos.some(x=>String(x.id)===String(req.body.profesor_id)))return res.status(400).json({error:'Ese funcionario no es docente, no está en jornada durante toda la prueba o ya tiene otro cuido a esa hora.'});const r=await pool.query('UPDATE calendario_pruebas_cuidos SET profesor_id=$1,creado_por=$2 WHERE id=$3 RETURNING *',[req.body.profesor_id,req.session.usuario.id,req.params.id]);res.json(r.rows[0]);});
router.post('/eventos/:id/cuido',exigirCTA,async(req,res)=>{const er=await pool.query('SELECT * FROM calendario_pruebas_eventos WHERE id=$1',[req.params.id]);if(!er.rows.length)return res.status(404).json({error:'Prueba no encontrada'});const e=er.rows[0],candidatos=await candidatosCuido(pool,e,e.calendario_id);if(!candidatos.some(x=>String(x.id)===String(req.body.profesor_id)))return res.status(400).json({error:'Ese funcionario no es docente, no está en jornada durante toda la prueba o ya tiene otro cuido a esa hora.'});await pool.query('DELETE FROM calendario_pruebas_cuidos WHERE evento_id=$1',[req.params.id]);const r=await pool.query('INSERT INTO calendario_pruebas_cuidos(evento_id,profesor_id,creado_por) VALUES($1,$2,$3) RETURNING *',[req.params.id,req.body.profesor_id,req.session.usuario.id]);res.json(r.rows[0]);});
router.post('/adecuaciones/:id/cuido',exigirCTA,async(req,res)=>{const ar=await pool.query('SELECT * FROM calendario_pruebas_cuidos_adecuacion WHERE id=$1',[req.params.id]);if(!ar.rows.length)return res.status(404).json({error:'Cuido de Adecuación no encontrado'});const a=ar.rows[0],especial={...a,id:0},candidatos=await candidatosCuido(pool,especial,a.calendario_id,a.id);if(!candidatos.some(x=>String(x.id)===String(req.body.profesor_id)))return res.status(400).json({error:'Ese profesor no está en jornada durante los 120 minutos o ya tiene otro cuido a esa hora.'});const r=await pool.query('UPDATE calendario_pruebas_cuidos_adecuacion SET profesor_id=$1,creado_por=$2 WHERE id=$3 RETURNING *',[req.body.profesor_id,req.session.usuario.id,req.params.id]);res.json(r.rows[0]);});
router.get('/mis-cuidos',async(req,res)=>{const r=await pool.query(`SELECT * FROM (SELECT e.fecha::text,e.hora_inicio::text,e.hora_fin::text,e.materia,s.nombre AS seccion_nombre,c.titulo,false AS es_adecuacion FROM calendario_pruebas_cuidos cu JOIN calendario_pruebas_eventos e ON e.id=cu.evento_id JOIN calendarios_pruebas c ON c.id=e.calendario_id JOIN secciones s ON s.id=e.seccion_id WHERE cu.profesor_id=$1 AND c.estado='publicado' AND c.fecha_fin>=CURRENT_DATE UNION ALL SELECT a.fecha::text,a.hora_inicio::text,a.hora_fin::text,'Cuido de Adecuación' AS materia,'Todas las adecuaciones' AS seccion_nombre,c.titulo,true AS es_adecuacion FROM calendario_pruebas_cuidos_adecuacion a JOIN calendarios_pruebas c ON c.id=a.calendario_id WHERE a.profesor_id=$1 AND c.estado='publicado' AND c.fecha_fin>=CURRENT_DATE) x ORDER BY fecha,hora_inicio`,[req.session.usuario.id]);res.json(r.rows);});

module.exports=router;
