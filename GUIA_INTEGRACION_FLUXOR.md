# Guía: leer los porcentajes de los proyectos desde QUQI_QA

Para el equipo que desarrolla **Fluxor**. QUQI_QA ofrece una API de **solo lectura** protegida con una llave.

## Lo que necesitan
- La **URL base** de QUQI_QA (por ejemplo `https://quqi-qa.onrender.com`).
- Una **llave de acceso**, que entrega el administrador de QUQI_QA (Administración → Integraciones). Guárdenla como variable de entorno del **servidor** de Fluxor (por ejemplo `QUQI_API_KEY`); nunca la pongan en el navegador, en el código ni en un repositorio.

## Endpoints
| Método | Ruta | Qué devuelve |
|---|---|---|
| GET | `/api/integracion/proyectos` | Todos los proyectos (abiertos y cerrados) |
| GET | `/api/integracion/proyectos?estado=abiertos` | Solo abiertos. Valores: `abiertos`, `cerrados`, `en_pruebas`, `proximo`, `backlog` |
| GET | `/api/integracion/proyectos?nombre=texto` | Proyectos cuyo nombre contiene el texto (sin distinguir mayúsculas ni tildes) |
| GET | `/api/integracion/proyectos/{id}` | Un proyecto |
| GET | `/api/integracion/proyectos/{id}/detalle` | Bugs de Azure vinculados, seguimiento QA (novedades) y cambios de alcance |
| GET | `/api/integracion/ambientes?amb=qa\|dev\|todos&meses=6` | Estadísticas de fallas de Ambientes QA/DEV (abiertas ahora, por día/semana/mes, por grupo y servicio, MTTR, recurrentes e histórico) |

Cabecera obligatoria: `Authorization: Bearer <llave>` (también se acepta `X-API-Key: <llave>`). La llave **no** se acepta en la URL.

## Ejemplo de respuesta
```json
{
  "generadoEn": "2026-11-04T21:40:12.000Z",
  "total": 1,
  "proyectos": [{
    "id": "e0x3kckhkyrtwz532ign",
    "nombre": "036. Eco-Nómina",
    "estado": "en_pruebas",
    "estadoEtiqueta": "En seguimiento",
    "cerrado": false,
    "recibidoEn": "2026-10-20",
    "inicioPruebas": "2026-10-21",
    "pctEntrega": 60,
    "pctQaCertificado": 50,
    "pctProbado": 60,
    "pctExito": 83.3,
    "casos": { "total": 100, "noAplicables": 10, "aplicables": 90, "exitosos": 45, "fallidos": 9, "bloqueados": 3, "pausados": 2, "pendientes": 31 },
    "fuentePruebas": "azure",
    "pruebasActualizadoEn": "2026-11-04T21:35:00.000Z",
    "actualizadoEn": "2026-11-04T21:35:01.000Z"
  }]
}
```

## Qué significa cada porcentaje (0 a 100, un decimal)
- **pctEntrega**: cuánto del desarrollo ya fue recibido por QA (historias y criterios recibidos, ponderado por peso).
- **pctQaCertificado**: casos exitosos / casos aplicables (total menos no aplicables).
- **pctProbado**: (exitosos + fallidos) / casos aplicables.
- **pctExito**: exitosos / (exitosos + fallidos).
- Si el proyecto aún no tiene avance de pruebas, `pctQaCertificado`, `pctProbado`, `pctExito` y `casos` vienen en `null`.
- `fuentePruebas` = `azure` cuando el proyecto tiene un plan de Azure Test Plans vinculado (se actualiza solo cada pocos minutos); `manual` cuando QA registró los conteos a mano.

## Campos adicionales en cada proyecto
- **tiempoPruebas**: `diasUsados` (días hábiles de pruebas **sin contar** los días congelados por la prioridad de otro proyecto), `diasPlan`, `diasCongelados`, `congeladoAhora`, `periodosCongelado`, `diasSobrePlan`, `diasRestantes`, `iniciado`.
- **bugs**: `vinculado` (si el proyecto tiene configurada la consulta de bugs de Azure), `total`, `abiertos`.
- **planPruebasUrl**: enlace al plan de pruebas de Azure Test Plans vinculado (o `null`).

## Detalle (`/api/integracion/proyectos/{id}/detalle`)
```json
{
  "id": "e0x3...", "nombre": "036. Eco-Nómina",
  "bugs": { "vinculado": true, "total": 2, "abiertos": 1, "sincronizadoEn": "...", "error": null,
            "lista": [{ "id": "901", "titulo": "...", "severidad": "2 - High", "prioridad": "2", "estado": "Active", "creado": "...", "resuelto": null, "cerrado": null, "abierto": true, "url": "https://dev.azure.com/.../_workitems/edit/901" }] },
  "seguimiento": [{ "id": "...", "tipo": "stopper", "tipoEtiqueta": "Bug stopper / bloqueante", "fecha": "2026-11-05", "hu": null, "detalle": "Bug stopper #901", "texto": "...", "estado": "Abierto", "autor": "Ana", "registradoEn": "...", "despuesDeCertificar": false }],
  "alcance": [{ "tipo": "hu_nueva", "detalle": "Se agregó la HU HU-3 (peso 20%, 2 criterios)", "...": "..." }],
  "planPruebasUrl": "https://dev.azure.com/.../_testPlans/define?planId=77",
  "tiempoPruebas": { "diasUsados": 3, "diasPlan": 4, "diasCongelados": 2, "...": "..." }
}
```
- **seguimiento**: todas las novedades (stopper, congelado, reanudado, bloqueado por ambiente, comentario, nota, certificado QA), más recientes primero.
- **alcance**: solo cambios de alcance (HU nueva, criterio nuevo o actualizado, desistido, no aplicable, reactivado).

## Ambientes (`/api/integracion/ambientes`)
- `amb`: `qa`, `dev` o `todos` (por defecto `todos`). `meses`: 1 a 24 (por defecto 6), ventana del histórico.
- `resumen`: `fallas` (en la ventana), `abiertasAhora`, `solucionadas`, `mttrHoras` (promedio de horas hasta la solución), `horasBloqueo`, `diasBloqueo` (horas ÷ 24), `hoy`, `semana`, `mes`, `recurrentes`.
- `abiertasAhora[]`: servicio, grupo, ambiente, error, inicio, horas abierta, issue y `vencido` (más de 24 h).
- `porDia[]` (30 días), `porSemana[]` (12 semanas ISO), `porMes[]` (ventana): fallas, solucionadas, horas de bloqueo y MTTR.
- `porGrupo[]`, `porServicio[]` y `recurrentes[]` (servicios con 2 o más fallas): ocurrencias, abiertas, solucionadas, horas, días de bloqueo, MTTR.
- `incidentes[]`: cada falla con inicio, fin, horas, días de bloqueo, estado (`Abierta`/`Solucionada`), semana, mes, issue, quién reportó y quién cerró.

## Códigos de respuesta
`200` correcto · `401` llave inválida o revocada · `404` proyecto inexistente · `405` método no permitido (solo GET) · `429` demasiadas consultas (máximo 120 por minuto por llave) o demasiados intentos con llave inválida.

Recomendación: consulten cada 5 a 15 minutos y guarden el último resultado; los datos de Azure se refrescan en QUQI cada pocos minutos, así que consultar más seguido no aporta nada.

## Ejemplos
**curl**
```bash
curl -H "Authorization: Bearer $QUQI_API_KEY" "$QUQI_URL/api/integracion/proyectos?estado=abiertos"
```

**Node.js (18+)**
```js
const r = await fetch(`${process.env.QUQI_URL}/api/integracion/proyectos`, {
  headers: { Authorization: `Bearer ${process.env.QUQI_API_KEY}` }
});
if (!r.ok) throw new Error(`QUQI respondió ${r.status}`);
const { proyectos } = await r.json();
```

**Python**
```python
import os, requests
r = requests.get(os.environ["QUQI_URL"] + "/api/integracion/proyectos",
                 headers={"Authorization": "Bearer " + os.environ["QUQI_API_KEY"]}, timeout=20)
r.raise_for_status()
proyectos = r.json()["proyectos"]
```

**Java 11+**
```java
HttpRequest req = HttpRequest.newBuilder(URI.create(System.getenv("QUQI_URL") + "/api/integracion/proyectos"))
    .header("Authorization", "Bearer " + System.getenv("QUQI_API_KEY")).GET().build();
HttpResponse<String> res = HttpClient.newHttpClient().send(req, HttpResponse.BodyHandlers.ofString());
```
