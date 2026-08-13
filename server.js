// Version: 2026-05-12 15:23:12
require("dotenv").config();
const compression = require("compression");
const express   = require("express");
const session   = require("express-session");
const pgSession = require("connect-pg-simple")(session);
const path      = require("path");
const fs        = require("fs");
const { pool, initDB } = require("./db");
const { requireAuth } = require("./middleware/auth");
const {
  validateSecurityConfig,
  getSessionSecret,
  securityHeaders,
  csrfProtection,
  rejectActiveMarkup,
  hideProductionErrors,
} = require("./middleware/security");

validateSecurityConfig();

const app  = express();
app.use(compression()); // Gzip — reduces 411KB to ~100KB
const PORT = process.env.PORT || 3002;

app.set('trust proxy', 1);
app.disable("x-powered-by");
app.use(securityHeaders);
app.use(hideProductionErrors);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(session({
  store: new pgSession({ pool, createTableIfMissing: true }),
  secret: getSessionSecret(),
  resave: false,
  saveUninitialized: false,
  proxy: true,
  name: "lcf.sid",
  cookie: {
    maxAge: 10 * 60 * 60 * 1000,
    secure: process.env.NODE_ENV === "production",
    sameSite: 'lax',
    httpOnly: true
  }
}));
app.use(csrfProtection());
app.use(rejectActiveMarkup);

app.use("/api/auth",           require("./routes/auth"));
app.use("/api/admin",          requireAuth, require("./routes/admin"));
app.use("/api/estudiantes",    requireAuth, require("./routes/estudiantes"));
app.use("/api/encargados",     requireAuth, require("./routes/encargados"));
app.use("/api/asistencia",     requireAuth, require("./routes/asistencia"));
app.use("/api/reportes",       requireAuth, require("./routes/reportes"));
app.use("/api/mensajes",       requireAuth, require("./routes/mensajes"));
app.use("/api/notificaciones", requireAuth, require("./routes/notificaciones"));
app.use("/api/observaciones",  requireAuth, require("./routes/observaciones"));
app.use("/api/conducta",       requireAuth, require("./routes/conducta"));
app.use("/api/expediente",     requireAuth, require("./routes/expediente"));
app.use("/api/comedor",        requireAuth, require("./routes/comedor"));
app.use("/api/consecutivos",   requireAuth, require("./routes/consecutivos"));
app.use("/api/medidas",        requireAuth, require("./routes/medidas"));
app.use("/api/prematricula",   requireAuth, require("./routes/prematricula"));
app.use("/api/matricula",      requireAuth, require("./routes/matricula"));
app.use("/api/cartas",         requireAuth, require("./routes/cartas"));
app.use("/api/periodos",       requireAuth, require("./routes/periodos"));
app.use("/api/calificaciones", requireAuth, require("./routes/calificaciones"));
app.use("/api/debidos-procesos", requireAuth, require("./routes/debidosProcesos"));
app.use("/api/protocolos", requireAuth, require("./routes/protocolos"));
app.use("/api/minutas",    requireAuth, require("./routes/minutas"));
app.use("/api/horarios",   requireAuth, require("./routes/horarios"));
app.use("/api/porteria",   requireAuth, require("./routes/porteria"));
app.use("/api/anuncios",   requireAuth, require("./routes/anuncios"));
app.use("/api/config-anio",requireAuth, require("./routes/configAnio"));
app.use("/api/citas",      requireAuth, require("./routes/citas"));
app.use("/api/padres",     require("./routes/padres")); // auth propia (portal de encargados)
app.use("/api/inventario", requireAuth, require("./routes/inventario"));
app.use("/api/rendimiento",requireAuth, require("./routes/rendimiento"));
app.use("/api/adecuaciones",requireAuth, require("./routes/adecuaciones"));
app.use("/api/alerta-temprana",requireAuth, require("./routes/alertaTemprana"));

// Force no-cache for HTML to ensure users always get latest version
// Versión actual del sistema — se calcula al arrancar el proceso.
// Cada deploy de Railway arranca un proceso nuevo → APP_VERSION cambia automáticamente
// → el frontend detecta el cambio vía /api/version y se recarga solo (sin Ctrl+F5).
// Si Railway define RAILWAY_DEPLOYMENT_ID se usa, si no, timestamp del arranque.
const APP_VERSION = process.env.RAILWAY_DEPLOYMENT_ID || new Date().toISOString();
app.get("/api/version", (req, res) => {
  res.json({ version: APP_VERSION });
});

app.use((req, res, next) => {
  if(req.path === '/' || req.path.endsWith('.html')) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  if(['/sw.js', '/manifest.webmanifest', '/personal.webmanifest', '/pwa.js', '/pwa.css'].includes(req.path)) {
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  }
  next();
});

// Personal LCF reutiliza exactamente el mismo sistema, pero recibe desde el
// primer byte su propio manifiesto e identidad instalable. No se duplica el
// enorme index.html ni se crea una segunda aplicación de servidor.
let personalHtml="";
app.get(["/personal","/personal/"],(req,res,next)=>{
  try{
    if(!personalHtml){
      personalHtml=fs.readFileSync(path.join(__dirname,"public","index.html"),"utf8")
        .replace('<meta name="apple-mobile-web-app-title" content="LCF Familias"/>','<meta name="apple-mobile-web-app-title" content="Personal LCF"/>')
        .replace('<link rel="manifest" href="/manifest.webmanifest"/>','<link rel="manifest" href="/personal.webmanifest"/>')
        .replace('<link rel="apple-touch-icon" sizes="180x180" href="/icons/lcf-familias-180.png"/>','<link rel="apple-touch-icon" sizes="180x180" href="/icons/personal-lcf-180.png"/>')
        .replace('<link rel="icon" type="image/png" sizes="32x32" href="/icons/lcf-familias-32.png"/>','<link rel="icon" type="image/png" sizes="32x32" href="/icons/personal-lcf-32.png"/>')
        .replace('<title>Asistencia – Liceo de Calle Fallas</title>','<title>Personal LCF</title>');
    }
    res.type("html").send(personalHtml);
  }catch(error){next(error);}
});
app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// ── HANDLER GLOBAL DE ERRORES (red de seguridad) ─────────────────────────────
// Si algún route async lanza un error no atrapado, este handler lo captura,
// lo loguea con contexto y responde 500 limpio en vez de dejar la request colgada.
app.use((err, req, res, next) => {
  console.error(`[ERROR] ${req.method} ${req.path}:`, err.message);
  if (process.env.NODE_ENV !== 'production') console.error(err.stack);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Error interno del servidor. Si persiste, contactá al administrador.' });
});

initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🏫 Sistema de Asistencia — Liceo de Calle Fallas`);
    console.log(`   http://localhost:${PORT}`);
    console.log(`   Servidor iniciado correctamente.\n`);
  });

  // Tarea de mantenimiento: re-comprime fotos viejas grandes (una sola vez).
  // Se lanza en segundo plano para no demorar el arranque.
  // Si falla, no afecta al servidor.
  setTimeout(() => {
    try {
      const { recomprimirFotos } = require("./scripts/recomprimirFotos");
      recomprimirFotos().catch(err => console.error("[FOTOS] Error en recompresión:", err.message));
    } catch (e) {
      console.error("[FOTOS] No se pudo cargar el script:", e.message);
    }
  }, 5000); // espera 5s después del arranque

  // Entrega las notificaciones internas al teléfono del funcionario. El
  // cursor guardado por dispositivo evita reenviar avisos anteriores.
  const { procesarNotificacionesPersonal } = require("./utils/push-personal");
  setTimeout(()=>procesarNotificacionesPersonal().catch(()=>{}),7000);
  setInterval(()=>procesarNotificacionesPersonal().catch(()=>{}),12000);
}).catch(err => { console.error("Error DB:", err); process.exit(1); });
