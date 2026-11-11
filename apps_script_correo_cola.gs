/* QUQI_QA · Correo de Ambientes en «modo cola»
   Úsalo cuando tu Google Workspace NO permite publicar el script para «Cualquier persona».
   El aplicativo (Render) deja los correos en una cola; este script, que corre en TU cuenta, la consulta cada minuto
   y envía los correos con MailApp (desde tu cuenta @bancofinandina.com). No hace falta publicar ninguna aplicación web.

   PUESTA EN MARCHA (una sola vez)
   1. https://script.google.com → «Nuevo proyecto» → pega TODO este archivo (reemplaza lo que haya).
   2. Engranaje «Configuración del proyecto» → «Propiedades de la secuencia de comandos» → agrega DOS propiedades:
        RENDER_URL       = https://quqi-qa.onrender.com        (la dirección de tu aplicativo, sin / al final)
        AMB_MAIL_SECRET  = la MISMA clave que tiene AMB_MAIL_SECRET en Render → Environment
      (La clave no va en el código.)
   3. En Render → Environment: deja  AMB_MAIL_URL  VACÍA (bórrala) y conserva AMB_MAIL_SECRET. Guarda y espera el redespliegue.
   4. En el editor elige la función  autorizar  → «Ejecutar» → acepta los permisos (enviar correo y conectarse a un servicio externo).
   5. Elige la función  crearActivador  → «Ejecutar». Crea un activador que ejecuta  procesarCola  cada minuto.
      (También puedes hacerlo a mano: reloj ⏰ «Activadores» → «Añadir activador» → procesarCola → «Controlado por tiempo» → «Temporizador de minutos» → «Cada minuto».)
   6. Ejecuta  probarConexion : debe decir «Conexión correcta» en el registro de ejecución.
   7. En QUQI_QA → Ambientes QA → «Enviar correo de prueba»: en máximo 1 minuto llega el correo.

   IMPORTANTE: si antes tenías el script de la hoja de Google Sheets con su activador, apágalo para que no salgan correos dobles. */

var MAX_POR_VUELTA = 10;

function procesarCola() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;            // ya hay otra ejecución en curso
  try {
    var cfg = config_();
    var r = llamar_(cfg, '/api/ambientes-cola/pendientes', {});
    var mensajes = (r && r.mensajes) || [];
    if (!mensajes.length) return;

    var yaEnviados = leerEnviados_();
    var confirmar = [];
    for (var i = 0; i < mensajes.length && i < MAX_POR_VUELTA; i++) {
      var m = mensajes[i];
      if (yaEnviados.indexOf(m.id) >= 0) { confirmar.push(m.id); continue; }   // ya salió (falló la confirmación la vez anterior)
      var verdict = enviar_(m);
      if (verdict === 'ok') { yaEnviados.push(m.id); confirmar.push(m.id); }
      else if (verdict === 'descartar') { confirmar.push(m.id); }              // mensaje inválido: no tiene sentido reintentar
      else break;                                                              // error temporal (p. ej. cuota): se reintenta en la próxima vuelta
    }
    guardarEnviados_(yaEnviados);
    if (confirmar.length) llamar_(cfg, '/api/ambientes-cola/confirmar', { ids: confirmar });
  } catch (err) {
    console.error('procesarCola: ' + err);
  } finally {
    lock.releaseLock();
  }
}

function enviar_(m) {
  var para = String(m.to || '').split(/[;,]/).map(function (s) { return s.trim(); }).filter(Boolean);
  // Solo direcciones del banco, por seguridad.
  if (!para.length || para.length > 50 || para.some(function (x) { return !/^[^@\s]+@bancofinandina\.com$/i.test(x); })) {
    console.error('Mensaje descartado (destinatario no permitido): ' + m.id);
    return 'descartar';
  }
  if (!m.subject || !(m.body || m.htmlBody)) return 'descartar';
  try {
    var o = { to: para.join(','), subject: String(m.subject).slice(0, 250), body: String(m.body || '') };
    if (m.htmlBody) o.htmlBody = String(m.htmlBody);
    MailApp.sendEmail(o);
    return 'ok';
  } catch (err) {
    console.error('No se pudo enviar ' + m.id + ': ' + err);
    return 'reintentar';
  }
}

function llamar_(cfg, ruta, cuerpo) {
  var resp = UrlFetchApp.fetch(cfg.url + ruta, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + cfg.secret },
    payload: JSON.stringify(cuerpo || {}),
    muteHttpExceptions: true,
    followRedirects: true
  });
  var code = resp.getResponseCode(), txt = resp.getContentText();
  if (code === 401) throw new Error('La clave AMB_MAIL_SECRET del script no coincide con la de Render.');
  if (code === 429) throw new Error('Render bloqueó temporalmente por claves inválidas; revisa AMB_MAIL_SECRET.');
  if (code !== 200) throw new Error('Render respondió ' + code + ': ' + txt.slice(0, 120));
  return JSON.parse(txt);
}

function config_() {
  var p = PropertiesService.getScriptProperties();
  var url = String(p.getProperty('RENDER_URL') || '').trim().replace(/\/+$/, '');
  var secret = p.getProperty('AMB_MAIL_SECRET');
  if (!/^https:\/\//.test(url)) throw new Error('Falta la propiedad RENDER_URL (por ejemplo https://quqi-qa.onrender.com).');
  if (!secret) throw new Error('Falta la propiedad AMB_MAIL_SECRET.');
  return { url: url, secret: secret };
}

// Evita duplicados si la confirmación a Render falla después de enviar el correo.
function leerEnviados_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty('ENVIADOS') || '[]'); } catch (e) { return []; }
}
function guardarEnviados_(lista) {
  PropertiesService.getScriptProperties().setProperty('ENVIADOS', JSON.stringify(lista.slice(-100)));
}

/* ---------- Se ejecutan a mano desde el editor ---------- */
function autorizar() {
  MailApp.getRemainingDailyQuota();
  UrlFetchApp.fetch('https://www.google.com', { muteHttpExceptions: true });
}
function crearActivador() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'procesarCola') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('procesarCola').timeBased().everyMinutes(1).create();
  console.log('Activador creado: procesarCola cada minuto.');
}
function probarConexion() {
  var r = llamar_(config_(), '/api/ambientes-cola/pendientes', {});
  console.log('Conexión correcta. Correos pendientes en la cola: ' + ((r && r.mensajes) || []).length);
}
