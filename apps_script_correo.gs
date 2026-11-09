/* QUQI_QA · Servicio de correo para Ambientes QA
   Recibe del aplicativo (Render) el asunto y el cuerpo y envía el correo desde TU cuenta de Google con MailApp,
   igual que el script que ya usabas en la hoja de Ambientes.

   PUESTA EN MARCHA (una sola vez)
   1. Entra a https://script.google.com con tu cuenta @bancofinandina.com → «Nuevo proyecto» → pega TODO este archivo.
   2. Engranaje «Configuración del proyecto» → «Propiedades de la secuencia de comandos» → «Agregar propiedad»:
        nombre:  AMB_MAIL_SECRET        valor: una clave larga que inventes (por ejemplo 40 letras y números al azar)
   3. En el editor elige la función  autorizar  y pulsa «Ejecutar»: Google te pide permiso para enviar correo (acepta).
      Luego ejecuta  probar : te llega un correo de prueba a ti.
   4. «Implementar» → «Nueva implementación» → tipo «Aplicación web»:
        Ejecutar como: Yo        ·        Quién tiene acceso: Cualquier persona
      Copia la «URL de la aplicación web» (termina en /exec).
   5. En Render → Environment agrega:
        AMB_MAIL_URL    = la URL /exec del paso 4
        AMB_MAIL_SECRET = la misma clave del paso 2
      (Guardar y esperar el redespliegue.)
   La clave NO va en el código: vive solo en las propiedades del script y en Render.
   Si cambias este código, usa «Implementar → Administrar implementaciones → Editar → Nueva versión» para que la URL siga igual. */

function doPost(e) {
  try {
    var secreto = PropertiesService.getScriptProperties().getProperty('AMB_MAIL_SECRET');
    var d = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (!secreto || d.secret !== secreto) return salida({ ok: false, error: 'Secreto inválido' });
    if (!d.to || !d.subject || !(d.body || d.htmlBody)) return salida({ ok: false, error: 'Faltan datos del correo' });

    // Solo se envía a direcciones del banco (protección por si alguien llegara a conocer la URL).
    var para = String(d.to).split(/[;,]/).map(function (s) { return s.trim(); }).filter(Boolean);
    if (!para.length || para.some(function (x) { return !/^[^@\s]+@bancofinandina\.com$/i.test(x); })) return salida({ ok: false, error: 'Destinatario no permitido' });
    if (para.length > 50) return salida({ ok: false, error: 'Demasiados destinatarios' });

    var opciones = { to: para.join(','), subject: String(d.subject).slice(0, 250), body: String(d.body || '') };
    if (d.htmlBody) opciones.htmlBody = String(d.htmlBody);
    MailApp.sendEmail(opciones);
    return salida({ ok: true });
  } catch (err) {
    return salida({ ok: false, error: String(err) });
  }
}

function doGet() { return salida({ ok: true, servicio: 'QUQI_QA correo' }); }

function salida(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

/* Se ejecutan a mano desde el editor */
function autorizar() { MailApp.getRemainingDailyQuota(); }
function probar() {
  var yo = Session.getActiveUser().getEmail();
  MailApp.sendEmail({ to: yo, subject: 'Prueba del servicio de correo de QUQI_QA', body: 'Si lees esto, el envío funciona.', htmlBody: '<b>Si lees esto, el envío funciona.</b>' });
}
