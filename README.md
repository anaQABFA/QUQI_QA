# QA Certifica — versión web (Render + Neon + Gemini)

Tablero de certificación de entregas de QA del Banco Finandina, ahora como aplicación web propia:

- **Servidor** Node.js (Express) en **Render** → URL pública `https://…onrender.com`, protegida con usuario y contraseña.
- **Base de datos** Postgres en **Neon** → los datos persisten aunque Render se reinicie o se duerma.
- **IA** con la **API de Google Gemini** → la llave vive solo en el servidor (variable secreta); si no se configura, la IA queda apagada y todo lo demás funciona.
- **Archivos** (Excel/PDF/PowerPoint de requerimientos y bugs) → se leen dentro del navegador; **no se guardan** en ningún lado.

---

## 1. Crear la base de datos en Neon (5 min)

1. Entra a <https://neon.tech> y crea una cuenta (plan gratuito).
2. **Create project** → nombre `qa-certifica`, región la más cercana (p. ej. `AWS US East`), versión de Postgres por defecto.
3. En el panel del proyecto pulsa **Connect** y copia la **connection string**. Se ve así:
   `postgresql://usuario:clave@ep-xxxx.us-east-2.aws.neon.tech/neondb?sslmode=require`
   Guárdala: es la variable `DATABASE_URL`. No necesitas crear tablas; la app las crea sola al arrancar.

## 2. Subir el código a GitHub (privado)

1. En <https://github.com> crea un repositorio **privado** llamado `qa-certifica`.
2. Desde esta carpeta (necesitas Git instalado):

```bash
git init
git add .
git commit -m "QA Certifica web"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/qa-certifica.git
git push -u origin main
```

> El `.gitignore` ya excluye `node_modules`, `.env` y cualquier archivo de datos/respaldo. **Nunca subas el JSON con tus datos reales al repositorio.**

## 3. Llave de Gemini (opcional pero recomendada)

1. Entra a <https://aistudio.google.com/apikey> con una cuenta de Google y crea una **API key**.
2. Guárdala: es `GEMINI_API_KEY`. El modelo por defecto es `gemini-2.5-flash` (variable `GEMINI_MODEL`; si Google lo renombra o lo retira, cámbialo en Render sin tocar código).

**Importante sobre privacidad:** los documentos de requerimientos salen del servidor hacia Google cuando alguien usa «Analizar con IA» o «Afinar con IA». Según los términos de la API de Gemini que conozco, en el nivel gratuito Google puede usar lo enviado para mejorar sus productos y en el nivel de pago no; **verifícalo en los términos vigentes y consúltalo con Seguridad de la Información / TI antes de activarla** con documentos internos del banco. Los Excel con el formato de tabla «HU / Criterio de aceptación» se leen **sin IA** y nunca salen del navegador.

## 4. Desplegar en Render

**Opción A – Blueprint (recomendada, usa el `render.yaml`)**

1. En <https://render.com> crea una cuenta y conéctala a tu GitHub.
2. **New + → Blueprint** → elige el repositorio `qa-certifica` → **Apply**.
3. Render te pedirá las variables que no están en el archivo:
   - `DATABASE_URL` → la cadena de Neon (paso 1).
   - `ADMIN_PASSWORD` → la clave inicial de Ana (mínimo 10 caracteres, letras y números).
   - `GEMINI_API_KEY` → la llave del paso 3 (o déjala vacía para IA apagada).
4. Espera el primer despliegue (unos minutos). La URL queda arriba en el panel del servicio.

**Opción B – manual:** New + → Web Service → repositorio → Runtime *Node* → Build `npm ci --omit=dev` → Start `node server.js` → plan *Free* → agrega las variables de la tabla de abajo.

| Variable | Valor |
|---|---|
| `DATABASE_URL` | cadena de conexión de Neon |
| `SESSION_SECRET` | texto aleatorio de 32+ caracteres (el Blueprint lo genera solo) |
| `ADMIN_USER` | `ana` (usuario del primer administrador) |
| `ADMIN_NAME` | `Ana Cortés` (nombre que se verá en «Registrado por») |
| `ADMIN_PASSWORD` | clave inicial del administrador |
| `GEMINI_API_KEY` | llave de Gemini (opcional) |
| `GEMINI_MODEL` | `gemini-2.5-flash` |
| `NODE_ENV` | `production` |
| `NODE_VERSION` | `20` |

## 5. Primer ingreso y migración de datos

1. Abre la URL de Render, entra con `ana` y la `ADMIN_PASSWORD`.
2. Pulsa **Administración** (arriba a la derecha) → **Restaurar desde un archivo** → elige `qa-certifica-datos-actuales.json` (el archivo con lo que ya tenías en Claude) → modo **Combinar** → **Restaurar**. Recarga el tablero: aparecen tus proyectos, seguimiento, bitácora y ambientes.
3. En **Usuarios** crea una cuenta por analista (usuario, nombre, contraseña temporal). Cada persona debe cambiar su clave en el primer ingreso. Comparte usuario y clave temporal por un canal seguro (no por el mismo chat/correo público).
4. Desde ahí, el campo «Registrado por» se llena solo con el nombre de cada usuario.

## 6. Respaldos (para que nunca se pierdan los datos)

- **Mensual a mano (2 clics):** Administración → «Descargar respaldo (JSON)» y/o «(Excel)». Guarda el archivo en una carpeta corporativa. El tablero le muestra a la administradora un aviso cuando pasan 30 días sin respaldo. El **JSON** sirve para restaurar; el **Excel** es solo para consultar.
- **Automático mensual (opcional):** el archivo `.github/workflows/respaldo-mensual.yml` genera un respaldo el día 1 de cada mes y lo deja descargable 90 días en la pestaña **Actions** del repositorio. Para activarlo: repositorio **privado** → Settings → Secrets and variables → Actions → *New repository secret* → nombre `DATABASE_URL`, valor la cadena de Neon. (Ese respaldo incluye también los usuarios con sus claves cifradas: trátalo como confidencial.)
- **Recuperación total:** crea una base nueva en Neon, apunta `DATABASE_URL` a ella y ejecuta `node scripts/import.js respaldo.json --con-usuarios` (o usa Administración → Restaurar con el JSON del botón).
- Neon además conserva un historial corto de cambios para volver atrás en el tiempo; revisa en su panel el periodo vigente de tu plan.

## 7. Cosas que debes saber

- **Arranque en frío:** en el plan gratuito de Render el servicio se duerme tras un rato sin visitas; la primera carga después puede tardar cerca de un minuto. Neon también «duerme» la base y despierta sola en segundos. Después, todo va normal. Para evitar la espera puedes usar un monitor externo gratuito (p. ej. UptimeRobot) que visite `https://TU-URL/healthz` cada 5–10 min, o pasar a un plan de pago.
- **Límites gratuitos:** las cuotas de Render, Neon y Gemini cambian con el tiempo; revisa sus páginas de precios vigentes. Para este volumen (unas pocas personas, miles de registros) el uso esperado es muy bajo.
- **Seguridad incluida:** HTTPS (de Render), contraseñas cifradas con scrypt, sesión por cookie `HttpOnly` + `Secure` de 12 h, bloqueo temporal tras intentos fallidos, protección CSRF por origen, cabeceras de seguridad (CSP, HSTS, etc.), roles (administrador / analista), usuarios desactivables al instante. La llave de Gemini nunca llega al navegador.
- **Aprobación interna:** al ser una herramienta con datos del banco en servicios de terceros (Render, Neon, Google), conviene el visto bueno de Seguridad/TI antes de abrirla a todo el equipo.
- **Qué no hace (igual que dentro de Claude):** no envía correos ni crea issues en Azure DevOps por sí sola; redacta los mensajes y tú los copias. La conexión en vivo con Azure y el envío automático de recordatorios requerirían una integración adicional (credenciales guardadas en el servidor).
- **Cambiar el nombre/URL:** en Render → Settings → *Custom Domain* puedes usar un dominio propio.

## 8. Problemas frecuentes

| Síntoma | Causa y solución |
|---|---|
| El despliegue falla con «Falta DATABASE_URL / SESSION_SECRET / ADMIN_PASSWORD» | Falta esa variable en Render (Environment). Agrégala y redespliega. |
| «ADMIN_PASSWORD no es válida» | Mínimo 10 caracteres, con letras y al menos un número. |
| Olvidé la clave de Ana | Cambiar `ADMIN_PASSWORD` en Render **no** sirve (solo se usa cuando la base no tiene usuarios). Pide a otro administrador que la restablezca en Administración, o ejecuta en una terminal: `DATABASE_URL=… node -e "const a=require('./lib/auth'),d=require('./lib/db');d.q('UPDATE users SET pass_hash=\$1,pv=pv+1,must_change=true WHERE username=\$2',[a.hashPassword('NuevaClave2026x'),'ana']).then(()=>process.exit())"` |
| La IA dice «no está activada» | Falta `GEMINI_API_KEY` en Render. |
| La IA dice «llave no válida» | La llave es incorrecta, está restringida o fue revocada: genera otra en AI Studio y actualízala en Render. |
| La IA dice «Demasiadas solicitudes» | Se alcanzó la cuota por minuto/día de Gemini; espera o cambia a un plan de pago. |
| «Sesión vencida» | La sesión dura 12 h; vuelve a ingresar. |

## 9. Desarrollo local

```bash
npm install
cp .env.example .env   # y edítalo (necesitas un Postgres, p. ej. una base gratuita de Neon)
export $(grep -v '^#' .env | xargs) && npm start   # http://localhost:3000
```

Estructura: `server.js` (API, login, SSE) · `lib/` (base de datos, autenticación, IA, almacenamiento) · `public/app.html` (el tablero) · `public/shim.js` (conecta el tablero con el servidor) · `public/admin.html` · `public/login.html` · `public/vendor/` (librerías de Excel/PDF servidas desde el propio servidor, sin depender de CDN) · `scripts/` (respaldo e importación).
