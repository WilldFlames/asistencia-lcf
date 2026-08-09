# Parche de seguridad - Liceo de Calle Fallas

## Antes de subir el codigo

1. Ingrese al sistema con el administrador actual.
2. En **Admin > Usuarios**, cree una cuenta nominal con su propia cedula y rol `admin`.
3. Cierre sesion, ingrese con la cuenta nueva y cambie la contrasena inicial.
4. Verifique que la cuenta nueva pueda administrar usuarios, estudiantes y asignaciones.
5. No desactive todavia la cuenta `0000000000`; hagalo despues de verificar el despliegue.

## Variable obligatoria en Railway

Antes de desplegar, agregue en Railway una variable llamada `SESSION_SECRET` con un valor aleatorio de al menos 32 caracteres. No use una contrasena personal ni copie el ejemplo del archivo `.env.example`.

Puede generar el valor localmente en PowerShell:

```powershell
[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(48))
```

Copie el resultado directamente en **Railway > Variables > SESSION_SECRET**. No lo guarde en GitHub ni lo comparta por chat.

Compruebe tambien:

```text
NODE_ENV=production
APP_ORIGIN=https://www.liccallefallas.com,https://liccallefallas.com
```

`DATABASE_URL` debe conservar su valor actual. No cree otra base de datos.

## Despliegue

1. Reemplace en GitHub los archivos del proyecto por el contenido de este paquete.
2. Confirme el cambio en la rama que Railway despliega.
3. Espere a que Railway muestre el despliegue como exitoso.
4. El cambio de `SESSION_SECRET` cerrara las sesiones existentes una sola vez; esto es esperado.

## Pruebas posteriores

1. Abra una ventana privada e ingrese con la cuenta administrativa nominal.
2. Pruebe Dashboard, Usuarios, Estudiantes y Asignaciones.
3. Ingrese con un profesor y compruebe asistencia y calificaciones.
4. Pruebe el portal de padres con una cuenta autorizada.
5. Compruebe un Debido Proceso con su guia u orientador asignado.
6. Confirme que un profesor no relacionado no pueda abrir ese expediente.
7. Revise los logs de Railway; no deben mostrar credenciales administrativas.

Cuando todo funcione, desactive `0000000000` desde **Admin > Usuarios**. El parche no elimina ni modifica automaticamente usuarios existentes.

## Reversion

Si aparece un problema funcional, en Railway seleccione el despliegue anterior y use **Redeploy**. Mantenga `SESSION_SECRET`: conservarlo no afecta la version anterior y evita otro cierre innecesario de sesiones.

## Cambios incluidos

- Eliminacion de la creacion automatica y los logs del administrador conocido.
- `SESSION_SECRET` obligatorio y fuerte en produccion.
- Cookies `SameSite=Lax`, identificador propio y configuracion local compatible.
- Regeneracion del identificador de sesion al ingresar o cambiar contrasena.
- Limite de diez intentos de ingreso por IP y cedula cada quince minutos.
- Proteccion de solicitudes de escritura contra CSRF y origenes externos.
- Cabeceras HTTP de seguridad y ocultamiento de errores internos en produccion.
- Rechazo de marcado activo peligroso en datos enviados a la API.
- Autorizacion uniforme para consultar o modificar Debidos Procesos.
- Pruebas unitarias de los controles centrales.
- Actualizacion de Nodemailer a una version sin vulnerabilidades conocidas por `npm audit`.
