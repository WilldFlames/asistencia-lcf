const router = require("express").Router();
const { pool } = require("../db");
const { requireRol } = require("../middleware/auth");
const { notificarSecciones } = require("../utils/push-familias");
const { obtenerAnioActivo } = require("../utils/lectivo");

const permitido = requireRol("admin", "auxiliar");
router.use(permitido);

const fechaValida = f => /^\d{4}-\d{2}-\d{2}$/.test(String(f || ""));
const horaValida = h => !h || /^([01]\d|2[0-3]):[0-5]\d$/.test(String(h));

router.get("/secciones", async (_req, res) => {
  const anio=await obtenerAnioActivo();
  const r = await pool.query(`SELECT s.id,s.nombre,s.nivel FROM secciones s
    JOIN secciones_anio sa ON sa.seccion_id=s.id AND sa.anio=$1 AND sa.activa=true
    ORDER BY s.nivel,s.nombre`,[anio]);
  res.json(r.rows);
});

router.get("/docentes", async (_req, res) => {
  const r = await pool.query(`SELECT id,nombre,primer_apellido,segundo_apellido,rol
    FROM usuarios WHERE activo=true AND rol IN ('profesor','profesor_guia','orientador','administrativo','admin')
    ORDER BY nombre,primer_apellido,segundo_apellido`);
  res.json(r.rows);
});

router.get("/", async (req, res) => {
  const desde = String(req.query.desde || new Date().toISOString().slice(0,10));
  const hasta = String(req.query.hasta || desde);
  const r = await pool.query(`SELECT he.*,s.nombre AS seccion_nombre,
      u.nombre AS creador_nombre,u.primer_apellido AS creador_ap1,u.segundo_apellido AS creador_ap2
    FROM horarios_especiales he JOIN secciones s ON s.id=he.seccion_id
    LEFT JOIN usuarios u ON u.id=he.creado_por
    WHERE he.fecha BETWEEN $1 AND $2 ORDER BY he.fecha,s.nombre`,[desde,hasta]);
  res.json(r.rows);
});

router.post("/", async (req, res) => {
  const fecha=String(req.body.fecha||""),seccionId=Number(req.body.seccion_id);
  const entrada=String(req.body.hora_entrada||"").slice(0,5)||null;
  const salida=String(req.body.hora_salida||"").slice(0,5)||null;
  const motivo=String(req.body.motivo||"").trim();
  if(!fechaValida(fecha)||!Number.isInteger(seccionId)||seccionId<=0) return res.status(400).json({error:"Seleccione una fecha y una sección válidas."});
  if(!horaValida(entrada)||!horaValida(salida)||(!entrada&&!salida)) return res.status(400).json({error:"Indique al menos una hora especial válida de entrada o salida."});
  if(entrada&&salida&&entrada>=salida) return res.status(400).json({error:"La hora de salida debe ser posterior a la entrada."});
  if(!motivo) return res.status(400).json({error:"Indique el motivo del horario especial."});
  const r=await pool.query(`INSERT INTO horarios_especiales
      (fecha,seccion_id,hora_entrada,hora_salida,motivo,activo,creado_por,anulado_por,updated_at)
    VALUES($1,$2,$3,$4,$5,true,$6,NULL,NOW())
    ON CONFLICT(fecha,seccion_id) DO UPDATE SET hora_entrada=EXCLUDED.hora_entrada,
      hora_salida=EXCLUDED.hora_salida,motivo=EXCLUDED.motivo,activo=true,
      creado_por=EXCLUDED.creado_por,anulado_por=NULL,updated_at=NOW()
    RETURNING *`,[fecha,seccionId,entrada,salida,motivo,req.session.usuario.id]);
  await notificarSecciones([seccionId],{title:"Horario especial",body:`${fecha}: ${entrada?`entrada ${entrada}`:"entrada habitual"} · ${salida?`salida ${salida}`:"salida habitual"}. ${motivo}`,url:"/?app=familias&abrir=horario"});
  res.json(r.rows[0]);
});

router.put("/:id/anular", async (req,res)=>{
  const r=await pool.query(`UPDATE horarios_especiales SET activo=false,anulado_por=$1,updated_at=NOW()
    WHERE id=$2 RETURNING id`,[req.session.usuario.id,req.params.id]);
  if(!r.rows.length)return res.status(404).json({error:"Horario especial no encontrado."});
  res.json({ok:true});
});

router.get("/ausencias/lista", async (req,res)=>{
  const desde=String(req.query.desde||new Date().toISOString().slice(0,10));
  const hasta=String(req.query.hasta||desde);
  const r=await pool.query(`SELECT da.*,u.nombre,u.primer_apellido,u.segundo_apellido,
      c.nombre AS creador_nombre,c.primer_apellido AS creador_ap1,c.segundo_apellido AS creador_ap2
    FROM docente_ausencias da JOIN usuarios u ON u.id=da.profesor_id
    LEFT JOIN usuarios c ON c.id=da.creado_por
    WHERE da.fecha BETWEEN $1 AND $2 ORDER BY da.fecha,u.nombre,u.primer_apellido`,[desde,hasta]);
  res.json(r.rows);
});

router.post("/ausencias", async (req,res)=>{
  const fecha=String(req.body.fecha||""),profesorId=Number(req.body.profesor_id);
  const desde=Number(req.body.leccion_desde||1),hasta=Number(req.body.leccion_hasta||12);
  const motivo=String(req.body.motivo||"").trim();
  if(!fechaValida(fecha)||!Number.isInteger(profesorId)||profesorId<=0) return res.status(400).json({error:"Seleccione fecha y docente."});
  if(!Number.isInteger(desde)||!Number.isInteger(hasta)||desde<1||hasta>12||hasta<desde) return res.status(400).json({error:"El rango de lecciones es inválido."});
  const r=await pool.query(`INSERT INTO docente_ausencias(fecha,profesor_id,leccion_desde,leccion_hasta,motivo,creado_por)
    VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[fecha,profesorId,desde,hasta,motivo,req.session.usuario.id]);
  const dia=new Date(`${fecha}T12:00:00Z`).getUTCDay(),anio=Number(fecha.slice(0,4));
  const secs=await pool.query(`SELECT DISTINCT a.seccion_id FROM horarios h JOIN asignaciones a ON a.id=h.asignacion_id
    WHERE h.anio=$1 AND h.dia=$2 AND h.leccion BETWEEN $3 AND $4 AND a.profesor_id=$5 AND a.seccion_id IS NOT NULL`,[anio,dia,desde,hasta,profesorId]);
  if(secs.rows.length) await notificarSecciones(secs.rows.map(x=>x.seccion_id),{title:"Docente ausente",body:`El horario del ${fecha} muestra una ausencia docente.${motivo?` ${motivo}`:""}`,url:"/?app=familias&abrir=horario"});
  res.json(r.rows[0]);
});

router.put("/ausencias/:id/anular", async(req,res)=>{
  const r=await pool.query(`UPDATE docente_ausencias SET activo=false,anulado_por=$1,updated_at=NOW()
    WHERE id=$2 RETURNING id`,[req.session.usuario.id,req.params.id]);
  if(!r.rows.length)return res.status(404).json({error:"Ausencia no encontrada."});
  res.json({ok:true});
});

module.exports=router;
