const router=require('express').Router();
const {pool}=require('../db');

function esCTA(u){ return u?.rol==='admin'||(u?.funciones_extra||[]).includes('comite_tecnico_asesor'); }
function exigirCTA(req,res,next){ if(!esCTA(req.session.usuario)) return res.status(403).json({error:'Solo el Comité Técnico Asesor puede modificar calendarios.'}); next(); }
const fechaCR=()=>new Date(new Date().toLocaleString('en-US',{timeZone:'America/Costa_Rica'})).toISOString().slice(0,10);
const diaSemana=f=>new Date(`${f}T12:00:00Z`).getUTCDay();
const lecciones=[['07:00','07:40'],['07:40','08:20'],['08:35','09:15'],['09:15','09:55'],['10:10','10:50'],['10:50','11:30'],['11:40','12:20'],['12:20','13:00'],['13:25','14:05'],['14:05','14:45'],['14:55','15:35'],['15:35','16:15']];
const leccionDeHora=h=>{const x=String(h||'').slice(0,5);const i=lecciones.findIndex(([a,b])=>x>=a&&x<b);return i<0?null:i+1;};

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
  const e=await pool.query(`SELECT e.*,s.nombre AS seccion_nombre,
    COALESCE(json_agg(json_build_object('id',cu.id,'profesor_id',cu.profesor_id,'nombre',concat_ws(' ',u.nombre,u.primer_apellido,u.segundo_apellido))) FILTER(WHERE cu.id IS NOT NULL),'[]') AS cuidos
    FROM calendario_pruebas_eventos e JOIN secciones s ON s.id=e.seccion_id LEFT JOIN calendario_pruebas_cuidos cu ON cu.evento_id=e.id LEFT JOIN usuarios u ON u.id=cu.profesor_id
    WHERE e.calendario_id=$1 GROUP BY e.id,s.nombre ORDER BY e.fecha,e.hora_inicio,s.nombre`,[req.params.id]);res.json({calendario:c.rows[0],eventos:e.rows});
});
router.post('/calendarios/:id/eventos',exigirCTA,async(req,res)=>{
  const {fecha,hora_inicio,hora_fin,materia,seccion_id,nivel,observacion}=req.body;
  if(!fecha||!hora_inicio||!hora_fin||!materia?.trim()||(!seccion_id&&!nivel))return res.status(400).json({error:'Completá fecha, horas, materia y el nivel o sección.'});
  let secciones=[];
  if(nivel){
    const anio=Number(String(fecha).slice(0,4));
    const s=await pool.query(`SELECT s.id FROM secciones s JOIN secciones_anio sa ON sa.seccion_id=s.id AND sa.anio=$1 AND sa.activa=true WHERE s.nivel=$2 ORDER BY s.nombre`,[anio,nivel]);
    secciones=s.rows.map(x=>x.id);
    if(!secciones.length)return res.status(400).json({error:'No hay secciones activas para ese nivel en el año seleccionado.'});
  }else secciones=[Number(seccion_id)];
  const client=await pool.connect();
  try{
    await client.query('BEGIN');const creadas=[];
    for(const sid of secciones){const r=await client.query(`INSERT INTO calendario_pruebas_eventos(calendario_id,fecha,hora_inicio,hora_fin,materia,seccion_id,observacion) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[req.params.id,fecha,hora_inicio,hora_fin,materia.trim(),sid,observacion||'']);creadas.push(r.rows[0]);}
    await client.query('COMMIT');res.json({ok:true,creadas,total:creadas.length});
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
});
router.put('/eventos/:id',exigirCTA,async(req,res)=>{
  const {fecha,hora_inicio,hora_fin,materia,seccion_id,observacion}=req.body;
  const r=await pool.query(`UPDATE calendario_pruebas_eventos SET fecha=$1,hora_inicio=$2,hora_fin=$3,materia=$4,seccion_id=$5,observacion=$6 WHERE id=$7 RETURNING *`,[fecha,hora_inicio,hora_fin,materia,seccion_id,observacion||'',req.params.id]);if(!r.rows.length)return res.status(404).json({error:'Prueba no encontrada'});res.json(r.rows[0]);
});
router.delete('/eventos/:id',exigirCTA,async(req,res)=>{await pool.query('DELETE FROM calendario_pruebas_eventos WHERE id=$1',[req.params.id]);res.json({ok:true});});
router.post('/calendarios/:id/generar-cuidos',exigirCTA,async(req,res)=>{
  const eventos=await pool.query('SELECT * FROM calendario_pruebas_eventos WHERE calendario_id=$1',[req.params.id]);let generados=0,sinHorario=[];
  const client=await pool.connect();try{await client.query('BEGIN');
    for(const e of eventos.rows){const lec=leccionDeHora(e.hora_inicio),dia=diaSemana(String(e.fecha).slice(0,10)),anio=Number(String(e.fecha).slice(0,4));if(!lec||dia<1||dia>5){sinHorario.push(e.id);continue;}
      const p=await client.query(`SELECT DISTINCT a.profesor_id FROM horarios h JOIN asignaciones a ON a.id=h.asignacion_id WHERE h.seccion_id=$1 AND h.dia=$2 AND h.leccion=$3 AND h.anio=$4 AND a.activa IS NOT FALSE ORDER BY a.profesor_id LIMIT 1`,[e.seccion_id,dia,lec,anio]);
      if(!p.rows.length){sinHorario.push(e.id);continue;}await client.query('DELETE FROM calendario_pruebas_cuidos WHERE evento_id=$1',[e.id]);await client.query('INSERT INTO calendario_pruebas_cuidos(evento_id,profesor_id,creado_por) VALUES($1,$2,$3)',[e.id,p.rows[0].profesor_id,req.session.usuario.id]);generados++;}
    await client.query('COMMIT');res.json({ok:true,generados,sin_horario:sinHorario});
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
});
router.put('/cuidos/:id',exigirCTA,async(req,res)=>{const r=await pool.query('UPDATE calendario_pruebas_cuidos SET profesor_id=$1,creado_por=$2 WHERE id=$3 RETURNING *',[req.body.profesor_id,req.session.usuario.id,req.params.id]);res.json(r.rows[0]);});
router.post('/eventos/:id/cuido',exigirCTA,async(req,res)=>{await pool.query('DELETE FROM calendario_pruebas_cuidos WHERE evento_id=$1',[req.params.id]);const r=await pool.query('INSERT INTO calendario_pruebas_cuidos(evento_id,profesor_id,creado_por) VALUES($1,$2,$3) RETURNING *',[req.params.id,req.body.profesor_id,req.session.usuario.id]);res.json(r.rows[0]);});
router.get('/mis-cuidos',async(req,res)=>{const r=await pool.query(`SELECT e.fecha::text,e.hora_inicio::text,e.hora_fin::text,e.materia,s.nombre AS seccion_nombre,c.titulo FROM calendario_pruebas_cuidos cu JOIN calendario_pruebas_eventos e ON e.id=cu.evento_id JOIN calendarios_pruebas c ON c.id=e.calendario_id JOIN secciones s ON s.id=e.seccion_id WHERE cu.profesor_id=$1 AND c.estado='publicado' AND c.fecha_fin>=CURRENT_DATE ORDER BY e.fecha,e.hora_inicio`,[req.session.usuario.id]);res.json(r.rows);});

module.exports=router;
