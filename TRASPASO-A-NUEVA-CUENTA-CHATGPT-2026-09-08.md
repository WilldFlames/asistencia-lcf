# Traspaso del proyecto LCF a una nueva cuenta de ChatGPT

Este paquete contiene el código fuente completo y actualizado del Sistema de Administración Institucional del Liceo de Calle Fallas.

## Estado verificado

- Última versión preparada: v16.
- Fecha del respaldo: 8 de septiembre de 2026.
- Pruebas automáticas aprobadas: 186 de 186.
- El proyecto usa Node.js y PostgreSQL.
- Para instalar las dependencias se utiliza `npm install`.
- Para verificar el proyecto se utiliza `npm test`.
- El archivo `.env` real no se incluye por seguridad. Se debe crear a partir de `.env.example` y colocar las variables del servicio de producción.

## Últimas mejoras terminadas

- Hogar e Industriales funcionan por períodos sin cambiar el subgrupo permanente del estudiante:
  - I Período: A recibe Hogar y B recibe Industriales.
  - II Período: A recibe Industriales y B recibe Hogar.
  - Las asignaciones del segundo período se crean automáticamente.
  - Asistencia y calificaciones permanecen separadas por período.
  - La nota final corresponde al único período cursado; no se calcula promedio anual.
- El botón peligroso que corregía/intercambiaba subgrupos completos dejó de mostrarse.
- La pantalla Estudiantes permite imprimir:
  - lista general;
  - asistencia a examen;
  - entrega de tarea;
  - recepción de tarea;
  - entrega de temas de examen.
- Los formatos especiales incluyen sección, materia, docente responsable, fecha manual y firma de cada estudiante. Asistencia a examen agrega profesor aplicador.
- Se conservan además todas las mejoras anteriores descritas en los archivos `*-LEEME.txt` y en las pruebas de la carpeta `test`.

## Indicaciones para el nuevo chat

1. Descomprimir el ZIP en una carpeta de trabajo.
2. Indicarle a ChatGPT que lea este archivo y los archivos `*-LEEME.txt` antes de modificar el proyecto.
3. Instalar Node.js si fuera necesario.
4. Ejecutar `npm install` para reconstruir `node_modules`.
5. Ejecutar `npm test` antes y después de cada grupo de cambios.
6. No subir un archivo `.env` real al chat ni incluir claves o contraseñas dentro del código.
7. Para desplegar en Railway, configurar allí las variables de entorno y subir el código fuente; `node_modules` se genera automáticamente durante la construcción.

## Archivos principales

- `server.js`: inicio del servidor y registro de rutas.
- `db.js`: estructura y migraciones de PostgreSQL.
- `routes/`: lógica del servidor por módulo.
- `public/index.html`: interfaz principal.
- `test/`: pruebas automáticas y controles contra regresiones.
- `package.json` y `package-lock.json`: dependencias y comandos del proyecto.

Este respaldo fue creado específicamente para continuar el desarrollo desde otra cuenta sin perder el contexto técnico del proyecto.
