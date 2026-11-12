# QUQI_QA — versión web (Render + Neon + Gemini)

Tablero de certificación de entregas de QA del Banco Finandina, ahora como aplicación web propia:

- **Servidor** Node.js (Express) en **Render** → URL pública `https://…onrender.com`, protegida con usuario y contraseña.
- **Base de datos** Postgres en **Neon** → los datos persisten aunque Render se reinicie o se duerma.
- **IA** con la **API de Google Gemini** → la llave vive solo en el servidor (variable secreta); si no se configura, la IA queda apagada y todo lo demás funciona.
- **Archivos** (Excel/PDF/PowerPoint de requerimientos y bugs) → se leen dentro del navegador; **no se guardan** en ningún lado.

---

## 1. Crear la base de datos en Neon (5 min)

1. Entra a <https://neon.tech> y crea una cuenta (plan gratuito).
2. **Create project** → nombre `quqi-qa`, región la más cercana (p. ej. `AWS US East`), versión de Postgres por defecto.
3. En el panel del proyecto pulsa **Connect** y copia la **connection string**. Se ve así:
   `postgresql://usuario:clave@ep-xxxx.us-east-2.aws.neon.tech/neondb?sslmode=require`
   Guárdala: es la variable `DATABASE_URL`. No necesitas crear tablas; la app las crea sola al arrancar.

## 2. Subir el código a GitHub (privado)

1. En <https://github.com> crea un repositorio **privado** llamado `quqi-qa`.
2. Desde esta carpeta (necesitas Git instalado):

```bash
git init
git add .
git commit -m "QUQI_QA web"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/quqi-qa.git
git push -u origin main
```

> El `.gitignore` ya excluye `node_modules`, `.env` y cualquier archivo de datos/respaldo. **Nunca subas el JSON con tus datos reales al repositorio.**

## 3. Llave de Gemini (opcional pero recomendada)

1. Entra a <https://aistudio.google.com/apikey> con una cuenta de Google y crea una **API key**.
2. Guárdala: es `GEMINI_API_KEY`. El modelo por defecto es `gemini-3.8-flash` (variable `GEMINI_MODEL`; si Google lo renombra o lo retira, cámbialo en Render sin tocar código).

**Importante sobre privacidad:** los documentos de requerimientos salen del servidor hacia Google cuando alguien usa «Analizar con IA» o «Afinar con IA». Según los términos de la API de Gemini que conozco, en el nivel gratuito Google puede usar lo enviado para mejorar sus productos y en el nivel de pago no; **verifícalo en los términos vigentes y consúltalo con Seguridad de la Información / TI antes de activarla** con documentos internos del banco. Los Excel con el formato de tabla «HU / Criterio de aceptación» se leen **sin IA** y nunca salen del navegador.

## 4. Desplegar en Render

**Opción A – Blueprint (recomendada, usa el `render.yaml`)**

1. En <https://render.com> crea una cuenta y conéctala a tu GitHub.
2. **New + → Blueprint** → elige el repositorio `quqi-qa` → **Apply**.
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
| `GEMINI_MODEL` | `gemini-3.8-flash` |
| `NODE_ENV` | `production` |
| `NODE_VERSION` | `20` |

## 5. Primer ingreso y migración de datos

1. Abre la URL de Render, entra con `ana` y la `ADMIN_PASSWORD`.
2. Pulsa **Administración** (arriba a la derecha) → **Restaurar desde un archivo** → elige `quqi-qa-datos-actuales.json` (el archivo con lo que ya tenías en Claude) → modo **Combinar** → **Restaurar**. Recarga el tablero: aparecen tus proyectos, seguimiento, bitácora y ambientes.
3. En **Usuarios** crea una cuenta por analista (usuario, nombre, contraseña temporal). Cada persona debe cambiar su clave en el primer ingreso. Comparte usuario y clave temporal por un canal seguro (no por el mismo chat/correo público).
4. Desde ahí, el campo «Registrado por» se llena solo con el nombre de cada usuario.

## 6. Respaldos (para que nunca se pierdan los datos)

- **Mensual a mano (2 clics):** Administración → «Descargar respaldo (JSON)» y/o «(Excel)». Guarda el archivo en una carpeta corporativa. El tablero le muestra a la administradora un aviso cuando pasan 30 días sin respaldo. El **JSON** sirve para restaurar; el **Excel** es solo para consultar.
- **Automático mensual (opcional):** el archivo `.github/workflows/respaldo-mensual.yml` genera un respaldo el día 1 de cada mes y lo deja descargable 90 días en la pestaña **Actions** del repositorio. Para activarlo: repositorio **privado** → Settings → Secrets and variables → Actions → *New repository secret* → nombre `DATABASE_URL`, valor la cadena de Neon. (Ese respaldo incluye también los usuarios con sus claves cifradas: trátalo como confidencial.)
- **Recuperación total:** crea una base nueva en Neon, apunta `DATABASE_URL` a ella y ejecuta `node scripts/import.js respaldo.json --con-usuarios` (o usa Administración → Restaurar con el JSON del botón).
- Neon además conserva un historial corto de cambios para volver atrás en el tiempo; revisa en su panel el periodo vigente de tu plan.

## 6b. Conexión con Azure DevOps (bugs por proyecto, solo lectura)

1. En Azure DevOps: *User settings → Personal access tokens → New Token*. Organización: la tuya; vencimiento: el más corto que te sirva (p. ej. 90 días); permisos: **Custom defined → Work Items → Read** y, si vas a traer el avance de pruebas (6c), también **Test Management → Read** (nada más). Copia el token una sola vez.
2. En Render → *Environment* agrega: `AZURE_DEVOPS_ORG` (lo que va después de `dev.azure.com/`), `AZURE_DEVOPS_PAT` (el token) y, si casi todo está en un solo proyecto de Azure, `AZURE_DEVOPS_PROJECT`. Opcional: `AZURE_SYNC_MINUTES` (por defecto 30) y `AZURE_BUG_TYPES` (por defecto `Bug`). Guarda: Render redespliega solo.
3. En la pantalla de cada proyecto aparece el panel **Azure DevOps**: indica área/ruta, iteración (sprint), etiqueta y/o ID del padre (Epic, Feature o HU); pulsa **Probar consulta** y luego **Guardar vínculo**. Los bugs se actualizan solos cada 30 min mientras el proyecto esté abierto, al abrirlo si los datos tienen más de 2 min, o con **Sincronizar ahora**.
4. La llave nunca llega al navegador, la conexión solo lee, y los bugs traídos de Azure no se incluyen en el respaldo (se vuelven a generar). Si la llave vence o es inválida, el panel muestra el motivo y conserva los últimos datos.

## 6c. Avance de pruebas desde Azure Test Plans (% de QA certificado)

1. La llave (PAT) necesita además el permiso **Test Management → Read**. Si los planes de pruebas están en otro proyecto de Azure que los bugs, agrega en Render `AZURE_TEST_PROJECT` (por ejemplo `Gestion Proyectos`); también se puede escribir el proyecto en cada vínculo.
2. En el proyecto de QUQI_QA (ya recibido en QA), panel **% de QA certificado → Conectar con Azure Test Plans**: escribe el nombre o el ID del plan (por ejemplo `036. Eco-Nómina`), pulsa **Probar consulta** y compara los números con el *Progress report* de Azure (Test Plans → Progress report): deben coincidir. Luego **Guardar vínculo**.
3. Fórmula: casos aplicables = total − no aplicables (esa base es el 100 %); se muestran exitosos, fallidos, bloqueados, pausados y pendientes sobre esa base. El % certificado es exitosos / aplicables. Se actualiza solo junto con los bugs.

Nota: en el plan gratuito de Render el servicio duerme sin visitas, así que la actualización automática solo corre mientras está despierto; por eso también se sincroniza al abrir el proyecto.

## 6d. Perfiles (roles) y asignación de proyectos

Los usuarios se crean en **Administración** (solo tú, administrador). Hay siete perfiles:

| Perfil | Qué ve | Qué puede hacer |
|---|---|---|
| **Administrador** | Todo | Todo: crea y borra proyectos, asigna, administra usuarios y respaldos |
| **PMO** | Todo (incluida la bitácora) | Solo lectura |
| **PMO líder** | Solo los proyectos donde está asignado; **sin bitácora** | Solo lectura |
| **Analista QA** | Solo los proyectos que tiene asignados (backlog y en pruebas) y **su propia bitácora** | Edita todo (seguimiento, criterios, pruebas, bitácora, ambientes, comentarios). **No** crea ni borra proyectos |
| **PO** | Solo el % de entrega y el % de avance de QA de sus proyectos | Deja comentarios (hilo por proyecto) y reporta fallas en Ambientes. No edita nada más |
| **Ambientes** | Solo la pestaña Ambientes (**QA**) | Marca el estado de los ambientes de QA y ve su histórico. No ve proyectos ni DEV |
| **Ambientes DEV** | Solo la pestaña Ambientes (**DEV**) | Lo mismo que «Ambientes», pero solo para los ambientes de DEV. No ve proyectos ni QA |

* Al **cargar un proyecto** el administrador debe elegir el **PMO líder**, el **analista QA** (quien lo aprueba y prueba) y el **PO**. Se puede cambiar después en el panel «Asignación» del detalle del proyecto.
* **Los proyectos que ya existían no tienen asignación**: solo el administrador y la PMO los ven hasta que los asignes (abre cada proyecto → «Asignación» → Guardar).
* Crea primero los usuarios (los 5 PMO líderes, los 4 analistas, los PO y la PMO) con su perfil; si no existe al menos uno de cada perfil, no se pueden cargar proyectos nuevos.
* Todo se valida en el servidor, no solo en la pantalla: aunque alguien manipule el navegador, su perfil no puede leer ni escribir lo que no le corresponde.
* Si cambias el perfil de alguien, su sesión se actualiza sola en el siguiente movimiento.

## 6e. Bitácora del equipo, casos ejecutados y meta de 12

**Quién aparece.** Cada usuario con perfil *Analista QA* tiene su ficha en la bitácora desde que se crea (Administración → Crear usuario). Si ya existía una ficha de la bitácora sin usuario, al crear el usuario puedes elegirla en «Vincular con analista ya registrado» y se conserva todo su historial. En Administración puedes **editar el nombre** y **eliminar** a cada usuario. Eliminar no es posible si está asignado a proyectos (se te indica cuáles; reasígnalos o desactívalo). Al eliminar un usuario su bitácora se conserva como ficha sin usuario, que el administrador puede renombrar o eliminar desde la pestaña Bitácora (eliminar la ficha borra también sus horas).

**Vistas.** Administrador y PMO ven la *Bitácora del equipo* (día / semana / mes): una fila por analista con proyecto en pruebas, casos ejecutados, cumplimiento de la meta, horas probando/bloqueado, bugs y días con registro, más el total del equipo y un resumen en texto. Al hacer clic en el nombre se abre la vista solo de ese analista (día, semana y mes), su calendario y sus **proyectos** agrupados en *En pruebas*, *Próximos a probar* y *Cerrados*; en cada proyecto en pruebas se ven los casos ejecutados por día. El analista solo ve y edita su propia bitácora; PMO y PO son de solo lectura.

**Casos ejecutados.** Salen de Azure Test Plans del proyecto en pruebas (el proyecto debe tener su plan vinculado, ver 6c). Cada caso se cuenta para quien lo ejecutó en Azure (se compara el nombre o usuario de Azure con el del analista; si no hay coincidencia se atribuye al analista asignado al proyecto). Cuentan los exitosos, fallidos y bloqueados. Limitación de Azure: de cada caso solo se conserva la **última** ejecución; si se reejecuta otro día, ese caso pasa al día más reciente.

**Meta.** 12 casos mínimo por día hábil (se excluyen fines de semana y festivos de Colombia) para cada analista que ese día tenga un proyecto en pruebas **con plan de Azure vinculado** (recibido, ya iniciado, sin cerrar ni congelar). Estados: cumple, incumple, en curso (hoy), sin plan de Azure, sin proyecto y día libre. El día de hoy no cuenta como incumplido hasta que termine.

## 6f. Integración con otros aplicativos (Fluxor): llaves de acceso

Para que **Fluxor** (u otro aplicativo) lea los porcentajes de los proyectos sin usuario ni contraseña, entra a **Administración → Integraciones → Crear llave**, ponle un nombre (por ejemplo, Fluxor) y copia la llave: **solo se muestra una vez** (en la base solo se guarda su huella, no la llave). Guárdala en las variables de entorno del servidor de Fluxor, nunca en el navegador ni en el código. Si se pierde o se filtra, **Revocar** la deja sin efecto al instante y creas otra. Puedes ver cuándo la usó por última vez y cuántas consultas hizo.

La llave es **solo lectura** y **solo sirve para estos dos endpoints** (no abre ninguna otra parte de QUQI y no da acceso a comentarios, usuarios, bitácora ni bugs):

- `GET /api/integracion/proyectos` → todos los proyectos (abiertos y cerrados). Filtros opcionales: `?estado=abiertos|cerrados|en_pruebas|proximo|backlog` y `?nombre=texto`.
- `GET /api/integracion/proyectos/{id}` → un proyecto.

Se envía la llave en la cabecera `Authorization: Bearer <llave>` (o `X-API-Key`). Cada proyecto trae `id`, `nombre`, `estado` (`backlog`, `proximo`, `en_pruebas`, `cerrado`), `pctEntrega`, `pctQaCertificado`, `pctProbado`, `pctExito`, `casos` (total, aplicables, exitosos, fallidos, bloqueados, pausados, pendientes), `fuentePruebas` (`azure` o `manual`) y las fechas de actualización. Los porcentajes van de 0 a 100 con un decimal y son **los mismos que se ven en la pantalla**; si el proyecto aún no tiene avance de pruebas, `pctQaCertificado`, `pctProbado` y `pctExito` vienen en `null`. Límite: 120 consultas por minuto por llave; una llave inválida responde 401 y varios intentos fallidos seguidos bloquean la IP por 15 minutos. Hay una guía lista para el equipo de Fluxor en `GUIA_INTEGRACION_FLUXOR.md`.

## 6g. Cambiar nombre, límite de 2 proyectos, apoyo a otros proyectos y casos creados

**Cambiar el nombre de un proyecto.** El administrador y el analista asignado al proyecto pueden cambiarlo con el botón «✎ Cambiar nombre» junto al título del proyecto. El nuevo nombre se refleja de inmediato en la lista, el tablero, la bitácora, los PDF y en la integración con Fluxor (el `id` no cambia). PMO y PO no pueden renombrar.

**Límite de 2 proyectos abiertos por analista.** Un analista no puede tener más de **2 proyectos abiertos a la vez** (recibidos y sin cerrar; no depende de fechas). Se valida en el servidor al **asignar** el analista, al **recibir** un proyecto que estaba en backlog y al **reabrir** uno cerrado; el mensaje indica qué proyectos ya tiene. En el selector de analista se ve cuántos lleva cada uno (por ejemplo, «Ana · 1/2 en curso»). Un proyecto en backlog (aún sin recibir) se puede asignar, pero cuenta cuando se recibe. La versión del artifact (sin usuarios ni servidor) no aplica este límite.

**Apoyo a otros proyectos.** Si un analista ejecuta casos en un proyecto que no tiene asignado, la bitácora lo muestra como **Apoyo** y no se pierde: se detecta desde Azure Test Plans (por el nombre o usuario de Azure de quien ejecutó) y aparece en los casos ejecutados del día, en la fila del equipo (columna *Apoyo*) y en el resumen. Además el analista puede **registrar las horas** que ayudó (proyecto, horas, nota) en su día; se suman al total de apoyo. El analista solo ve la actividad de apoyo propia, no el documento completo del proyecto ajeno. La lista de proyectos para apoyar la entrega `GET /api/proyectos-apoyo` (solo administrador y analistas).

**Casos de prueba creados o cargados.** Por analista y proyecto (asignado o de apoyo), por día. Solo sale de **Azure**: se cuentan los *Test Case* del plan según quién los creó (nombre de Azure igual al del analista) y su fecha de creación. Requisitos: la llave de Azure (PAT) debe tener **Work Items: Read** además de **Test Management: Read**, y el nombre del analista en QUQI debe coincidir con su nombre en Azure. Si un autor no coincide con ningún analista, esos casos no se atribuyen a nadie. Se revisan hasta 3000 casos nuevos por sincronización.

## 6h. Descarga de archivos, bitácora sin almuerzo, cita médica y proyectos congelados

- **Descarga de archivos:** el requerimiento y los diseños de Figma que se suben como archivo (por ejemplo un HTML) ahora se **guardan** y se pueden **descargar con el botón «⬇ Descargar»** desde el proyecto. Lo ven y lo descargan todos los perfiles (administrador, analista, PMO, PMO líder y PO; el PO lo tiene en la tarjeta de su proyecto). Solo el administrador y el analista asignado pueden subir, reemplazar o quitar. Tope: 8 MB por archivo. Los archivos de proyectos anteriores a esta versión no quedaron guardados: se pueden volver a subir desde el panel «Requerimiento» o desde Figma.
- **Dónde se guardan:** colecciones `archivos` (datos del archivo) y `archivos_data` (contenido en trozos de base64, porque la base no admite documentos grandes). El contenido no se envía por el canal en vivo, no se lista y **no entra en el respaldo JSON** (el respaldo de Neon sí los incluye); al borrar un proyecto se borran sus archivos.
- **Bitácora por horas:** se quitó el almuerzo (12:30 – 2:00 pm). Los bloques son 7–8, 8–9, 9–10, 10–11, **11 am – 12:30 pm** (cuenta 1,5 h) y luego 2–3, 3–4, 4–5 y 5–6 pm. Los registros de días anteriores con horas 12–1 y 1–2 se conservan y se siguen mostrando como «(anterior)».
- **Cita médica:** nuevo estado de cada hora. Solo se registra: cuenta como hora registrada de la jornada y aparece en las fichas, la semana, el mes y el equipo, pero **no cambia la meta de 12 casos**.
- **Proyecto congelado:** un proyecto congelado por la prioridad de otro **sigue visible** en la bandeja y en la bitácora del analista con la marca ❄; no se cuenta entre los 12 casos de la meta mientras esté congelado.
- **Rol analista QA:** ya no ve la pestaña «Azure y ANS» (sigue en administrador, PMO y PMO líder).

## 6i. Ambientes QA sin Excel: perfil «Ambientes», Issues y correos automáticos

- **Qué cambió:** ya no hace falta subir el Excel. Cada servicio es una fila en la pestaña **Ambientes**; quien tenga permiso cambia el estado (**SI**, **NO**, **OCASIONALMENTE**, **MUY INTERMITENTE**) y el aplicativo hace lo mismo que el script de Google Sheets: guarda la fecha y el historial, y registra el incidente en el **Histórico**.
  - **SI:** crea el **Issue en Azure DevOps** (mismo título, área, iteración, etiqueta, flujo funcional y responsable por hoja) y envía el **correo de incidente** con el número del Issue.
  - **NO / OCASIONALMENTE / MUY INTERMITENTE** sobre una fila que estaba en SI: **cierra el Issue** (estado «Cerrado») y envía el **correo de cierre**.
  - **Recordatorios:** el servidor envía solo el recordatorio cada 24 h (configurable) mientras el incidente siga abierto. Los incidentes que ya estaban abiertos al activar el envío automático cuentan desde ese momento, para no mandar de golpe todos los recordatorios atrasados.
  - Si Azure o el correo fallan, el cambio de estado **sí se guarda**; el incidente muestra ⚠ y un botón **Reintentar** (no duplica lo que ya salió bien).
- **Perfil nuevo «Ambientes»:** se crea en Administración. Ve **solo** la pestaña Ambientes: marca estados, ve incidentes, histórico (y lo exporta). No ve proyectos, no entra a Configuración ni carga Excel. El PO y el analista también pueden marcar; el PMO solo mira.
- **Catálogo sin Excel (administrador):** en cada hoja, **＋ Agregar fila**, ✎ editar y 🗑 quitar (no deja quitar una fila con falla abierta). El Excel solo sirve para la primera carga (Configuración → «Reemplazar con otro Excel»).
- **Variables en Render (todas secretas):**

| Variable | Para qué |
|---|---|
| `AZURE_DEVOPS_PAT_WRITE` | Llave de Azure con **Work Items → Read & Write** para crear/cerrar Issues. Si no existe se usa `AZURE_DEVOPS_PAT` (solo lectura: no alcanza). |
| `AZURE_DEVOPS_ORG` | Organización (si falta, la de Ambientes → Configuración: `BancoFinandina`). |
| `AMB_MAIL_SECRET` (+ `AMB_MAIL_URL` solo en modo directo) | Servicio de correo, **dos modos**. **Modo cola (recomendado si tu Workspace no deja publicar para «Cualquier persona»):** deja `AMB_MAIL_URL` **vacía**, pon solo `AMB_MAIL_SECRET` y usa `apps_script_correo_cola.gs` (instrucciones al inicio del archivo): el aplicativo deja los correos en una cola y tu script los recoge cada minuto con un activador y los envía desde tu cuenta. **Modo directo:** publica `apps_script_correo.gs` con acceso «Cualquier persona» y pon aquí su URL `/exec`. |
| `AMB_REMINDERS=off` | (Opcional) apaga los recordatorios automáticos. `AMB_REMINDER_MINUTES` (10) = cada cuánto se revisan. |

- **Sin configurar:** si falta alguna variable, el cambio de estado igual funciona y la pantalla muestra «Hacerlo a mano» (copiar datos del Issue y correo), como antes. Ambientes → Configuración muestra qué está activo.
- **Borrar del histórico:** solo el administrador (el servidor lo rechaza para los demás perfiles). En Ambientes → Histórico aparecen casillas, «Seleccionar solucionados» y «Borrar seleccionados» con confirmación; un incidente se borra completo (falla + cierre), los incidentes abiertos no se pueden borrar y los Issues de Azure no se tocan. Conviene descargar antes el Excel del histórico.
- **Pantalla ancha:** la vista de Ambientes usa todo el ancho de la ventana y muestra completos los textos largos.
- **Modo cola:** el aviso del Issue sale al instante, el correo en máximo ~1 minuto. En Ambientes → Configuración (administrador) se ve «Correo: activo (por cola)» y, si el script de Google dejó de consultar o hay correos atrasados, un aviso en rojo. Los correos pendientes se descartan a los 7 días. Si el activador se apaga, los correos quedan guardados y salen cuando vuelva a funcionar. Apaga el script/activador antiguo de la hoja de Google Sheets para no duplicar correos.
- **Si el correo no sale:** en Ambientes → Configuración (administrador) escribe tu correo y pulsa **Enviar correo de prueba**: la pantalla (y el log de Render) dicen la causa. Las más comunes: `AMB_MAIL_URL` con solo el ID (AKfycb…) en vez de la URL completa (desde esta versión el ID solo también se acepta); la implementación del Apps Script no tiene acceso «Cualquier persona» (Google responde con una página de inicio de sesión; si tu Workspace no lo ofrece, usa el modo cola); `AMB_MAIL_URL` no es la URL que termina en `/exec`; `AMB_MAIL_SECRET` no coincide con la propiedad del script; o falta ejecutar `autorizar` en el editor. Tras cambiar el código del script hay que publicar una **nueva versión** de la implementación. El Issue y el estado ya quedan guardados; con «Reintentar» solo se reenvía el correo.
- **Importante:** (1) cualquier llave pegada en un chat, correo o script compartido debe **revocarse** y crearse otra; las llaves viven solo en Render. (2) Mientras el Excel de Google siga con su disparador activo se enviarían **correos dobles**: apágalo cuando empieces a usar el aplicativo. (3) El correo se envía solo a direcciones `@bancofinandina.com`. (4) Cuota de Google: ~1.500 destinatarios/día en Workspace (cada correo cuenta por destinatario).

## 6j. Cargue de proyectos en QA (Agente QA integrado)

Pestaña **«Cargue de proyectos en QA»**, solo para el **administrador** (el servidor rechaza a los demás perfiles). Reemplaza la app de Streamlit del Agente QA: lee los requerimientos, detecta las Historias de Usuario, la IA diseña los casos de prueba y se publica todo en Azure DevOps.

**Variables nuevas en Render → Environment** (todas secretas; las mismas del Agente QA):

| Variable | Para qué |
|---|---|
| `AZURE_DEVOPS_PAT_WRITE` | Ya existe (Ambientes). Ahora además necesita **Test Management → Read & Write** para crear el Test Plan y sus suites. |
| `CARGUE_AZURE_PROJECT` | Proyecto de Azure donde se crea todo (por defecto `Gestion Proyectos`; **no** usa `AZURE_DEVOPS_PROJECT`, que es el de los bugs y puede ser otro). La organización sale de `AZURE_DEVOPS_ORG`. Opcionales: `QA_AREA_PATH` (`Gestion Proyectos\QA`), `QA_ITERATION_PATH` (`Gestion Proyectos\Backlog`), `QA_TEST_CASE_STATE`. |
| `GEMINI_API_KEY` (+ `GEMINI_MODEL`) | Ya existe. `GEMINI_MODEL` admite varios modelos separados por coma (`principal,respaldo`): si el primero se satura o Google ya no lo ofrece (404 «no longer available»), pasa al siguiente; al final siempre prueba `gemini-3.8-flash`. Recomendado: `GEMINI_MODEL=gemini-3.8-flash`. |
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REFRESH_TOKEN` | Lectura de Drive. Se generan **una vez** con `setup_google_auth.py` del Agente QA (corre en tu computador). Sin ellas el módulo sigue sirviendo con **Subir archivo**. |
| `DRIVE_ROOT_FOLDER_ID` | ID de la carpeta «Unidad QA / Requerimientos / 2026 / QA» (se ve en la URL de Drive); también se puede escribir en la pantalla. |

**Cómo se usa**
1. **Proyectos en Drive:** «Refrescar lista» muestra las subcarpetas (cada una es un proyecto). En cada una, «Extraer y previsualizar HU» lee el archivo de requerimientos (prioridad `.xlsx` > `.md` > `.txt` > `.pdf` > `.pptx`; busca primero en una subcarpeta «requerimiento…») y muestra las HU detectadas y el estado en Azure.
2. **Subir archivo:** para un proyecto que no está en Drive, escribe su nombre y sube el archivo (`.xlsx`, `.md`, `.txt`, `.pdf`, `.pptx`; máx. 10 MB). El `.xls` antiguo hay que guardarlo como `.xlsx`.
3. Si el proyecto **no existe** en Azure: «Generar en Azure DevOps» crea el Feature, las User Stories, el Test Plan (una suite por requisito) y los casos de prueba. Si ya existen el Feature **y** el Test Plan: solo «Generar solo casos de prueba» (las User Stories que ya tienen casos se omiten). Si existe el Feature pero no el Test Plan: se bloquea para no duplicar a medias.
4. Antes de escribir en Azure pide **confirmación**. El proceso corre en segundo plano con un registro que se actualiza solo; todo queda en el **Historial** (últimos 60 procesos, con su registro).

**Notas:** PDF y PPTX primero se leen por reglas exactas (formato «HU n — título / Quiero / Para / Criterios», incluido el «Tech Spec» de Fluxor, donde «Yo como… Quiero… Para…» va en un mismo párrafo y los criterios son «Criterio n (id): …») y solo si no hay HU en ese formato se le pide a la IA; un PDF escaneado (imagen) no tiene texto y no se puede leer sin OCR. El texto de los requerimientos sale hacia Gemini para generar los casos. Si el servidor se reinicia a mitad de un cargue, queda «Interrumpido» en el historial; al repetirlo no se duplica lo ya creado (detecta el Feature y el Test Plan). En la versión de Claude (sin servidor) el módulo no aparece.

## 6k. Mejoras: Ambientes QA / DEV, descripción del error, enlaces al Issue, bugs en la Bitácora, varias consultas de Azure y buscador

1. **Buscador dentro del proyecto.** En el detalle de un proyecto hay una caja «Buscar una palabra dentro del proyecto». Filtra las historias de usuario (código, descripción y criterios), **resalta** la palabra en todo el detalle (HU, seguimiento, bugs de Azure, comentarios…), abre lo que la contiene y dice cuántas coincidencias hay por sección. Ignora mayúsculas y tildes; ▲ ▼ saltan entre coincidencias.
2. **Descripción del error (obligatoria).** Al marcar una fila en **SI** (cualquier perfil de Ambientes: administrador, analista, PO, Ambientes y Ambientes DEV) aparece un cuadro «Describe el error» (mínimo 5 caracteres). **Esa descripción es la que se escribe en el campo Descripción del Issue de Azure DevOps** y va también en el correo y en el Histórico. Sin descripción el servidor rechaza el cambio (no crea Issue ni correo).
3. **Issue como enlace directo.** En el incidente abierto, el aviso de cierre y el Histórico, el número del Issue es un enlace al work item en Azure DevOps (organización y proyecto salen de Ambientes → Configuración). Los correos también traen el enlace.
4. **Bitácora: bugs con proyecto y enlace.** En «+ Bug» el analista anota el número, los minutos, el **proyecto donde lo detectó** (sugiere sus proyectos; también acepta texto libre) y, si quiere, el **enlace** del bug (si no lo escribe y el proyecto tiene Azure sincronizado, se arma solo). Corrección incluida: en la versión web esos campos quedaban deshabilitados para el analista.
5. **Varias consultas de Azure por proyecto.** Los bugs de Banca y de App viven en proyectos de Azure distintos. En el panel «Azure DevOps · Bugs» el botón **＋ Agregar otra consulta** (hasta 4 adicionales) permite otro proyecto/área/iteración/etiqueta/padre. Los bugs se suman (sin duplicar), la tabla muestra la columna «Proyecto Azure» y cada bug enlaza a su propio proyecto. Cada consulta se puede editar o quitar.
6. **Ambientes QA y DEV.** Nuevo perfil **Ambientes DEV** (se crea en Administración). «Ambientes» ve solo QA, «Ambientes DEV» solo DEV y el **administrador ve las dos** en pestañas «Ambientes QA» / «Ambientes DEV». Los demás perfiles (analista, PO, PMO) ven solo QA.
   * **Crear DEV:** el administrador entra a la pestaña DEV y pulsa **Crear ambientes DEV desde QA**: copia cada hoja con «DEV» en el nombre («Servicios DEV»), todas las filas en NO, histórico vacío, y copia la configuración de QA (etiqueta del Issue «Ambiente DEV»). Se puede repetir sin pisar lo ya creado. Ajusta correos, responsables, Area/Iteration y flujo en Ambientes → ⚙ Configuración de DEV.
   * **Correos:** el asunto lleva **[QA]** o **[DEV]** y el cuerpo dice «ambiente de QA/DEV» y «Tipo de ambiente». Los recordatorios y el histórico también van separados por ambiente.
   * Los datos de DEV se protegen en el servidor: ni «Ambientes» ni analista/PO/PMO pueden verlos ni escribirlos, y «Ambientes DEV» no toca QA.

## 7. Cosas que debes saber

- **Arranque en frío:** en el plan gratuito de Render el servicio se duerme tras un rato sin visitas; la primera carga después puede tardar cerca de un minuto. Neon también «duerme» la base y despierta sola en segundos. Después, todo va normal. Para evitar la espera puedes usar un monitor externo gratuito (p. ej. UptimeRobot) que visite `https://TU-URL/healthz` cada 5–10 min, o pasar a un plan de pago.
- **Límites gratuitos:** las cuotas de Render, Neon y Gemini cambian con el tiempo; revisa sus páginas de precios vigentes. Para este volumen (unas pocas personas, miles de registros) el uso esperado es muy bajo.
- **Seguridad incluida:** HTTPS (de Render), contraseñas cifradas con scrypt, sesión por cookie `HttpOnly` + `Secure` de 12 h, bloqueo temporal tras intentos fallidos, protección CSRF por origen, cabeceras de seguridad (CSP, HSTS, etc.), roles (administrador / analista), usuarios desactivables al instante. La llave de Gemini nunca llega al navegador.
- **Aprobación interna:** al ser una herramienta con datos del banco en servicios de terceros (Render, Neon, Google), conviene el visto bueno de Seguridad/TI antes de abrirla a todo el equipo.
- **Qué no hace (igual que dentro de Claude):** no envía correos ni crea issues en Azure DevOps por sí sola; redacta los mensajes y tú los copias. El envío automático de recordatorios requeriría una integración adicional. La lectura de bugs de Azure está en la sección 6b (solo lectura).
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
| El panel de Azure dice «rechazó la llave» / «no tiene permiso» | El PAT es inválido, venció o no tiene *Work Items → Read*: genera uno nuevo y actualiza `AZURE_DEVOPS_PAT` en Render. |
| El panel de Azure dice «no se encontró la organización o el proyecto» | Revisa `AZURE_DEVOPS_ORG` y el nombre exacto del proyecto de Azure. |
| «Sesión vencida» | La sesión dura 12 h; vuelve a ingresar. |

## 9. Desarrollo local

```bash
npm install
cp .env.example .env   # y edítalo (necesitas un Postgres, p. ej. una base gratuita de Neon)
export $(grep -v '^#' .env | xargs) && npm start   # http://localhost:3000
```

Estructura: `server.js` (API, login, SSE) · `lib/` (base de datos, autenticación, IA, almacenamiento) · `public/app.html` (el tablero) · `public/shim.js` (conecta el tablero con el servidor) · `public/admin.html` · `public/login.html` · `public/vendor/` (librerías de Excel/PDF servidas desde el propio servidor, sin depender de CDN) · `scripts/` (respaldo e importación).
