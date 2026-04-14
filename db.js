require("dotenv").config();
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

const MATERIAS_DEFAULT = [
  "Español","Estudios Sociales","Matemática","Ciencias","Cívica",
  "Inglés","Francés","Artes Industriales","Artes Plásticas","Informática Educativa",
  "Ética y Valores","Guía","Orientación","Educación Física","Educación para el Hogar",
  "Biología","Física Matemática","Química","Filosofía","Psicología",
  "Educación para la Paz","Fortalecimiento Matemático"
];

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id               SERIAL PRIMARY KEY,
        cedula           TEXT UNIQUE NOT NULL,
        nombre           TEXT NOT NULL,
        primer_apellido  TEXT NOT NULL,
        segundo_apellido TEXT NOT NULL,
        email            TEXT,
        password_hash    TEXT NOT NULL,
        rol              TEXT NOT NULL CHECK(rol IN ('admin','auxiliar','orientador','profesor_guia','profesor')),
        primer_login     BOOLEAN DEFAULT true,
        activo           BOOLEAN DEFAULT true,
        created_at       TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS secciones (
        id     SERIAL PRIMARY KEY,
        nombre TEXT UNIQUE NOT NULL,
        nivel  INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS materias (
        id     SERIAL PRIMARY KEY,
        nombre TEXT UNIQUE NOT NULL
      );

      CREATE TABLE IF NOT EXISTS asignaciones (
        id               SERIAL PRIMARY KEY,
        profesor_id      INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
        seccion_id       INTEGER REFERENCES secciones(id) ON DELETE CASCADE,
        materia_id       INTEGER REFERENCES materias(id) ON DELETE CASCADE,
        lecciones_semana INTEGER DEFAULT 4,
        UNIQUE(profesor_id, seccion_id, materia_id)
      );

      CREATE TABLE IF NOT EXISTS seccion_guia (
        seccion_id  INTEGER PRIMARY KEY REFERENCES secciones(id) ON DELETE CASCADE,
        profesor_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS seccion_orientador (
        id            SERIAL PRIMARY KEY,
        seccion_id    INTEGER REFERENCES secciones(id) ON DELETE CASCADE,
        orientador_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
        UNIQUE(seccion_id, orientador_id)
      );

      CREATE TABLE IF NOT EXISTS estudiantes (
        id               SERIAL PRIMARY KEY,
        cedula           TEXT UNIQUE NOT NULL,
        nombre           TEXT NOT NULL,
        primer_apellido  TEXT NOT NULL,
        segundo_apellido TEXT NOT NULL,
        fecha_nacimiento DATE,
        seccion_id       INTEGER REFERENCES secciones(id) ON DELETE SET NULL,
        activo           BOOLEAN DEFAULT true,
        created_at       TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS encargados (
        id               SERIAL PRIMARY KEY,
        estudiante_id    INTEGER REFERENCES estudiantes(id) ON DELETE CASCADE,
        nombre           TEXT NOT NULL,
        primer_apellido  TEXT NOT NULL,
        segundo_apellido TEXT DEFAULT '',
        parentesco       TEXT DEFAULT '',
        telefono         TEXT DEFAULT '',
        celular          TEXT DEFAULT '',
        email            TEXT DEFAULT '',
        direccion        TEXT DEFAULT '',
        es_principal     BOOLEAN DEFAULT true,
        created_at       TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS sesiones_asistencia (
        id            SERIAL PRIMARY KEY,
        asignacion_id INTEGER REFERENCES asignaciones(id) ON DELETE CASCADE,
        fecha         DATE NOT NULL,
        lecciones     INTEGER NOT NULL DEFAULT 1,
        created_at    TIMESTAMP DEFAULT NOW(),
        UNIQUE(asignacion_id, fecha)
      );

      CREATE TABLE IF NOT EXISTS asistencia (
        id            SERIAL PRIMARY KEY,
        sesion_id     INTEGER REFERENCES sesiones_asistencia(id) ON DELETE CASCADE,
        estudiante_id INTEGER REFERENCES estudiantes(id) ON DELETE CASCADE,
        estado        TEXT NOT NULL CHECK(estado IN ('P','A','T')),
        justificada   BOOLEAN DEFAULT false,
        motivo        TEXT DEFAULT '',
        UNIQUE(sesion_id, estudiante_id)
      );

      CREATE TABLE IF NOT EXISTS informes (
        id              SERIAL PRIMARY KEY,
        remitente_id    INTEGER REFERENCES usuarios(id),
        destinatario_id INTEGER REFERENCES usuarios(id),
        estudiante_id   INTEGER REFERENCES estudiantes(id),
        conducta        TEXT DEFAULT '',
        participacion   TEXT DEFAULT '',
        trabajos        TEXT DEFAULT '',
        nota_estimada   TEXT DEFAULT '',
        recomendaciones TEXT DEFAULT '',
        observaciones   TEXT DEFAULT '',
        respuesta       TEXT DEFAULT '',
        respondido      BOOLEAN DEFAULT false,
        fecha_respuesta TIMESTAMP,
        leido           BOOLEAN DEFAULT false,
        created_at      TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS notificaciones (
        id         SERIAL PRIMARY KEY,
        usuario_id INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
        tipo       TEXT NOT NULL,
        mensaje    TEXT NOT NULL,
        leida      BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Admin por defecto
    const adminEx = await client.query("SELECT id FROM usuarios WHERE rol='admin' LIMIT 1");
    if (adminEx.rows.length === 0) {
      const hash = await bcrypt.hash("Admin2024**", 10);
      await client.query(`
        INSERT INTO usuarios (cedula,nombre,primer_apellido,segundo_apellido,password_hash,rol,primer_login)
        VALUES ('0000000000','Administrador','Sistema','LCF',$1,'admin',false)
        ON CONFLICT DO NOTHING
      `, [hash]);
      console.log("✅ Admin creado — cédula: 0000000000 / contraseña: Admin2024**");
    }

    // Secciones
    const secciones = [
      ...[1,2,3,4,5,6,7,8].map(i=>({nombre:`7-${i}`,nivel:7})),
      ...[1,2,3,4,5,6,7].map(i=>({nombre:`8-${i}`,nivel:8})),
      ...[1,2,3,4,5,6,7].map(i=>({nombre:`9-${i}`,nivel:9})),
      ...[1,2,3,4,5].map(i=>({nombre:`10-${i}`,nivel:10})),
      ...[1,2,3,4,5].map(i=>({nombre:`11-${i}`,nivel:11})),
    ];
    for (const s of secciones) {
      await client.query("INSERT INTO secciones (nombre,nivel) VALUES ($1,$2) ON CONFLICT DO NOTHING", [s.nombre,s.nivel]);
    }

    // Materias
    for (const m of MATERIAS_DEFAULT) {
      await client.query("INSERT INTO materias (nombre) VALUES ($1) ON CONFLICT DO NOTHING", [m]);
    }

    console.log("✅ Base de datos lista");
  } finally {
    client.release();
  }
}

module.exports = { pool, initDB };
