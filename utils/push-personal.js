const webpush = require("web-push");
const { pool } = require("../db");

const clavePublica=String(process.env.VAPID_PUBLIC_KEY||"").trim();
const clavePrivada=String(process.env.VAPID_PRIVATE_KEY||"").trim();
const contacto=String(process.env.VAPID_SUBJECT||"https://www.liccallefallas.com").trim();
let errorConfiguracion="";
let procesando=false;

if(clavePublica&&clavePrivada){
  try{webpush.setVapidDetails(contacto,clavePublica,clavePrivada);}
  catch(error){errorConfiguracion=error.message;console.error("Web Push de Personal LCF no pudo configurarse:",error.message);}
}

function estaConfigurado(){return Boolean(clavePublica&&clavePrivada&&!errorConfiguracion);}
function estadoConfiguracion(){return {configurada:estaConfigurado(),publicKey:estaConfigurado()?clavePublica:""};}

function destinoNotificacion(n){
  const destino=String(n.destino||"");
  if(destino.startsWith("alerta-temprana:")){
    const ref=destino.split(":")[1]||"";
    return `/personal?app=personal&abrir=alerta-temprana&ref=${encodeURIComponent(ref)}`;
  }
  const porTipo={
    informe:"mensajes",informe_respondido:"mensajes",cita:"citas",
    boleta:"conducta",conducta:"conducta",adecuacion:"adecuaciones",
    protocolo:"protocolos",debido_proceso:"debidos"
  };
  const modulo=porTipo[String(n.tipo||"")]||"dashboard";
  return `/personal?app=personal&abrir=${encodeURIComponent(modulo)}`;
}

function payload(n){
  return JSON.stringify({
    app:"personal",
    title:"Personal LCF",
    body:String(n.mensaje||"Tiene una nueva notificación institucional.").slice(0,500),
    url:destinoNotificacion(n),
    tag:`personal-lcf-${n.id}`,
    urgency:["alerta_temprana","debido_proceso","protocolo"].includes(String(n.tipo||""))?"high":"normal",
    requireInteraction:false
  });
}

async function procesarNotificacionesPersonal(){
  if(procesando||!estaConfigurado()) return;
  procesando=true;
  try{
    const suscripciones=await pool.query(`
      SELECT ps.id,ps.usuario_id,ps.endpoint,ps.p256dh,ps.auth,ps.last_notification_id
      FROM push_suscripciones_personal ps
      JOIN usuarios u ON u.id=ps.usuario_id
      WHERE u.activo=true AND COALESCE(u.eliminado,false)=false
      ORDER BY ps.id
    `);
    for(const s of suscripciones.rows){
      const pendientes=await pool.query(`
        SELECT id,tipo,mensaje,destino,created_at
        FROM notificaciones
        WHERE usuario_id=$1 AND id>$2
        ORDER BY id ASC LIMIT 20
      `,[s.usuario_id,s.last_notification_id]);
      for(const n of pendientes.rows){
        try{
          await webpush.sendNotification({endpoint:s.endpoint,keys:{p256dh:s.p256dh,auth:s.auth}},payload(n),{
            TTL:24*60*60,urgency:"high"
          });
          await pool.query(`UPDATE push_suscripciones_personal
            SET last_notification_id=$1,last_success_at=NOW(),updated_at=NOW()
            WHERE id=$2`,[n.id,s.id]);
        }catch(error){
          if([404,410].includes(Number(error.statusCode))){
            await pool.query("DELETE FROM push_suscripciones_personal WHERE id=$1",[s.id]);
          }else{
            console.error("Web Push Personal LCF:",error.statusCode||"error",error.message);
          }
          break;
        }
      }
    }
  }catch(error){console.error("Despacho Personal LCF:",error.message);}
  finally{procesando=false;}
}

module.exports={estadoConfiguracion,estaConfigurado,procesarNotificacionesPersonal};
