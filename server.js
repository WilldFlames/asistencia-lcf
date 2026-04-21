require("dotenv").config();
const express   = require("express");
const session   = require("express-session");
const pgSession = require("connect-pg-simple")(session);
const path      = require("path");
const { pool, initDB } = require("./db");
const { requireAuth } = require("./middleware/auth");

const app  = express();
const PORT = process.env.PORT || 3002;

app.set('trust proxy', 1);
app.use(express.json());
app.use(session({
  store: new pgSession({ pool, createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || "lcf-asistencia-secret-2024",
  resave: true,
  saveUninitialized: false,
  proxy: true,
  cookie: {
    maxAge: 10 * 60 * 60 * 1000,
    secure: true,
    sameSite: 'none',
    httpOnly: true
  }
}));

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

app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🏫 Sistema de Asistencia — Liceo de Calle Fallas`);
    console.log(`   http://localhost:${PORT}`);
    console.log(`   Admin: cédula 0000000000 / contraseña: Admin2024**\n`);
  });
}).catch(err => { console.error("Error DB:", err); process.exit(1); });
